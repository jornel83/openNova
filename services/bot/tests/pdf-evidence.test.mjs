import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyPdfQuote,verifyPdfQuotes} from '../desktop/pdf-evidence.mjs';

// The same opening words on pages 1 and 3 deliberately require the right page.
function fixture(){
  const stream=(value,extra='')=>`<< ${extra} /Length ${value.length} >>\nstream\n${value}\nendstream`;
  const text=(a,b)=>stream(`BT /F1 12 Tf 20 90 Td (${a}) Tj 0 -18 Td (${b}) Tj ET`);
  const page=(id,resources)=>`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 160] /Contents ${id} 0 R /Resources << ${resources} >> >>`;
  const font='/Font << /F1 9 0 R >>';const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 3 /Kids [3 0 R 5 0 R 7 0 R] >>',
    page(4,font),text('Finding: Cedar','received 42 samples.'),page(6,'/XObject << /Scan 10 0 R >>'),stream('q 10 0 0 10 0 0 cm /Scan Do Q'),
    page(8,font),text('Finding: Cedar','received 24 samples.'),'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream('123','/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8')];
  let data='%PDF-1.4\n';const offsets=['0000000000 65535 f \n'];
  for(const [i,object] of objects.entries()){
    offsets.push(String(data.length).padStart(10,'0')+' 00000 n \n');data+=`${i+1} 0 obj\n${object}\nendobj\n`;
  }
  const start=data.length;return Buffer.from(data+`xref\n0 ${offsets.length}\n${offsets.join('')}trailer\n<< /Root 1 0 R /Size ${offsets.length} >>\nstartxref\n${start}\n%%EOF\n`);
}
const mac=process.platform==='darwin';
test('verifies the snapshot quotation on its physical page and returns original line breaks, never the proposal on failure',{skip:!mac},async()=>{
  const bytes=fixture(),quote='Cedar received 42 samples.';
  const checks=[{page:1,quote},{page:3,quote},{page:2,quote},{page:4,quote},{page:1,quote:'Finding: .*'},
    {page:1,quote:'Cedar received 42 Samples.'},{page:0,quote},{page:3,quote:'received 24 samples.'}];
  const pending=verifyPdfQuotes({bytes,items:checks});bytes.fill(0);
  const results=await pending;
  assert.deepEqual(results,[{verified:true,page:1,quote:'Cedar\nreceived 42 samples.'},
    {verified:false,page:3,reason:'pdf_quote_not_found'},{verified:false,page:2,reason:'pdf_no_text_layer'},
    {verified:false,page:4,reason:'pdf_page_range_out_of_bounds'},{verified:false,page:1,reason:'pdf_quote_not_found'},
    {verified:false,page:1,reason:'pdf_quote_not_found'},{verified:false,page:0,reason:'invalid_pdf_quote'},
    {verified:true,page:3,quote:'received 24 samples.'}]);
});
test('rejects bad, oversized and empty batches without leaking arbitrary input as evidence',async()=>{
  const good={page:1,quote:'quoted text'};
  assert.deepEqual(await verifyPdfQuotes({items:[]}),[]);
  await assert.rejects(verifyPdfQuotes({bytes:fixture(),items:Array(33).fill(good)}),/invalid_pdf_evidence_batch/);
  assert.deepEqual(await verifyPdfQuote({bytes:Buffer.from('not PDF'),...good}),{verified:false,page:1,reason:'pdf_unreadable'});
  assert.deepEqual(await verifyPdfQuote({bytes:fixture(),page:1,quote:'x'.repeat(1201)}),{verified:false,page:1,reason:'invalid_pdf_quote'});
  const big=Buffer.alloc(20*1024*1024+1);big.write('%PDF-1.7');assert.equal((await verifyPdfQuote({bytes:big,...good})).reason,'file_too_large');
});
test('cancellation propagates, timeout degrades, and neither leaves the snapshot on disk',{skip:!mac},async t=>{
  const previous=process.env.TMPDIR,dir=mkdtempSync(join(tmpdir(),'nova-evidence-test-'));process.env.TMPDIR=dir;
  t.after(()=>{if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;rmSync(dir,{recursive:true,force:true});});
  const input={page:1,quote:'Finding',bytes:fixture()},controller=new AbortController();
  const pending=verifyPdfQuote({...input,signal:controller.signal});controller.abort();
  await assert.rejects(pending,/cancelled/);assert.deepEqual(readdirSync(dir),[]);
  assert.equal((await verifyPdfQuote({...input,timeoutMs:1})).reason,'pdf_evidence_timeout');assert.deepEqual(readdirSync(dir),[]);
});
