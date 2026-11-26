import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,realpathSync,rmSync,symlinkSync,linkSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Operations} from '../operations.mjs';
import {createWorkContext} from '../desktop/context.mjs';
import {inspectFileReference} from '../desktop/documents.mjs';
import {createDocumentGenerator,createDocumentGenerateTool,printableResearchSpec} from '../documents/generator.mjs';
import {readDocumentProposal} from '../documents/proposals.mjs';
import {normalizeDocumentSpec} from '../documents/spec.mjs';
import {runDocumentGenerator} from '../documents/runner.mjs';
import {recoverToolRuns} from '../project.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fileVersion=path=>{const s=statSync(path);return {size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs,ino:s.ino};};
// Deliberately only format-signature fixtures: executor and integration tests
// separately validate real OOXML/PDF. These tests exercise publication state.
const bytes=format=>format==='pdf'?Buffer.from('%PDF-1.7\nSYNTHETIC-TEST-ONLY\n%%EOF\n'):Buffer.from('504b0304','hex').subarray(0,4);
const docxBytes=Buffer.concat([bytes('docx'),Buffer.from('word/document.xml\nTEST-ONLY')]);
const receipt=()=>({generation:{status:'completed'},contentValidation:{status:'passed'},layoutValidation:{status:'not_checked',automatic:{status:'passed'},visual:{status:'not_checked'}}});
const spec=()=>({schemaVersion:1,title:'真实保存状态测试',blocks:[{type:'paragraph',text:'输入资料 ORIGINAL-84'}]});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

function fixture(t,{run,onOperation}={}){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-document-generator-'))),workspace=join(home,'project');
  const context=createWorkContext({inspectFile:inspectFileReference}),controller=new AbortController(),calls=[];
  const state={active:{id:'request-a',projectId:'project-a',signal:controller.signal,
    binding:{focus:'work',projectId:'project-a',cwd:workspace,context:context.capture()}}};
  const f={home,workspace,context,controller,calls,state,onOperation};
  const events={publish:(type,row)=>f.onOperation?.(type,row,f)};
  f.ops=new Operations({home,workspace,events});
  f.runner=async input=>{calls.push(input);if(run)return run(input,f);
    writeFileSync(input.outputPath,input.format==='pdf'?bytes('pdf'):docxBytes,{flag:'wx'});return receipt();};
  f.recreate=()=>f.generator=createDocumentGenerator({...f,getRequest:()=>state.active,runner:f.runner});
  f.recreate();
  f.save=(name,data)=>{const path=join(workspace,name);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,data);return path;};
  f.specPath=f.save('spec.json',JSON.stringify(spec()));
  f.input={format:'pdf',specPath:'spec.json',outputPath:'out/result.pdf'};
  f.noStaging=()=>{const dir=join(workspace,'out');return !existsSync(dir)||!readdirSync(dir).some(n=>n.startsWith('.nova-document-'));};
  t.after(()=>{f.ops.close();rmSync(home,{recursive:true,force:true});});
  return f;
}

test('generation saves verified bytes and immutable spec, persists artifact/hash and selects only the final file',async t=>{
  const f=fixture(t),r=await f.generator.generate(f.input,{id:'generate-one'}),target=join(f.workspace,'out/result.pdf');
  assert.equal(r.status,'completed');assert.equal(r.phase,'committed');assert.equal(r.artifact.path,target);
  assert.equal(r.artifact.sha256,hash(bytes('pdf')));assert.equal(r.artifact.projectId,'project-a');assert.equal(r.artifact.requestId,'request-a');
  assert.deepEqual(readFileSync(target),bytes('pdf'));assert.deepEqual(readFileSync(r.artifact.snapshotPath),bytes('pdf'));
  assert.equal(r.artifact.specSha256,hash(readFileSync(r.artifact.specSnapshotPath)));
  assert.deepEqual(JSON.parse(readFileSync(r.artifact.specSnapshotPath)),normalizeDocumentSpec(spec()));
  assert.equal(statSync(r.artifact.specSnapshotPath).mode&0o777,0o600);
  assert.equal(f.context.capture().file.path,target);assert.equal(f.context.capture().file.artifactId,r.artifact.id);
  assert.deepEqual(r.artifact.version,fileVersion(target));assert.equal(f.context.snapshot().file.diskStatus,'unchanged');
  assert.equal(statSync(target).nlink,1,'staging hardlink is removed before recording the final version');
  assert.equal(r.contextSelected,true);assert.equal(f.ops.get(r.artifact.id).kind,'document_artifact');
  assert.deepEqual(f.state.active.objectReads.get(target),r.artifact.version);
  assert.equal(f.ops.list('project_reference').length,0);assert.equal(f.noStaging(),true);
  assert.equal(r.layoutValidation.visual.status,'not_checked');
});

test('concurrent Harness call IDs deduplicate, replay preserves original output, and changed parameters conflict',async t=>{
  const entered=deferred(),release=deferred();
  const f=fixture(t,{run:async input=>{entered.resolve();await release.promise;writeFileSync(input.outputPath,bytes('pdf'));return receipt();}});
  const tool=createDocumentGenerateTool({generator:f.generator,getRequest:()=>f.state.active});
  const exec={callId:'same-call',signal:f.controller.signal};
  const a=tool[3](f.input,exec),b=tool[3](f.input,exec);await entered.promise;release.resolve();
  const r=await a;assert.deepEqual(await b,r);assert.equal(f.calls.length,1);assert.equal(f.ops.list('tool').length,1);
  writeFileSync(f.specPath,JSON.stringify({...spec(),title:'changed later'}));
  assert.deepEqual(await tool[3](f.input,exec),r);assert.equal(f.calls.length,1);
  await assert.rejects(tool[3]({...f.input,outputPath:'other.pdf'},exec),/command_id_conflict/);
});

test('both format signatures are checked rather than trusting a successful runner receipt',async t=>{
  const f=fixture(t),r=await f.generator.generate({...f.input,format:'docx',outputPath:'out/new.docx'},{id:'docx'});
  assert.equal(r.status,'completed');assert.deepEqual(readFileSync(r.artifact.path),docxBytes);
  const bad=fixture(t,{run:async input=>{writeFileSync(input.outputPath,'not a PDF');return receipt();}});
  const failed=await bad.generator.generate(bad.input,{id:'bad-signature'});
  assert.equal(failed.error,'invalid_document_output');assert.equal(failed.status,'failed');
  assert.equal(existsSync(join(bad.workspace,'out/result.pdf')),false);assert.equal(bad.noStaging(),true);
});

