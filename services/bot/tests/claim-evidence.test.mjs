import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,readFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Operations} from '../operations.mjs';
import {createFileReader} from '../desktop/file-reader.mjs';
import {createWorkContext} from '../desktop/context.mjs';
import {resolveClaimEvidence,normalizeEvidenceClaims} from '../documents/claim-evidence.mjs';
import {createSources} from '../research/sources.mjs';
import {execFileSync} from 'node:child_process';
import {MAX_NATIVE_FILE_BYTES} from '../desktop/file-types.mjs';

// Physical page one has a text layer; page two is a single image without one.
function pdf(label,unusedStreamBytes=0){
  const stream=(value,meta='')=>`<< ${meta} /Length ${value.length} >>\nstream\n${value}\nendstream`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 5 0 R /Resources << /Font << /F 6 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 7 0 R /Resources << /XObject << /Scan 8 0 R >> >> >>',
    stream(`BT /F 12 Tf 10 100 Td (${label}) Tj ET`),'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream('q 150 0 0 150 0 0 cm /Scan Do Q'),stream('123','/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8')];
  if(unusedStreamBytes)objects.push(stream('x'.repeat(unusedStreamBytes)));
  let data='%PDF-1.4\n';const offsets=['0000000000 65535 f \n'];
  for(const [i,object] of objects.entries()){offsets.push(String(data.length).padStart(10,'0')+' 00000 n \n');data+=`${i+1} 0 obj\n${object}\nendobj\n`;}
  const start=data.length;return Buffer.from(data+`xref\n0 ${offsets.length}\n${offsets.join('')}trailer\n<< /Root 1 0 R /Size ${offsets.length} >>\nstartxref\n${start}\n%%EOF\n`);
}
const claim=(...citations)=>[{kind:'fact',claim:'Comparison',citations}];
const hash=b=>createHash('sha256').update(b).digest('hex');
const ref=(readId,quote='Cedar',page=1)=>({readId,page,quote});
function fixture(t,readNative=async()=>({status:'partial',content:'MODEL-PROSE-IS-NOT-SOURCE',limitation:'Only selected contents.'})){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-claim-evidence-'))),workspace=join(home,'p'),path=join(workspace,'研究.pdf');
  const ops=new Operations({home,workspace}),context=createWorkContext({});
  const request={id:'r1',projectId:'A',binding:{projectId:'A',focus:'work',cwd:workspace,context:context.capture()}};
  const reader=createFileReader({home,ops,context,getRequest:()=>request,readNative});
  t.after(()=>{ops.close();rmSync(home,{recursive:true,force:true});});
  const read=async(id,file=path,scope={})=>{const r=await reader.read({path:file,question:'Compare material',...scope},{id});assert.equal(r.status,'completed');return r;};
  const resolve=(claims,projectId='A')=>resolveClaimEvidence({home,ops,claims,projectId});
  return {home,workspace,path,ops,reader,read,resolve};
}

test('a ranged read of a large PDF sends only the extracted pages and verifies citations against the original',{skip:process.platform!=='darwin'},async t=>{
  const attachments=[];
  const f=fixture(t,async({bytes})=>{
    attachments.push(bytes.length);
    return {status:'read',content:'Found the requested material.',limitation:null};
  });
  const source=pdf('Cedar received 42.',MAX_NATIVE_FILE_BYTES);
  writeFileSync(f.path,source);
  const whole=await f.reader.read({path:f.path,question:'Read everything'},{id:'whole'});
  assert.equal(whole.error,'file_too_large');assert.deepEqual(attachments,[]);
  const ranged=await f.read('ranged',f.path,{startPage:1,endPage:1});
  assert.equal(attachments.length,1);assert.ok(attachments[0]>0&&attachments[0]<MAX_NATIVE_FILE_BYTES);
  assert.equal(ranged.source.sha256,hash(source));assert.equal(ranged.source.size,source.length);
  assert.deepEqual(ranged.readScope,{mode:'pdf_pages',startPage:1,endPage:1,pageCount:2});
  rmSync(f.path);
  const [note]=await f.resolve(claim(ref(ranged.id,'Cedar received 42.'),ref(ranged.id,'Other page',2)));
  assert.equal(note.citations[0].verified,true);
  assert.equal(note.citations[1].reason,'page_outside_read_scope');
});

