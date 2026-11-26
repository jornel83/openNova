import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync,statSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {lifecycleHost} from './fixtures/lifecycle-host.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');

for(const [signal,format] of [['SIGTERM','docx'],['SIGKILL',process.platform==='darwin'?'pdf':'docx']])test('frozen research resumes after '+signal+' without reading or publishing twice',{timeout:120000},async t=>{
  const env={},f=await lifecycleHost(t,{provider:'task-frozen-research-provider.mjs',nativeFileReaderModule:'native-file-reader.mjs',hostEnv:env});
  const dir=realpathSync(f.home),trace=join(dir,'native-calls.jsonl');
  const filename='delivery.'+format;
  Object.assign(env,{OPENNOVA_TEST_RESEARCH_FORMAT:format,OPENNOVA_TEST_FREEZE_GATE:dir,OPENNOVA_NATIVE_FILE_TEST_TRACE:trace});await f.start();
  const create=async(name)=>{
    const directory=join(dir,name);mkdirSync(directory);
    const r=await f.api('/project-action',{action:'create',actionId:'create-'+name,name,directory});return r.result;
  };
  const select=async project=>f.api('/project-action',{action:'select',actionId:'select-'+project.id,projectId:project.id,focus:'work',revision:(await f.api('/projects')).state.revision});
  const a=await create('alpha'),b=await create('beta');await select(a);
  // The test transport extracts only the marker from bytes actually sent by the real file-reading tool.
  const bytes=Buffer.from('%PDF-1.4\nNATIVE_ORIGINAL_ONLY\n%%EOF\n'),src=join(a.workspace,'source.pdf');
  writeFileSync(src,bytes);writeFileSync(join(b.workspace,'source.pdf'),'%PDF-1.4\nNATIVE_FOREIGN_ONLY\n%%EOF\n');
  const input={title:'核对 A 项目资料',goal:'读取资料并生成 '+filename,workspaceMode:'documents',inputFiles:['source.pdf'],
    documentOutputPath:filename,permission:'full',managementEnabled:false,maxSteps:20,timeoutMs:100000};
  let start;
  if(signal==='SIGTERM'){
    await f.foreground('submit-research','background_agent_start',{...input,documentResearch:true});
    const task=(await f.api('/background-tasks')).tasks.find(task=>task.requestId==='submit-research');
    assert.ok(task,'foreground conversation submitted the research task');
    start=await f.api('/background-task',{id:task.id});
  }else{
    start=await f.api('/background-task-start',{...input,id:'frozen-research-e2e',kind:'agent'});
  }
  const id=start.task.id;
  assert.equal(start.task.projectId,a.id);
  assert.equal(start.task.inputSnapshot.files[0].sha256,hash(bytes));
  writeFileSync(src,'%PDF-1.4\nNATIVE_REPLACEMENT\n%%EOF\n');await select(b);
  const before=(await f.api('/snapshot')).workContext;
  writeFileSync(join(dir,'start-reading'),'1');
  const check=async condition=>{
    const detail=await f.api('/background-task',{id});
    if(['failed','cancelled'].includes(detail.task.status))throw Error('unexpected task result: '+JSON.stringify(detail.runs.at(-1)?.result??detail.task));
    return condition(detail);
  };
  await f.until(()=>check(()=>existsSync(join(dir,'after-generation'))),40000);
  const delivered=join(a.workspace,filename);
  assert.ok(existsSync(delivered),'expected explicitly authorized project delivery');
  const out=statSync(delivered),digest=hash(readFileSync(delivered));
  const body=format==='pdf'?execFileSync('/usr/bin/swift',['-e','import PDFKit; import Foundation; print(PDFDocument(url:URL(fileURLWithPath:CommandLine.arguments[1]))!.string!)',delivered],{encoding:'utf8'}):execFileSync('python3',['-I','-c','import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).read("word/document.xml").decode())',delivered],{encoding:'utf8'});
  assert.match(body,/NATIVE_ORIGINAL_ONLY/);
  assert.equal(existsSync(join(b.workspace,filename)),false);
  await f.stop(signal);writeFileSync(join(dir,'finish'),'1');await f.start();
  const final=await f.until(()=>check(d=>d.task.status==='completed'&&d.task.cleanupConfirmed&&d),50000);
  assert.equal(final.runs.length,2);
  for(const run of final.runs){
    const calls=run.jobs.filter(j=>['write','document_generate','document_read'].includes(j.tool));
    assert.deepEqual(calls.map(c=>[c.tool,c.status]).sort(),[['document_generate','completed'],['document_read','completed'],['write','completed']],JSON.stringify(final.runs.map(r=>r.jobs.filter(c=>c.tool==='document_generate').map(c=>[r.number,c.arguments,c.status,c.error,c.output?.slice(0,200)]))));
  }
  assert.ok(final.runs.every(r=>r.projectId===a.id));assert.equal(final.task.inputSnapshot.files[0].sha256,hash(bytes));
  assert.ok(final.teamReview.current.artifacts.some(r=>r.sha256===digest),'reused document is in final project report');
  assert.equal(statSync(delivered).ino,out.ino);assert.equal(statSync(delivered).mtimeMs,out.mtimeMs);assert.equal(hash(readFileSync(delivered)),digest);
  const calls=readFileSync(trace,'utf8').trim().split('\n').map(s=>JSON.parse(s)).filter(c=>c.phase==='started');
  assert.deepEqual(calls.map(c=>c.marker),['NATIVE_ORIGINAL_ONLY']);
  assert.equal((await f.api('/projects')).state.projectId,b.id);assert.deepEqual((await f.api('/snapshot')).workContext,before);
});