test('failed or falsely visual-verified runner receipts never publish an output',async t=>{
  for(const mode of ['failure','bad-content','false-visual']){
    const f=fixture(t,{run:async input=>{
      writeFileSync(input.outputPath,bytes('pdf'));
      if(mode==='failure')throw Error('document_generation_timeout');
      const r=receipt();if(mode==='bad-content')r.contentValidation.status='failed';else r.layoutValidation.visual.status='passed';return r;
    }});
    const r=await f.generator.generate(f.input,{id:mode});assert.equal(r.status,'failed');
    assert.equal(r.error,mode==='failure'?'document_generation_timeout':'invalid_document_generator_receipt');
    assert.equal(existsSync(join(f.workspace,'out/result.pdf')),false);assert.equal(f.noStaging(),true);
    assert.equal(f.ops.list('document_artifact').length,0);assert.equal(f.context.capture().kind,'none');
  }
});

test('cancellation before execution, during rendering, or before commit leaves no final file',async t=>{
  for(const phase of ['before','rendering','committing']){
    const f=fixture(t,{run:async(input,f)=>{writeFileSync(input.outputPath,bytes('pdf'));if(phase==='rendering')f.controller.abort();return receipt();},
      onOperation:(_,row,f)=>{if(phase==='committing'&&row.operation==='document_generate'&&row.phase==='committing')f.controller.abort();}});
    if(phase==='before')f.controller.abort();
    const r=await f.generator.generate(f.input,{id:'cancel-'+phase});assert.equal(r.status,'cancelled');assert.equal(r.error,'cancelled');
    assert.equal(f.calls.length,phase==='before'?0:1);assert.equal(existsSync(join(f.workspace,'out/result.pdf')),false);
    assert.equal(f.noStaging(),true);assert.equal(f.context.capture().kind,'none');
  }
});

test('cancellation after the durable commit preserves the actual file and never reports it cancelled away',async t=>{
  let once=false;
  const f=fixture(t,{onOperation:(_,row,f)=>{if(!once&&row.operation==='document_generate'&&row.phase==='committed'&&row.status==='completed'){
    once=true;f.controller.abort();
  }}});
  const r=await f.generator.generate(f.input,{id:'cancel-after'});
  assert.equal(r.status,'completed');assert.deepEqual(readFileSync(r.artifact.path),bytes('pdf'));
  assert.equal(r.artifact.sha256,hash(readFileSync(r.artifact.path)));assert.equal(f.noStaging(),true);
  assert.equal(f.context.capture().kind,'none');
});

test('a context selection made while the committed operation is announced is not overwritten by final bookkeeping',async t=>{
  let once=false;
  const f=fixture(t,{onOperation:(_,row,f)=>{if(!once&&row.operation==='document_generate'&&row.phase==='committed'&&row.status==='completed'){
    once=true;f.context.selectFile({id:'status-listener-selection',path:'/tmp/user-choice.pdf'});
  }}});
  const r=await f.generator.generate(f.input,{id:'select-at-commit'});
  assert.equal(r.status,'completed');assert.equal(f.context.capture().file.id,'status-listener-selection');
  assert.deepEqual(readFileSync(r.artifact.path),bytes('pdf'));
});

test('changed requests or project ownership cannot publish late results',async t=>{
  for(const change of ['request','project']){
    const entered=deferred(),release=deferred();
    const f=fixture(t,{run:async input=>{entered.resolve();await release.promise;writeFileSync(input.outputPath,bytes('pdf'));return receipt();}});
    const pending=f.generator.generate(f.input,{id:'late-'+change});await entered.promise;
    if(change==='request')f.state.active={...f.state.active,id:'new-request'};
    else{f.state.active.projectId='project-b';f.state.active.projectChanged=true;}
    release.resolve();const r=await pending;
    assert.equal(r.status,'failed');assert.equal(r.error,'project_request_mismatch');
    assert.equal(existsSync(join(f.workspace,'out/result.pdf')),false);assert.equal(f.noStaging(),true);
  }
});

test('a user selecting another current file during generation wins while the original project keeps its artifact',async t=>{
  const f=fixture(t,{run:async(input,f)=>{f.context.selectFile({id:'user-new-file',path:'/tmp/user-selected.pdf'});writeFileSync(input.outputPath,bytes('pdf'));return receipt();}});
  const r=await f.generator.generate(f.input,{id:'selection'});
  assert.equal(r.status,'completed');assert.equal(r.contextSelected,false);assert.equal(r.artifact.projectId,'project-a');
  assert.equal(f.context.capture().file.id,'user-new-file');assert.equal(f.ops.list('document_artifact').length,1);
});

test('an externally created destination wins the no-clobber commit and remains byte-for-byte unchanged',async t=>{
  const entered=deferred(),release=deferred();
  const f=fixture(t,{run:async input=>{entered.resolve();await release.promise;writeFileSync(input.outputPath,bytes('pdf'));return receipt();}});
  const pending=f.generator.generate(f.input,{id:'destination-race'});await entered.promise;
  const target=join(f.workspace,'out/result.pdf'),external=Buffer.from('EXTERNAL USER FILE');writeFileSync(target,external);
  release.resolve();const r=await pending;
  assert.equal(r.status,'failed');assert.equal(r.error,'document_target_exists');assert.deepEqual(readFileSync(target),external);
  assert.equal(f.ops.list('document_artifact').length,0);assert.equal(f.noStaging(),true);
});

test('a staging file replaced after validation cannot publish bytes different from the recorded artifact hash',async t=>{
  for(const mode of ['write','symlink']){
    let once=false;
    const f=fixture(t,{onOperation:(_,row,f)=>{
      if(once||row.operation!=='document_generate'||row.phase!=='committing')return;
      once=true;const source=join(row.stagePath,'result.pdf');
      if(mode==='write')writeFileSync(source,Buffer.from('%PDF-1.7\nUNVERIFIED CHANGED DATA\n%%EOF\n'));
      else{rmSync(source);symlinkSync(f.save('unrelated.pdf','UNRELATED USER DOCUMENT'),source);}
    }});
    const r=await f.generator.generate(f.input,{id:'staging-change-'+mode}),target=join(f.workspace,'out/result.pdf');
    if(r.status==='completed'){
      assert.deepEqual(readFileSync(target),bytes('pdf'),'only the previously validated bytes may be published');
      assert.equal(hash(readFileSync(target)),r.artifact.sha256);
    }else{
      assert.equal(r.status,'failed');assert.equal(existsSync(target),false);
    }
    assert.equal(f.noStaging(),true);
  }
});

test('existing files, symlinks and FIFOs at the output path are never replaced or opened',async t=>{
  for(const kind of ['file','symlink','fifo']){
    const f=fixture(t),target=join(f.workspace,'out/result.pdf');mkdirSync(join(target,'..'),{recursive:true});
    if(kind==='file')writeFileSync(target,'existing');
    if(kind==='symlink')symlinkSync(f.specPath,target);
    if(kind==='fifo')execFileSync('/usr/bin/mkfifo',[target]);
    const before=readFileSync(f.specPath),r=await f.generator.generate(f.input,{id:'existing-'+kind});
    assert.equal(r.error,'document_target_exists');assert.equal(f.calls.length,0);assert.deepEqual(readFileSync(f.specPath),before);
    assert.equal(f.noStaging(),true);
  }
});