test('version-specific citations come from actual read snapshots after live replacement and deletion, not from model prose',{skip:process.platform!=='darwin'},async t=>{
  const f=fixture(t),old=pdf('Cedar received 42.'),fresh=pdf('Cedar received 24.');
  writeFileSync(f.path,old);const a=await f.read('old-version');
  writeFileSync(f.path,fresh);const b=await f.read('new-version');rmSync(f.path);
  const [result]=await f.resolve(claim(ref(a.id,'Cedar received 42.'),ref(b.id,'Cedar received 24.'),
    ref(b.id,'Cedar received 42.'),ref(a.id,'MODEL-PROSE-IS-NOT-SOURCE'),ref(a.id,'fabricated image quotation',2)));
  const [first,second]=result.citations;
  for(const [entry,row,bytes,q] of [[first,a,old,'Cedar received 42.'],[second,b,fresh,'Cedar received 24.']]){
    assert.equal(entry.verified,true);assert.equal(entry.quote,q);assert.equal(entry.fileName,'研究.pdf');assert.equal(entry.page,1);
    assert.equal(entry.sha256,hash(bytes));assert.equal(entry.sourceId,row.source.sourceId);assert.deepEqual(entry.version,row.source.version);
    assert.equal(entry.readStatus,'partial');assert.deepEqual(readFileSync(row.source.snapshotPath),bytes);
  }
  assert.notEqual(first.sourceId,second.sourceId);assert.deepEqual(result.citations.slice(2).map(c=>c.reason),['pdf_quote_not_found','pdf_quote_not_found','pdf_no_text_layer']);
  assert.ok(result.citations.slice(2).every(c=>c.verified===false&&!Object.hasOwn(c,'quote')));
});

test('completed original reads are required and foreign project identities cannot be mixed or inferred',async t=>{
  const f=fixture(t);writeFileSync(f.path,pdf('Cedar'));const row=await f.read('actual');
  for(const [id,patch] of [['other-project',{projectId:'B'}],['foreign-source',{source:{...row.source,projectId:'B'}}],
    ['wrong-operation',{operation:'document_open'}],['failed',{status:'failed'}],['unread',{readStatus:'unreadable'}],
    ['live-origin',{source:{...row.source,contentOrigin:'live'}}]])f.ops.put({...row,id,...patch});
  for(const id of ['other-project','foreign-source','wrong-operation','failed','unread','live-origin','missing',row.source.sourceId]){
    await assert.rejects(f.resolve(claim(ref(id))),{message:'unknown_evidence_read'});
  }
  await assert.rejects(f.resolve(claim(ref(row.id)),'B'),{message:'unknown_evidence_read'});
  for(const extra of [{verified:true},{sourceId:row.source.sourceId},{sha256:row.source.sha256},{reason:null}]){
    assert.throws(()=>normalizeEvidenceClaims(claim({...ref(row.id),...extra})),/invalid_evidence_citation/);
  }
});

test('an unreached physical page and a non-PDF never receive a verified excerpt',async t=>{
  const f=fixture(t);writeFileSync(f.path,pdf('Cedar'));const row=await f.read('original');
  // A durable partial-recovery receipt represents only the attempted physical page.
  f.ops.put({...row,id:'only-page-2',readScope:{mode:'pdf_pages',startPage:2,endPage:2,pageCount:2}});
  const png=Buffer.alloc(24);png.set([137,80,78,71,13,10,26,10]);png.write('IHDR',12);png.writeUInt32BE(1,16);png.writeUInt32BE(1,20);
  const path=join(f.workspace,'view.png');writeFileSync(path,png);const image=await f.read('image',path);
  const [result]=await f.resolve(claim(ref('only-page-2','Cedar'),ref(image.id,'Fake image text')));
  assert.deepEqual(result.citations.map(x=>x.reason),['page_outside_read_scope','unsupported_evidence_locator']);
  assert.ok(result.citations.every(x=>x.verified===false&&!Object.hasOwn(x,'quote')));
});

