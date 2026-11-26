import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readdirSync,rmSync,statSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {preparePdfPages} from '../desktop/pdf-pages.mjs';

const mac=process.platform==='darwin';
function mixedPdf(){
  const stream=(body,prefix='')=>`<< ${prefix} /Length ${body.length} >>\nstream\n${body}\nendstream`;
  const text=label=>stream(`BT /F1 11 Tf 5 40 Td (${label}) Tj ET`);
  const page=(contents,resources)=>`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 110 90] /Contents ${contents} 0 R /Resources << ${resources} >> >>`;
  const font='/Font << /F1 11 0 R >>';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 4 /Kids [3 0 R 5 0 R 7 0 R 9 0 R] >>',
    page(4,font),text('FIRST-EXCLUDED'),page(6,'/XObject << /Scan 12 0 R >>'),stream('q 110 0 0 90 0 0 cm /Scan Do Q'),
    page(8,font),text('THIRD-INCLUDED'),page(10,font),text('FOURTH-EXCLUDED'),'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream('\xff\x00\x00','/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8')];
  let result='%PDF-1.4\n';const offsets=[0];
  for(const [index,object] of objects.entries()){offsets.push(result.length);result+=`${index+1} 0 obj\n${object}\nendobj\n`;}
  const xref=result.length;
  result+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for(const offset of offsets.slice(1))result+=String(offset).padStart(10,'0')+' 00000 n \n';
  return Buffer.from(result+`trailer\n<< /Root 1 0 R /Size ${offsets.length} >>\nstartxref\n${xref}\n%%EOF\n`,'latin1');
}
function scratch(testContext){
  const previous=process.env.TMPDIR,root=mkdtempSync(join(tmpdir(),'nova-pdf-pages-test-'));
  testContext.after(()=>{if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;rmSync(root,{recursive:true,force:true});});
  return root;
}
const verifier=`import Foundation
import CoreGraphics
import PDFKit
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let document = PDFDocument(url: url)!
if CommandLine.arguments.count > 2 {
    guard document.write(to: URL(fileURLWithPath: CommandLine.arguments[2]), withOptions: [.ownerPasswordOption:"owner", .userPasswordOption:"pass"]) else { exit(1) }
} else {
    let first = document.page(at: 0)!.pageRef!
    let pixels = UnsafeMutablePointer<UInt8>.allocate(capacity: 4 * 32 * 32)
    defer { pixels.deallocate() }
    let rect = CGRect(x: 0, y: 0, width: 32, height: 32)
    let context = CGContext(data: pixels, width: 32, height: 32, bitsPerComponent: 8, bytesPerRow: 128,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.setFillColor(red: 1, green: 1, blue: 1, alpha: 1); context.fill(rect)
    context.concatenate(first.getDrawingTransform(.mediaBox, rect: rect, rotate: 0, preserveAspectRatio: true))
    context.drawPDFPage(first)
    let offset = (32 * 16 + 16) * 4
    let info: [String: Any] = ["pageText": (0..<document.pageCount).map { document.page(at: $0)?.string ?? "" },
        "scanPixel": (offset..<(offset + 3)).map { Int(pixels[$0]) }]
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: info))
}`;
function swift(root,...args){
  return execFileSync('/usr/bin/swift',['-e',verifier,...args],{timeout:30000,encoding:'utf8',env:{...process.env,TMPDIR:root}});
}

test('physical range keeps only the selected original pages, including a raster-only scan, with a non-ASCII TMPDIR',{skip:!mac,timeout:60000},async context=>{
  const root=scratch(context),unicode=join(root,'临时目录 😀');
  mkdirSync(unicode);process.env.TMPDIR=unicode;
  const input=mixedPdf(),pending=preparePdfPages({bytes:input,range:{startPage:2,endPage:3}});
  const selected=await pending;
  assert.deepEqual([selected.pageCount,selected.startPage,selected.endPage],[4,2,3]);
  const output=join(root,'选取 2-3.pdf');writeFileSync(output,selected.bytes);
  const visual=JSON.parse(swift(root,output));
  assert.deepEqual(visual.pageText,['','THIRD-INCLUDED']);assert.deepEqual(visual.scanPixel,[255,0,0]);
  assert.deepEqual(input,mixedPdf());assert.deepEqual(readdirSync(unicode),[]);
});

test('inspection preserves bytes; invalid last page reports original count; locked input is not transmitted',{skip:!mac,timeout:65000},async context=>{
  const root=scratch(context);process.env.TMPDIR=root;
  const input=mixedPdf(),pending=preparePdfPages({bytes:input});input.fill(0);
  const info=await pending;
  assert.deepEqual([info.pageCount,info.startPage,info.endPage],[4,1,4]);assert.deepEqual(info.bytes,mixedPdf());
  await assert.rejects(preparePdfPages({bytes:info.bytes,range:{startPage:4,endPage:5}}),error=>error.message==='pdf_page_range_out_of_bounds'&&error.pageCount===4);
  const source=join(root,'input.pdf'),encrypted=join(root,'locked.pdf');writeFileSync(source,info.bytes);swift(root,source,encrypted);
  await assert.rejects(preparePdfPages({bytes:readFileSync(encrypted),range:{startPage:1,endPage:1}}),/pdf_encrypted/);
  assert.ok(!readdirSync(root).some(name=>name.startsWith('opennova-pdf-pages-')));
});

test('invalid or oversized inputs fail before any subprocess',async()=>{
  await assert.rejects(preparePdfPages({bytes:mixedPdf(),range:{startPage:1,endPage:3.5}}),/invalid_pdf_page_range/);
  await assert.rejects(preparePdfPages({bytes:mixedPdf(),range:{startPage:3,endPage:2}}),/invalid_pdf_page_range/);
  await assert.rejects(preparePdfPages({bytes:mixedPdf(),range:{startPage:1,endPage:257}}),/pdf_page_range_too_large/);
  await assert.rejects(preparePdfPages({bytes:Buffer.alloc(20*1024*1024+1)}),/file_too_large/);
});

test('cancellation and deadline remove the private directory and terminate the helper',{skip:!mac,timeout:10000},async context=>{
  const root=scratch(context);process.env.TMPDIR=root;
  const controller=new AbortController(),pending=preparePdfPages({bytes:mixedPdf(),signal:controller.signal});
  const [directory]=readdirSync(root);assert.equal(statSync(join(root,directory)).mode&0o777,0o700);
  controller.abort();await assert.rejects(pending,/cancelled/);assert.deepEqual(readdirSync(root),[]);
  await assert.rejects(preparePdfPages({bytes:mixedPdf(),timeoutMs:1}),/pdf_pages_timeout/);
  assert.deepEqual(readdirSync(root),[]);
});