test('invalid, missing, oversize and FIFO specs fail before executing a generator',async t=>{
  for(const mode of ['json','utf8','schema','missing','oversize','fifo']){
    const f=fixture(t);
    if(mode==='json')writeFileSync(f.specPath,'{ broken');
    if(mode==='utf8')writeFileSync(f.specPath,Buffer.from([0xff,0xfe]));
    if(mode==='schema')writeFileSync(f.specPath,JSON.stringify({...spec(),script:'do not execute'}));
    if(mode==='missing')rmSync(f.specPath);
    if(mode==='oversize')writeFileSync(f.specPath,'x'.repeat(512*1024+1));
    if(mode==='fifo'){rmSync(f.specPath);execFileSync('/usr/bin/mkfifo',[f.specPath]);}
    const r=await f.generator.generate(f.input,{id:'spec-'+mode});assert.equal(r.status,'failed');assert.equal(f.calls.length,0);
    assert.equal(existsSync(join(f.workspace,'out/result.pdf')),false);
  }
});

test('changing the original spec after snapshotting does not change content given to the executor',async t=>{
  let captured;
  const f=fixture(t,{run:async(input,f)=>{
    writeFileSync(f.specPath,JSON.stringify({...spec(),title:'EXTERNAL NEW VERSION'}));
    captured=JSON.parse(readFileSync(input.specPath));writeFileSync(input.outputPath,bytes('pdf'));return receipt();
  }});
  const original=readFileSync(f.specPath),r=await f.generator.generate(f.input,{id:'spec-change'});
  assert.equal(r.status,'completed');assert.equal(r.spec.sourceSha256,hash(original));assert.equal(captured.title,spec().title);
  assert.deepEqual(JSON.parse(readFileSync(r.artifact.specSnapshotPath)),captured);
  assert.notEqual(hash(readFileSync(f.specPath)),r.spec.sourceSha256);
});

test('a corrupted supposedly immutable spec snapshot fails before publication even if the runner claims success',async t=>{
  const f=fixture(t,{run:async input=>{
    writeFileSync(input.specPath,JSON.stringify({...spec(),title:'REPLACED PRIVATE SNAPSHOT'}));
    writeFileSync(input.outputPath,bytes('pdf'));return receipt();
  }});
  const r=await f.generator.generate(f.input,{id:'corrupt-snapshot'});
  assert.equal(r.status,'failed');assert.equal(r.error,'document_spec_changed');
  assert.equal(existsSync(join(f.workspace,'out/result.pdf')),false);assert.equal(f.noStaging(),true);
  assert.equal(f.ops.list('document_artifact').length,0);
});

test('file and web source references must match actual project evidence and retain unverified locator status',async t=>{
  const f=fixture(t),fileSha=hash('file evidence'),webSha=hash('web evidence');
  f.ops.put({id:'read-evidence',kind:'tool',operation:'document_read',status:'completed',projectId:'project-a',readStatus:'partial',
    source:{sourceId:'file-source-a',sha256:fileSha,version:{size:13,mtimeMs:1}}});
  f.ops.put({id:'web-observation-a',kind:'research_observation',status:'completed',sourceId:'web-source-a',projectId:'project-a',artifactHash:webSha,retrievedAt:'2026-11-17T01:00:00Z'});
  f.save('spec.json',JSON.stringify({...spec(),sources:[{sourceId:'file-source-a',sha256:fileSha,locator:'第 1 页'},
    {sourceId:'web-source-a',observationId:'web-observation-a',sha256:webSha,locator:'摘要'}]}));
  const r=await f.generator.generate(f.input,{id:'with-evidence'});assert.equal(r.status,'completed');
  assert.equal(r.sources[0].identityVerified,true);assert.equal(r.sources[0].sourceStatus,'partial');
  assert.equal(r.sources[0].locatorVerified,false);assert.equal(r.sources[1].identityVerified,true);assert.equal(r.sources[1].locatorVerified,false);
  for(const [id,reference,error] of [
    ['invented',{sourceId:'not-real'},'document_source_not_found'],
    ['wrong-version',{sourceId:'file-source-a',sha256:'0'.repeat(64)},'document_source_version_mismatch'],
    ['wrong-observation',{sourceId:'web-source-a',observationId:'invented'},'document_source_not_found']
  ]){
    f.save('spec.json',JSON.stringify({...spec(),sources:[reference]}));
    const failed=await f.generator.generate({...f.input,outputPath:`out/${id}.pdf`},{id});assert.equal(failed.error,error);
  }
  f.ops.put({id:'other-project-read',kind:'tool',operation:'document_read',status:'completed',projectId:'project-b',source:{sourceId:'other-source',sha256:fileSha}});
  f.save('spec.json',JSON.stringify({...spec(),sources:[{sourceId:'other-source'}]}));
  assert.equal((await f.generator.generate({...f.input,outputPath:'out/cross.pdf'},{id:'cross-source'})).error,'document_source_not_found');
  assert.equal(f.calls.length,1);
});

test('restart reconciles a committed target even after generic recovery marked the tool interrupted, without rerunning or selecting it',async t=>{
  const f=fixture(t),target=f.save('out/result.pdf',bytes('pdf')),stage=join(f.workspace,'out/.nova-document-restart');mkdirSync(stage);
  writeFileSync(join(stage,'temporary'),'old staging');linkSync(target,join(stage,'publication'));
  const artifact={id:'artifact-restart',path:target,format:'pdf',size:bytes('pdf').length,sha256:hash(bytes('pdf')),projectId:'project-a',requestId:'request-a',version:fileVersion(target)};
  const inputFingerprint=JSON.stringify({input:f.input,requestId:f.state.active.id,projectId:'project-a',cwd:f.workspace});
  f.ops.put({id:'restart',kind:'tool',operation:'document_generate',status:'running',phase:'committing',inputFingerprint,
    targetPath:target,stagePath:stage,commit:{artifact,receipt:receipt()},projectId:'project-a'});
  recoverToolRuns(f.ops);assert.equal(f.ops.get('restart').status,'interrupted');
  f.ops.close();f.ops=new Operations({home:f.home,workspace:f.workspace});f.recreate();
  const recovered=await f.generator.generate(f.input,{id:'restart'});
  assert.equal(recovered.status,'completed');assert.equal(recovered.recovered,true);assert.equal(recovered.contextSelected,false);
  assert.equal(f.calls.length,0);assert.equal(f.context.capture().kind,'none');assert.equal(existsSync(stage),false);
  assert.equal(f.ops.get(artifact.id).kind,'document_artifact');assert.deepEqual(readFileSync(target),bytes('pdf'));
  assert.deepEqual(recovered.artifact.version,fileVersion(target));assert.deepEqual(f.ops.get(artifact.id).version,fileVersion(target));
  assert.equal(statSync(target).nlink,1,'recovery cleans the staging hardlink before capturing the version');
});