test('absent, replaced, symbolic or out-of-cache snapshot cannot supply a quote, even if the live file still agrees',async t=>{
  const f=fixture(t),bytes=pdf('Cedar');writeFileSync(f.path,bytes);const row=await f.read('source'),cache=row.source.snapshotPath;
  const assertUnverified=async id=>{
    const [{citations:[c]}]=await f.resolve(claim(ref(id)));assert.equal(c.reason,'evidence_snapshot_unavailable');
    assert.equal(c.verified,false);assert.ok(!Object.hasOwn(c,'quote'));
  };
  writeFileSync(cache,pdf('FAKED'));await assertUnverified(row.id);
  rmSync(cache);await assertUnverified(row.id);
  symlinkSync(f.path,cache);await assertUnverified(row.id);
  const outside=join(f.home,row.source.sha256+'.pdf');writeFileSync(outside,bytes);
  f.ops.put({...row,id:'wrong-cache-path',source:{...row.source,snapshotPath:outside}});await assertUnverified('wrong-cache-path');
});

test('same URL can support distinct dated observations; a search snippet or changed quote cannot impersonate page text',async t=>{
  const f=fixture(t),sources=createSources({ops:f.ops,botId:'nova',workspace:f.workspace,getProjectId:()=> 'A'});
  const observe=(excerpt,evidenceType)=>sources.record({url:'https://example.org/report',requestId:'r1',status:'completed',excerpt,evidenceType});
  const a=observe('Accepted count: 42.','page_body'),b=observe('Accepted count: 24.','page_response'),s=observe('Accepted count: 24.','search_summary');
  const citation=(r,quote)=>({observationId:r.observationId,quote});
  const [{citations}]=await f.resolve(claim(citation(a,'count: 42'),citation(b,'count: 24'),citation(b,'count: 42'),citation(s,'count: 24')));
  assert.equal(citations[0].sourceId,citations[1].sourceId);assert.notEqual(citations[0].sha256,citations[1].sha256);
  assert.deepEqual(citations.map(c=>c.verified),[true,true,false,false]);assert.deepEqual(citations.slice(2).map(c=>c.reason),['web_quote_not_found','web_body_not_observed']);
  assert.ok(!Object.hasOwn(citations[3],'quote'));await assert.rejects(f.resolve(claim(citation(a,'count')),'B'),/unknown_evidence_observation/);
});

test('a DOCX read receipt pins the paragraph and an XLSX receipt pins the exact sheet and cell',async t=>{
  const f=fixture(t);
  execFileSync('python3',['-c',`from zipfile import ZipFile
from pathlib import Path
import sys
root=Path(sys.argv[1])
def package(z,path,kind):
 z.writestr('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="'+path+'"/></Relationships>')
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/'+path+'" ContentType="application/vnd.openxmlformats-officedocument.'+kind+'.main+xml"/></Types>')
with ZipFile(root/'source.docx','w') as z:
 package(z,'word/document.xml','wordprocessingml.document')
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>red oak</w:t></w:r></w:p><w:p><w:r><w:t>white cedar</w:t></w:r></w:p></w:body></w:document>')
with ZipFile(root/'source.xlsx','w') as z:
 package(z,'xl/workbook.xml','spreadsheetml.sheet')
 z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Inventory" sheetId="1" r:id="r1"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
 z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>white cedar</t></is></c></row></sheetData></worksheet>')
`,f.workspace]);
  const d=await f.read('doc',join(f.workspace,'source.docx')),x=await f.read('sheet',join(f.workspace,'source.xlsx'));
  const cite=(readId,locator)=>({readId,locator,quote:'white cedar'});
  const [{citations}]=await f.resolve(claim(cite(d.id,{paragraph:2}),cite(d.id,{paragraph:1}),cite(x.id,{sheet:'Inventory',cell:'B2'}),cite(x.id,{sheet:'Inventory',cell:'A2'})));
  assert.deepEqual(citations.map(c=>c.verified),[true,false,true,false],JSON.stringify(citations));assert.ok(citations.every(c=>!Object.hasOwn(c,'page')));
});
