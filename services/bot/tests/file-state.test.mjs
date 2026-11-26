import test from 'node:test';
import assert from 'node:assert/strict';
import {fileReadLabel,readOperationReceipt,generationView} from '../web/file-state.mjs';
test('file receipt distinguishes readable, partial, read and obsolete saved versions',()=>{
  assert.equal(fileReadLabel({contentAccess:'native_file',openStatus:'dispatched'}),'正文可按需读取');
  assert.equal(fileReadLabel({readStatus:'read'}),'已按本次问题读取保存版本');
  assert.equal(fileReadLabel({readStatus:'partial'}),'已按本次问题读取部分内容');
  assert.equal(fileReadLabel({readStatus:'read',diskStatus:'changed'}),'磁盘文件已更新，需重新读取');
  assert.equal(fileReadLabel({readStatus:'read',invalid:true}),'文件已失效');
  assert.equal(fileReadLabel({contentAccess:'text_file'}),'文本可另行读取磁盘保存版本');
  assert.equal(fileReadLabel({contentAccess:'not_connected'}),'此格式正文尚未接入');
  assert.equal(fileReadLabel({imageOperationId:'generated-1'}),'继续改图时使用此版本');
  assert.equal(fileReadLabel({imageOperationId:'generated-1',diskStatus:'changed'}),'磁盘文件已更新，需重新读取');
});

test('file card identifies original PDF pages, preserves partial results and hides obsolete labels',()=>{
  const readScope={mode:'pdf_pages',startPage:3,endPage:5,pageCount:6};
  assert.equal(fileReadLabel({readScope,readStatus:'read'}),'原文第 3–5 页（共 6 页） · 已按本次问题读取');
  assert.equal(fileReadLabel({readScope:{...readScope,startPage:5},readStatus:'partial'}),'原文第 5 页（共 6 页） · 仅能确认部分内容');
  assert.equal(fileReadLabel({readScope,readStatus:'read',diskStatus:'changed'}),'磁盘文件已更新，需重新读取');
  assert.equal(fileReadLabel({readScope:{...readScope,endPage:99},readStatus:'read'}),'已按本次问题读取保存版本');
});

test('operation receipt distinguishes attempted pages, partial answers and pages to resume',()=>{
  const readScope={mode:'pdf_pages',startPage:2,endPage:3,pageCount:6},recovery={remainingRange:{startPage:4,endPage:6}};
  const partial=readOperationReceipt({status:'completed',readStatus:'partial',readScope,recovery,diskStatus:'changed'});
  assert.match(partial,/原文第 2–3 页（共 6 页） · 仅能确认部分内容/);assert.match(partial,/版本已更新/);assert.match(partial,/可继续读取：原文第 4–6 页/);
  for(const status of ['failed','cancelled','timed_out','interrupted','running']){
    const label=readOperationReceipt({readStatus:'read',readScope,status});
    assert.match(label,/本次范围：原文第 2–3 页/);assert.doesNotMatch(label,/已按本次问题读取|可继续读取/);
    assert.match(label,status==='running'?/等待读取结果/:/未取得已确认的读取结果/);
  }
});

test('revision receipts show committed editions, never a staging candidate or an unconfirmed open',()=>{
  const artifact={path:'/notes/方案.v2.docx',parentPath:'/notes/方案.docx',revision:2};
  const row={action:'revise',artifact,status:'completed',contentValidation:{status:'passed'},layoutValidation:{visual:{status:'not_checked'}}};
  assert.deepEqual(generationView(row),{title:'修订文档',status:'已保存第 2 版',path:artifact.path,previousPath:artifact.parentPath,summary:'内容核验通过；未检查逐页外观'});
  for(const status of ['running','failed','cancelled','interrupted'])assert.equal(generationView({...row,status}).path,undefined);
  assert.equal(generationView({...row,action:'inspect'}).path,undefined);
  assert.equal(generationView({...row,artifact:undefined,commit:{artifact}}).path,undefined);
});

test('conflicts identify the version to check and do not present a proposed edition as saved',()=>{
  const details={path:'/notes/a.pdf',latestPath:'/notes/a.v2.pdf'},r={action:'revise',status:'failed',errorDetails:details};
  const changed=generationView({...r,error:'document_revision_source_changed'});assert.equal(changed.sourcePath,details.path);assert.match(changed.summary,/未被覆盖/);
  const stale=generationView({...r,error:'document_revision_not_latest'});assert.equal(stale.latestPath,details.latestPath);assert.equal(stale.previousPath,undefined);
  const file={artifactId:'artifact-2',generationStatus:'completed',revision:2};assert.match(fileReadLabel(file),/已保存第 2 版/);
  assert.doesNotMatch(fileReadLabel({...file,diskStatus:'changed'}),/已保存第 2 版/);
});