test('restart cannot bless a changed target or remove unrelated paths, and never retries uncertain work',async t=>{
  const f=fixture(t),target=f.save('out/result.pdf','USER CHANGED OUTPUT'),unrelated=join(f.home,'unrelated');mkdirSync(unrelated);
  writeFileSync(join(unrelated,'keep'),'preserved');
  const inputFingerprint=JSON.stringify({input:f.input,requestId:f.state.active.id,projectId:'project-a',cwd:f.workspace});
  f.ops.put({id:'uncertain',kind:'tool',operation:'document_generate',status:'committing',inputFingerprint,targetPath:target,stagePath:unrelated,
    commit:{artifact:{id:'uncertain-artifact',path:target,sha256:hash(bytes('pdf'))},receipt:receipt()}});
  f.recreate();const result=await f.generator.generate(f.input,{id:'uncertain'});
  assert.equal(result.status,'interrupted');assert.equal(f.calls.length,0);assert.equal(f.ops.list('document_artifact').length,0);
  assert.equal(readFileSync(target,'utf8'),'USER CHANGED OUTPUT');assert.equal(readFileSync(join(unrelated,'keep'),'utf8'),'preserved');
});

test('input authority and target type failures remain errors without dispatching a runner',async t=>{
  const f=fixture(t);
  for(const [id,input,error] of [
    ['replace',{...f.input,expectedTarget:{sha256:'0'.repeat(64)}},'document_replace_not_supported'],
    ['extension',{...f.input,outputPath:'bad.docx'},'document_extension_mismatch'],
    ['web',{...f.input,outputPath:'https://example.com/out.pdf'},'invalid_document_path'],
    ['authority',{...f.input,projectId:'other'},'invalid_document_generate']
  ])assert.equal((await f.generator.generate(input,{id})).error,error);
  assert.equal(f.calls.length,0);
  f.state.active.binding={...f.state.active.binding,focus:'daily'};
  await assert.rejects(f.generator.generate(f.input,{id:'daily'}),/project_work_request_required/);
});

test('research exports resolve claims before printing; a fake read or verification flag cannot publish',async t=>{
  const f=fixture(t);
  const claim={kind:'fact',claim:'一个结论',citations:[{readId:'unknown-source-read',page:1,quote:'拟核对的引文'}]};
  for(const [id,citation,error] of [['unknown',claim.citations[0],'unknown_evidence_read'],['forged',{...claim.citations[0],verified:true},'invalid_evidence_citation']]){
    f.save('spec.json',JSON.stringify({schemaVersion:1,title:'研究笔记',claims:[{...claim,citations:[citation]}]}));
    const result=await f.generator.generate(f.input,{id});
    assert.equal(result.error,error);assert.equal(f.calls.length,0);
    assert.equal(existsSync(join(f.workspace,'out/result.pdf')),false);
  }
});

test('research exports preserve Office locators and web observation versions without inventing pages',()=>{
  const sha256=hash('one-version');
  const citations=[
    {fileName:'工作簿.xlsx',locator:{sheet:'产量',cell:'D17'},verified:true,quote:'29',sha256},
    {fileName:'总结.docx',locator:{paragraph:4},verified:false,quote:'未匹配的文字',sha256},
    {url:'https://example.test/notes',observationId:'obs-20261118',verified:true,quote:'记录当日版本',sha256},
  ];
  const rendered=printableResearchSpec(spec(),[{kind:'inference',claim:'三个观察结果有待比较。',citations}]);
  const text=rendered.blocks.map(b=>b.text).join('\n');
  assert.match(text,/工作簿\.xlsx · 工作表「产量」· 单元格 D17/);
  assert.match(text,/总结\.docx · 请求核对：正文第 4 段/);
  assert.ok(text.includes('来源：https://example.test/notes · 网页观察记录：obs-20261118 · 网页观察文本版本 SHA-256：'+sha256));
  assert.match(text,/已核对原文：“记录当日版本”/);
  assert.doesNotMatch(text,/未匹配的文字|原文件物理页|undefined/);
});

test('Word and PDF research notes print the verified snapshot quote and suppress a false quote', {skip:process.platform!=='darwin',timeout:90000},async t=>{
  const f=fixture(t,{run:runDocumentGenerator});
  // Create an actual text-layer PDF and a durable read from that snapshot.
  const originalSpec=normalizeDocumentSpec({schemaVersion:1,title:'观测报告',blocks:[{type:'paragraph',text:'样本共 82 份。'}]});
  const origin=f.save('source.json',JSON.stringify(originalSpec));
  const path=join(f.workspace,'观测报告.pdf');
  await runDocumentGenerator({format:'pdf',specPath:origin,outputPath:path,workdir:f.workspace});
  const orig=readFileSync(path),sha256=hash(orig),dir=join(f.home,'file-inputs');
  mkdirSync(dir);const snapshotPath=join(dir,sha256+'.pdf');writeFileSync(snapshotPath,orig);
  f.ops.put({id:'observation-read',kind:'tool',operation:'document_read',status:'completed',readStatus:'partial',projectId:'project-a',
    readScope:{mode:'pdf_pages',startPage:1,endPage:1,pageCount:1},
    source:{sourceId:'file-source-observation',projectId:'project-a',contentOrigin:'disk_saved_snapshot',mime:'application/pdf',name:'观测报告.pdf',sha256,path,version:fileVersion(path),size:orig.length,snapshotPath}});
  writeFileSync(path,'新版外部文件，不能代替原件。');
  const webBody='当日观测记录确认了样本数量。';
  f.ops.put({id:'web-archive',kind:'research_observation',projectId:'project-a',status:'completed',sourceId:'web-source',finalUrl:'https://example.test/archive',excerpt:webBody,evidenceType:'page_body'});
  const citations=[{readId:'observation-read',page:1,quote:'样本共 82 份。'},{readId:'observation-read',page:1,quote:'FALSE-QUOTE-NEVER-PUBLISH'},{observationId:'web-archive',quote:webBody}];
  f.save('spec.json',JSON.stringify({schemaVersion:1,title:'研究笔记',claims:[{kind:'fact',claim:'该次观测有 82 份样本。',citations}]}));
  for(const format of ['docx','pdf']){
    const result=await f.generator.generate({...f.input,format,outputPath:'out/result.'+format},{id:'research-'+format});
    assert.equal(result.status,'completed',JSON.stringify(result));
    assert.equal(result.claims[0].citations[0].verified,true);assert.equal(result.claims[0].citations[1].verified,false);
    assert.deepEqual(result.artifact.claims,result.claims);
    assert.deepEqual(f.ops.get(result.artifact.id).claims,result.claims);
    const body=format==='docx'?execFileSync('/usr/bin/unzip',['-p',result.artifact.path,'word/document.xml'],{encoding:'utf8'}):
      execFileSync('/usr/bin/swift',['-e','import PDFKit; print(PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1]))!.string!)',result.artifact.path],{encoding:'utf8'});
    const compact=body.replace(/\s+/gu,'');
    for(const value of ['关键结论与出处','该次观测有82份样本。','样本共82份。','摘录待核实','观测报告.pdf','物理页1',sha256,'仅取得部分内容','网页观察记录：web-archive',hash(webBody),webBody,'https://example.test/archive'])assert.ok(compact.includes(value),value);
    assert.ok(!body.includes('FALSE-QUOTE-NEVER-PUBLISH'));
    assert.equal(result.contentValidation.status,'passed');
  }
});

test('Word and PDF proposals retain exact candidates and pinned research receipts after restart', {skip:process.platform!=='darwin',timeout:90000},async t=>{
  const f=fixture(t,{run:runDocumentGenerator}),body='The inventory count is 12.';
  f.ops.put({id:'edition-observation',kind:'research_observation',projectId:'project-a',status:'completed',sourceId:'src-a',finalUrl:'https://example.test/fixed',excerpt:body,evidenceType:'page_body'});
  const draft={...spec(),claims:[{kind:'fact',claim:'盘点已记录',citations:[{observationId:'edition-observation',quote:body}]}]};
  for(const format of ['docx','pdf']){
    f.save('spec.json',JSON.stringify(draft));
    const create=await f.generator.generate({...f.input,format,outputPath:'out/report.'+format},{id:'v1-'+format});assert.equal(create.status,'completed',create.error);
    const one=create.artifact,original=readFileSync(one.path),calls=f.calls.length;
    f.context.selectFile({id:'opened-file',path:one.path});f.state.active.binding.context=f.context.capture();delete f.state.active.fileReaderContextIdentity;
    const inspected=await f.generator.generate({action:'inspect',current:true},{id:'inspect-'+format});
    assert.equal(inspected.phase,'inspected',inspected.error);assert.equal(inspected.inspection.artifactId,one.id);
    assert.equal(inspected.inspection.blockCount,1);assert.equal(inspected.inspection.claims[0].index,1);assert.equal(f.calls.length,calls);
    // The live JSON input is gone; the revision must use the retained private recipe.
    rmSync(f.specPath);f.ops.close();f.ops=new Operations({home:f.home,workspace:f.workspace});f.recreate();
    const req={action:'revise',current:true,patch:{title:'修订后的盘点笔记',edits:[{op:'insert',index:2,block:{type:'paragraph',text:'SECOND-EDITION-CONTENT'}}]}};
    const contextBefore=f.context.capture(),recordCount=f.ops.list('document_artifact').length;
    const result=await f.generator.generate(req,{id:'revise-'+format});assert.equal(result.phase,'proposed',result.error);
    assert.equal(result.artifact,undefined);assert.equal(result.proposal.status,'pending');
    assert.equal(result.proposal.baseArtifactId,one.id);assert.equal(result.proposal.baseSha256,one.sha256);assert.equal(result.proposal.baseRevision,1);
    assert.equal(f.calls.length,calls);assert.deepEqual(f.context.capture(),contextBefore);
    assert.equal(f.ops.list('document_artifact').length,recordCount);assert.deepEqual(readFileSync(one.path),original);
    assert.equal(existsSync(join(f.workspace,'out/report.v2.'+format)),false);
    f.ops.close();f.ops=new Operations({home:f.home,workspace:f.workspace});f.recreate();
    assert.deepEqual(await f.generator.generate(req,{id:'revise-'+format}),result);
    const stored=f.ops.get(result.proposal.id);
    assert.deepEqual(stored.claims,one.claims);assert.deepEqual(stored.sources,one.sources);assert.deepEqual(stored.baseVersion,one.version);
    assert.equal(hash(JSON.stringify(stored.spec)),stored.editableSpecSha256);
    assert.equal(hash(JSON.stringify(printableResearchSpec(stored.spec,stored.claims))),stored.specSha256);
    assert.deepEqual(stored.spec.blocks,[...draft.blocks,{type:'paragraph',text:'SECOND-EDITION-CONTENT'}]);
    const read=projectId=>readDocumentProposal({ops:f.ops,projectId,id:stored.id});
    assert.deepEqual(read('project-a'),result.proposal);assert.throws(()=>read('project-b'),/document_proposal_not_found/);
    const research=await f.generator.generate({action:'revise',artifactId:one.id,patch:{claimEdits:[{op:'replace',index:1,
      claim:{kind:'inference',claim:'待复查',citations:[]}}]}},{id:'research-revise-'+format});
    assert.equal(research.phase,'proposed',research.error);
    const citations=readDocumentProposal({ops:f.ops,projectId:'project-a',id:research.proposal.id}).changes.find(c=>c.kind==='citations');
    assert.deepEqual(citations.before,one.claims[0].citations);assert.deepEqual(citations.after,[]);assert.equal(citations.claim,1);
    assert.deepEqual(f.ops.get(research.proposal.id).claims,[{kind:'inference',claim:'待复查',citations:[]}]);
  }
});

test('revision stops on manual edits before dispatch and during proposal preparation',async t=>{
  for(const when of ['before','preparing']){
    const f=fixture(t),{artifact}=await f.generator.generate(f.input,{id:'root'});
    const change=()=>writeFileSync(artifact.path,'Manually edited by the user.');
    if(when==='before')change();
    const pending=f.generator.generate({action:'revise',path:artifact.path,patch:{title:'新版'}},{id:'revision'});
    if(when==='preparing')queueMicrotask(change);
    const r=await pending;
    assert.equal(r.error,'document_revision_source_changed');assert.equal(r.status,'failed');
    assert.equal(f.calls.length,1);assert.equal(f.ops.list('document_proposal').length,0);assert.equal(readFileSync(artifact.path,'utf8'),'Manually edited by the user.');
    assert.equal(f.ops.list('document_artifact').length,1);assert.equal(existsSync(join(f.workspace,'out/result.v2.pdf')),false);assert.equal(f.noStaging(),true);
  }
});

test('legacy research editions can reuse verified evidence while an invalid claim edit cannot be published',async t=>{
  const f=fixture(t),claim={kind:'open_question',claim:'还缺哪些数据？',citations:[]};
  f.save('spec.json',JSON.stringify({...spec(),claims:[claim]}));const {artifact:a}=await f.generator.generate(f.input,{id:'legacy'});
  const legacy=f.ops.get(a.id);delete legacy.editableSpecSnapshotPath;delete legacy.editableSpecSha256;delete legacy.revision;delete legacy.rootArtifactId;
  f.ops.put(legacy);rmSync(a.editableSpecSnapshotPath);rmSync(f.specPath);
  const failed=await f.generator.generate({action:'revise',artifactId:a.id,patch:{claimEdits:[{op:'replace',index:1,
    claim:{kind:'fact',claim:'未经核实',citations:[{readId:'unknown',page:1,quote:'猜测'}]}}]}},{id:'invalid-claim'});
  assert.equal(failed.error,'unknown_evidence_read');assert.equal(f.calls.length,1);
  const valid=await f.generator.generate({action:'revise',artifactId:a.id,patch:{edits:[{op:'replace',index:1,block:{type:'paragraph',text:'Updated content'}}]}},{id:'legacy-edit'});
  assert.equal(valid.phase,'proposed',valid.error);assert.equal(valid.proposal.baseRevision,1);
  const stored=f.ops.get(valid.proposal.id);assert.deepEqual(stored.claims,[claim]);
  const exported=printableResearchSpec(stored.spec,stored.claims);assert.equal(exported.blocks.filter(b=>b.text==='关键结论与出处').length,1);
});

test('a real 60-row PDF table exposes tail rows and previews just the verified detail and summary cells', {skip:process.platform!=='darwin',timeout:90000},async t=>{
  const f=fixture(t,{run:runDocumentGenerator}),rows=Array.from({length:60},(_,k)=>['R'+(k+1),String(k+1)]);
  f.save('spec.json',JSON.stringify({...spec(),blocks:[{type:'table',columns:['编号','数量'],rows,summary:['合计','1830']}]}));
  const tool=createDocumentGenerateTool({generator:f.generator,getRequest:()=>f.state.active});
  for(const key of ['tableBlock','startRow','rowLimit'])assert.equal(tool[2][key].type,'integer');
  assert.ok(tool[2].patch.properties.edits.items.properties.op.enum.includes('setSummaryCell'));
  const run=(input,id)=>tool[3](input,{callId:id,signal:f.controller.signal});
  const {artifact}=await run(f.input,'create');
  const inspect={action:'inspect',artifactId:artifact.id,tableBlock:1};
  const initial=(await run({...inspect,startRow:55,rowLimit:2},'first-window')).inspection.table;
  assert.equal(initial.rowCount,60);assert.equal(initial.nextRow,57);assert.deepEqual(initial.rows.map(r=>r.row),[55,56]);
  const tail=(await run({...inspect,startRow:60},'last-row')).inspection.table;
  assert.deepEqual(tail.rows,[{row:60,cells:['R60','60']}]);assert.equal(tail.nextRow,undefined);assert.deepEqual(tail.summary,['合计','1830']);
  assert.equal((await run({...inspect,startRow:61},'range')).error,'invalid_document_table_window');
  const edits=[{op:'setCell',index:1,row:60,column:2,expectedValue:'60',value:'75'},{op:'setSummaryCell',index:1,column:2,expectedValue:'1830',value:'1845'}];
  const req={action:'revise',artifactId:artifact.id,patch:{edits}};
  const mismatch=await run({...req,patch:{edits:[edits[0],{...edits[1],expectedValue:'999'}]}},'reject');
  assert.equal(mismatch.error,'document_revision_cell_value_mismatch');assert.equal(f.calls.length,1);
  const revised=await run(req,'revise');assert.equal(revised.phase,'proposed',revised.error);
  assert.deepEqual(revised.proposal.changes.map(c=>[c.kind,c.block,c.row,c.column,c.columnName,c.before,c.after]),[
    ['cell',1,60,2,'数量','60','75'],['summaryCell',1,undefined,2,'数量','1830','1845']]);
  const saved=f.ops.get(revised.proposal.id).spec.blocks[0];
  assert.deepEqual(saved.rows.slice(0,59),rows.slice(0,59));assert.deepEqual(saved.rows[59],['R60','75']);assert.deepEqual(saved.summary,['合计','1845']);
  const body=execFileSync('/usr/bin/swift',['-e','import PDFKit; let p=PDFDocument(url:URL(fileURLWithPath:CommandLine.arguments[1]))!; print(p.pageCount); print(p.string!)',artifact.path],{encoding:'utf8'});
  assert.ok(Number(body.split('\n')[0])>1);assert.match(body,/R60\s*60/);assert.match(body,/合计\s*1830/);assert.equal(hash(readFileSync(artifact.path)),artifact.sha256);
  assert.equal(revised.artifact,undefined);assert.equal(f.calls.length,1);assert.equal(f.ops.list('document_artifact').length,1);
});

test('a large normalized comparison is bounded in history and fully readable from its project after a restart',async t=>{
  const f=fixture(t),blocks=Array.from({length:30},(_,i)=>({type:'paragraph',text:'old '+i}));
  f.save('spec.json',JSON.stringify({...spec(),blocks}));const {artifact}=await f.generator.generate(f.input,{id:'base'});
  const long='中文段落'.repeat(200),edits=blocks.map((_,i)=>({op:'replace',index:i+1,block:{type:'paragraph',text:long+'\r\n'+i}}));
  const input={action:'revise',path:artifact.path,patch:{edits}},result=await f.generator.generate(input,{id:'wide'});
  assert.equal(result.phase,'proposed',result.error);assert.equal(result.proposal.changeCount,30);assert.equal(result.proposal.truncated,true);
  assert.ok(result.proposal.changes.length<30);assert.ok(result.proposal.changes[0].truncated);
  assert.ok(!JSON.stringify(result).includes(long));assert.ok(Buffer.byteLength(JSON.stringify(result))<14000);
  const recovered=f.ops.get('wide');delete recovered.proposal;f.ops.put({...recovered,status:'interrupted',phase:'preparing'});
  f.ops.close();f.ops=new Operations({home:f.home,workspace:f.workspace});f.recreate();
  const replay=await f.generator.generate(input,{id:'wide'});assert.equal(replay.recovered,true);assert.deepEqual(replay.proposal,result.proposal);
  const full=readDocumentProposal({ops:f.ops,projectId:'project-a',id:replay.proposal.id});assert.equal(full.truncated,false);
  assert.equal(full.changes[29].before,'old 29');assert.equal(full.changes[29].after,long+'\n29');
  assert.equal(f.ops.list('document_proposal').length,1);assert.equal(f.ops.list('document_artifact').length,1);assert.equal(f.calls.length,1);
});

test('proposal locations follow structural edits and repeated cells compare the normalized final result',async t=>{
  const f=fixture(t),block={type:'table',columns:['值'],rows:[['A']]};
  f.save('spec.json',JSON.stringify({...spec(),subtitle:'副标',blocks:[{type:'paragraph',text:'移除'},block]}));
  const {artifact}=await f.generator.generate(f.input,{id:'base'});
  const patch={subtitle:null,layout:{footer:false},edits:[
    {op:'remove',index:1},{op:'insert',index:2,block:{type:'list',ordered:false,items:['新增']}},
    {op:'setCell',index:1,row:1,column:1,value:'B'},{op:'setCell',index:1,row:1,column:1,value:'最终\r值'}]};
  const result=await f.generator.generate({action:'revise',artifactId:artifact.id,patch},{id:'structural'});
  assert.equal(result.phase,'proposed',result.error);
  const changes=result.proposal.changes,c=changes.find(c=>c.kind==='cell');
  assert.equal(c.baseBlock,2);assert.equal(c.afterBlock,1);assert.equal(c.before,'A');assert.equal(c.after,'最终\n值');
  assert.ok(changes.some(c=>c.before==='副标'&&c.after===null));assert.ok(changes.some(c=>c.before===true&&c.after===false));
  assert.ok(changes.some(c=>c.before?.text==='移除'&&c.after===null));assert.ok(changes.some(c=>c.before===null&&c.after?.type==='list'));
  assert.equal(f.calls.length,1);assert.equal(changes.length,5);
  const equiv=await f.generator.generate({action:'revise',artifactId:artifact.id,patch:{edits:[
    {op:'remove',index:1},{op:'insert',index:1,block:{type:'paragraph',text:'移除'}},{op:'setCell',index:2,row:1,column:1,value:'Z'}
  ]}},{id:'equivalent-block'});
  assert.deepEqual(equiv.proposal.changes.map(c=>[c.kind,c.before,c.after]),[['cell','A','Z']]);
});

test('a completed legacy publication replays its original receipt without creating a proposal',async t=>{
  const f=fixture(t),input={action:'revise',path:'report.pdf',patch:{title:'原有调用'}};
  const inputFingerprint=JSON.stringify({input,requestId:'request-a',projectId:'project-a',cwd:f.workspace});
  const old=f.ops.put({kind:'tool',id:'historical-call',operation:'document_generate',action:'revise',requestId:'request-a',projectId:'project-a',
    status:'completed',phase:'committed',inputFingerprint,artifact:{id:'historical-artifact',revision:2,path:'report.v2.pdf'}});
  assert.deepEqual(await f.generator.generate(input,{id:old.id}),old);
  await assert.rejects(f.generator.generate({...input,patch:{title:'其他改动'}},{id:old.id}),/command_id_conflict/);
  assert.equal(f.calls.length,0);assert.equal(f.ops.list('document_proposal').length,0);
});

async function reviewFixture(f,id='review'){
  const {artifact}=await f.generator.generate(f.input,{id:id+'-create'});
  const {proposal}=await f.generator.generate({action:'revise',artifactId:artifact.id,patch:{title:'已确认的数量'}},{id});
  return {artifact,proposal};
}
function nextTurn(f,id){
  const previous=f.state.active;
  f.state.active={...previous,id,binding:{...previous.binding,context:f.context.capture()}};
  delete f.state.active.fileReaderContextIdentity;
}

test('confirm publishes the frozen v2 exactly once, protects the old version and replays after restart',async t=>{
  const f=fixture(t),{artifact,proposal}=await reviewFixture(f),id=proposal.id;
  await assert.rejects(f.generator.decide({id,action:'confirm'}),/document_proposal_followup_required/);
  nextTurn(f,'explicit-confirm');
  const cmd={id:'apply-review'};
  const [applied,repeated]=await Promise.all([f.generator.decide({id,action:'confirm'},cmd),f.generator.decide({id,action:'confirm'},{id:'another-click'})]);
  assert.equal(applied.phase,'committed',applied.error);assert.equal(repeated.artifact.id,applied.artifact.id);
  const v2=applied.artifact;assert.equal(v2.revision,2);assert.equal(v2.parentArtifactId,artifact.id);assert.equal(v2.parentSha256,artifact.sha256);
  assert.equal(v2.path,join(f.workspace,'out/result.v2.pdf'));assert.equal(v2.proposalId,id);
  assert.deepEqual(JSON.parse(readFileSync(v2.editableSpecSnapshotPath)),f.ops.get(id).spec);
  assert.equal(f.calls.length,2);assert.deepEqual(readFileSync(artifact.path),bytes('pdf'));assert.equal(f.ops.list('document_artifact').length,2);
  assert.equal(f.context.capture().file.artifactId,v2.id);
  assert.equal(f.ops.get('review').proposal.status,'applied');
  f.recreate();assert.equal((await f.generator.decide({id,action:'confirm'},cmd)).artifact.id,v2.id);
  const rejected=await f.generator.decide({id,action:'discard'},{id:'too-late'});assert.equal(rejected.error,'document_proposal_closed');
  assert.equal(f.ops.get(id).status,'applied');assert.equal(f.calls.length,2);
});

test('discard is durable, same-id retries are stable, conflicting decisions and project impersonation fail',async t=>{
  const f=fixture(t),{proposal}=await reviewFixture(f),id=proposal.id;
  nextTurn(f,'discard-turn');
  const command={id:'discard-click'},closed=await f.generator.decide({id,action:'discard'},command);
  assert.equal(closed.phase,'discarded',closed.error);assert.equal(f.ops.get('review').proposal.status,'discarded');
  assert.equal((await f.generator.decide({id,action:'confirm'})).error,'document_proposal_closed');
  await assert.rejects(f.generator.decide({id,action:'confirm'},command),/command_id_conflict/);
  f.recreate();assert.deepEqual(await f.generator.decide({id,action:'discard'},command),closed);
  f.state.active.projectId=f.state.active.binding.projectId='other';
  await assert.rejects(f.generator.decide({id,action:'confirm'}),/document_proposal_not_found/);
  assert.equal(f.ops.list('document_artifact').length,1);assert.equal(f.calls.length,1);
});

test('last-moment source removal holds both versions and retrying the conflict always requires fresh approval',async t=>{
  const f=fixture(t),{artifact,proposal}=await reviewFixture(f),id=proposal.id;
  nextTurn(f,'confirm-turn');
  f.onOperation=(type,event)=>{if(type==='operation.updated'&&event.id==='apply-while-edited'&&event.phase==='committing')rmSync(artifact.path);};
  const first=await f.generator.decide({id,action:'confirm'},{id:'apply-while-edited'});
  assert.equal(first.phase,'conflict',first.error);assert.equal(first.proposal.conflict.reason,'document_revision_source_missing');
  assert.equal(first.proposal.conflict.replacementId,undefined);assert.equal(f.ops.get(id).status,'conflict');
  assert.equal(existsSync(join(f.workspace,'out/result.v2.pdf')),false);
  writeFileSync(artifact.path,bytes('pdf'));
  assert.deepEqual(await f.generator.decide({id,action:'confirm'},{id:'apply-while-edited'}),first);
  nextTurn(f,'recheck-turn');
  const newer=await f.generator.decide({id,action:'confirm'},{id:'refresh-after-return'});
  assert.equal(newer.phase,'conflict',newer.error);assert.ok(newer.replacementProposal,newer.proposal?.conflict?.rebaseError);
  assert.equal(newer.replacementProposal.supersedesId,id);assert.equal(newer.replacementProposal.status,'pending');
  assert.equal(f.ops.list('document_artifact').length,1);
  await assert.rejects(f.generator.decide({id:newer.replacementProposal.id,action:'confirm'}),/document_proposal_followup_required/);
  nextTurn(f,'accept-new');
  const last=await f.generator.decide({id:newer.replacementProposal.id,action:'confirm'},{id:'apply-return'});
  assert.equal(last.phase,'committed',last.error);assert.equal(last.artifact.parentSha256,hash(bytes('pdf')));
  assert.equal(f.ops.get(id).status,'conflict');
});

test('modified candidate data and target collisions never publish or change the original',async t=>{
  const f=fixture(t),{artifact,proposal}=await reviewFixture(f),id=proposal.id,privateRow=f.ops.get(id);
  nextTurn(f,'confirm');
  f.ops.put({...privateRow,spec:{...privateRow.spec,title:'different'}});
  const corrupt=await f.generator.decide({id,action:'confirm'},{id:'tamper'});assert.equal(corrupt.error,'document_proposal_invalid');
  f.ops.put(privateRow);
  const collision=join(f.workspace,'out/result.v2.pdf');writeFileSync(collision,'Edited separately');
  const blocked=await f.generator.decide({id,action:'confirm'});assert.equal(blocked.error,'document_target_exists');
  assert.equal(readFileSync(collision,'utf8'),'Edited separately');assert.equal(f.ops.get(id).status,'pending');
  assert.equal(f.ops.list('document_artifact').length,1);assert.equal(hash(readFileSync(artifact.path)),artifact.sha256);
});

test('confirmed publication reconciles on restart after the link when proposal bookkeeping fails',async t=>{
  const f=fixture(t),{proposal}=await reviewFixture(f),id=proposal.id;nextTurn(f,'confirm');
  const put=f.ops.put.bind(f.ops);let fail=true;
  f.ops.put=row=>{
    if(fail&&row.kind==='document_proposal'&&row.status==='applied')throw Error('injected_post_link_error');
    return put(row);
  };
  const result=await f.generator.decide({id,action:'confirm'},{id:'apply-recover'});
  assert.equal(result.phase,'committed',result.error);assert.equal(result.warning,'document_saved_bookkeeping_incomplete');
  const v2=result.artifact.path,sha=hash(readFileSync(v2));assert.equal(f.ops.get(id).status,'pending');
  fail=false;f.recreate();const recovered=f.ops.get('apply-recover');assert.equal(recovered.recovered,true);
  assert.equal(f.ops.get(id).status,'applied');assert.equal(f.ops.get('review').proposal.status,'applied');
  assert.equal((await f.generator.decide({id,action:'confirm'},{id:'click-after-restart'})).artifact.path,v2);
  assert.equal(hash(readFileSync(v2)),sha);assert.equal(f.ops.list('document_artifact').length,2);assert.equal(f.calls.length,2);
});

test('manual Word editing keeps the user text and amended total through a newly reviewed edition',async t=>{
  const f=fixture(t,{run:runDocumentGenerator});
  const seed={schemaVersion:1,title:'物资清单',blocks:[
    {type:'paragraph',text:'使用说明初稿'},
    {type:'table',columns:['编号','数量'],rows:[['01','1'],['02','2'],['03','3']],summary:['合计','6']},
  ]};
  f.save('spec.json',JSON.stringify(seed));
  const v1=(await f.generator.generate({format:'docx',specPath:f.specPath,outputPath:'out/物资清单.docx'})).artifact;
  const first=await f.generator.generate({action:'revise',artifactId:v1.id,patch:{edits:[
    {op:'setCell',index:2,row:3,column:2,value:'8'},{op:'setSummaryCell',index:2,column:2,value:'11'},
  ]}});
  const rewrite=`import sys,io,zipfile
from pathlib import Path
p=Path(sys.argv[1]); source=zipfile.ZipFile(io.BytesIO(p.read_bytes()))
with zipfile.ZipFile(p,'w') as out:
 for item in source.infolist():
  b=source.read(item)
  if item.filename=='word/document.xml':
   b=b.replace('使用说明初稿'.encode(),'使用说明手改'.encode()).replace(b'>1</w:t>',b'>4</w:t>').replace(b'>6</w:t>',b'>9</w:t>')
  out.writestr(item,b)`;
  execFileSync('python3',['-I','-c',rewrite,v1.path]);
  const manualHash=hash(readFileSync(v1.path));
  const id=first.proposal.id;nextTurn(f,'confirm-initial');
  const changed=await f.generator.decide({id,action:'confirm'},{id:'word-conflict'});
  assert.equal(changed.phase,'conflict',changed.error);
  assert.ok(changed.replacementProposal,JSON.stringify(changed.proposal.conflict));
  const redo=changed.replacementProposal;
  assert.deepEqual(redo.changes.map(c=>[c.before,c.after]),[['3','8'],['9','14']]);
  assert.equal(redo.baseSha256,manualHash);assert.equal(f.ops.list('document_artifact').length,1);
  nextTurn(f,'explicit-reconfirm');
  const second=await f.generator.decide({id:redo.id,action:'confirm'},{id:'word-publish'});
  assert.equal(second.phase,'committed',second.error);assert.equal(second.artifact.revision,2);
  assert.equal(second.artifact.parentSha256,manualHash);assert.equal(hash(readFileSync(second.artifact.parentSnapshotPath)),manualHash);
  const xml=execFileSync('python3',['-I','-c','from zipfile import ZipFile;import sys;print(ZipFile(sys.argv[1]).read("word/document.xml").decode())',second.artifact.path],{encoding:'utf8'});
  assert.match(xml,/使用说明手改/);assert.match(xml,/>4<\/w:t>/);assert.match(xml,/>8<\/w:t>/);assert.match(xml,/>14<\/w:t>/);
  assert.equal(hash(readFileSync(v1.path)),manualHash);assert.equal(hash(readFileSync(v1.snapshotPath)),v1.sha256);
});

test('phase-one proposals with no lifecycle fingerprint or patch remain confirmable after restart',async t=>{
  const f=fixture(t),{proposal}=await reviewFixture(f);
  const row=f.ops.get(proposal.id);delete row.fingerprint;delete row.patch;f.ops.put(row);f.recreate();nextTurn(f,'approve-older-review');
  const result=await f.generator.decide({id:row.id,action:'confirm'},{id:'confirm-old'});
  assert.equal(result.phase,'committed',result.error);assert.equal(result.artifact.revision,2);
  assert.deepEqual(JSON.parse(readFileSync(result.artifact.editableSpecSnapshotPath)),row.spec);
});

test('same command can resume an interrupted pre-publication render only on an explicit retry',async t=>{
  const f=fixture(t),{proposal}=await reviewFixture(f);
  nextTurn(f,'retry-interrupted');const id='interrupted-decision',input={id:proposal.id,action:'confirm'};
  f.ops.put({id,kind:'tool',operation:'document_proposal_decide',action:'confirm',projectId:'project-a',requestId:f.state.active.id,
    proposalId:proposal.id,inputFingerprint:JSON.stringify({input,projectId:'project-a',cwd:f.workspace}),status:'running',phase:'generating'});
  f.ops.put({...f.ops.get(proposal.id),applyingOperationId:id});
  f.recreate();assert.equal(f.ops.get(id).status,'interrupted');assert.equal(f.ops.get(proposal.id).applyingOperationId,undefined);
  assert.equal(f.ops.list('document_artifact').length,1);
  const r=await f.generator.decide(input,{id});assert.equal(r.phase,'committed',r.error);assert.equal(r.attempt,1);
  assert.equal(r.artifact.revision,2);assert.equal(f.ops.list('document_artifact').length,2);
});
