import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,realpathSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Operations} from '../operations.mjs';
import {freezeDocumentInputs} from '../tasks/frozen-documents.mjs';
import {createTaskDocumentTools,documentDeliveries} from '../tasks/document-tools.mjs';
import {allowedTaskTools} from '../tasks/execution.mjs';
import {saveJson} from '../tasks/agent-files.mjs';
import {TaskManager} from '../tasks/manager.mjs';
import {readFrozenText} from '../tasks/document-tool-contract.mjs';
import {ROOT} from '../../runtime/sources.mjs';

function setup(t,{runner}={}){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-task-doc-tools-'))),source=join(home,'project'),agentHome=join(home,'agent'),workspace=join(agentHome,'workspace');
  let ops=new Operations({home,workspace:source});mkdirSync(join(workspace,'.nova-spec'),{recursive:true});
  t.after(()=>{ops.close();rmSync(home,{recursive:true,force:true});});
  const sourcePath=join(source,'plan.pdf');writeFileSync(sourcePath,'%PDF-1.7\noriginal');
  const inputSnapshot=freezeDocumentInputs({home,source,projectId:'A',inputFiles:['plan.pdf'],currentFile:true,current:{path:sourcePath,projectId:'A'}});
  saveJson(join(agentHome,'workspace.json'),{path:workspace});
  const task={id:'research-A',projectId:'A',assignmentVersion:1,workspaceMode:'documents',permission:'full',policyVersion:2,documentResearch:true,inputSnapshot};
  // macOS /var vs /private/var and user-selected homes may name the same host cache.
  const alias=join(home,'aliased-home');symlinkSync(home,alias,'dir');
  let calls=0;const start=()=>createTaskDocumentTools({home:alias,ops,runner,tasks:{agentHome:()=>agentHome},readNative:async input=>{
    calls++;assert.equal(input.bytes.toString(),'%PDF-1.7\noriginal');return {status:'read',content:'original',limitation:null};
  }});
  let service=start();
  function restart(){ops.close();ops=new Operations({home,workspace:source});service=start();}
  function invoke(name,args,{run='run-1',job=task,runOptions={}}={}){return service.execute({task:job,run:{id:run,...runOptions},name,args,actionId:'step-'+run});}
  return {task,get ops(){return ops;},home,sourcePath,workspace,invoke,restart,calls:()=>calls,agentHome};
}
test('frozen inputs use admission bytes, replay aliases on another run and reject unbound input and unauthorized writes',async t=>{
  const f=setup(t);rmSync(f.sourcePath);writeFileSync(join(f.workspace,'plan.pdf'),'%PDF-1.7\nedited workspace copy');
  const a=await f.invoke('document_read',{current:true,question:'inspect'}),b=await f.invoke('document_read',{path:'plan.pdf',question:'inspect'},{run:'r2'});
  assert.equal(a.status,'completed');assert.equal(a.id,b.id);assert.equal(f.calls(),1);assert.equal(a.source.path,f.sourcePath);
  assert.equal(a.source.sha256,f.task.inputSnapshot.files[0].sha256);assert.equal(f.ops.get(a.id).contextSelected,false);assert.deepEqual(f.ops.list('file'),[]);
  await assert.rejects(f.invoke('document_read',{path:'outside.pdf',question:'inspect'}),/not_bound/);
  await assert.rejects(f.invoke('document_generate',{},{job:{...f.task,permission:'read-only'}}),/denied/);
  for(const runOptions of [{summaryRecovery:{}},{managementReview:{}}])await assert.rejects(f.invoke('document_read',{path:'plan.pdf',question:'inspect'},{runOptions}),/denied/);
  const available=allowedTaskTools({...f.task,bridge:{scoped:true}});assert.ok(available.includes('document_generate'));assert.ok(!available.includes('task_command')&&!available.includes('edit'));
});
test('real Word is no-clobber published to the admitted project path, tagged, replayed across Runs and revalidated on replay',async t=>{
  const f=setup(t);f.task.documentOutputPath=join(f.task.inputSnapshot.source,'交付.docx');
  const spec={schemaVersion:1,title:'研究成果',blocks:[{type:'paragraph',text:'fixed edition'}]};
  const path=join(f.workspace,'.nova-spec','final.json');writeFileSync(path,JSON.stringify(spec));
  const args={format:'docx',specPath:'.nova-spec/final.json',outputPath:'交付.docx'};
  await assert.rejects(f.invoke('document_generate',{...args,outputPath:'wrong.docx'}),/invalid_task_document_path/);
  await assert.rejects(f.invoke('document_generate',{...args,specPath:'../private.json'}),/invalid_task_document_path/);
  const a=await f.invoke('document_generate',args);assert.equal(a.status,'completed',JSON.stringify(a));assert.equal(a.artifact.path,f.task.documentOutputPath);assert.ok(existsSync(a.artifact.path));
  const [artifact]=documentDeliveries(f.ops,f.task);assert.equal(artifact.taskId,f.task.id);assert.equal(artifact.runId,'run-1');assert.equal(artifact.projectId,'A');
  assert.equal(f.ops.get(a.id).contextSelected,false);
  assert.deepEqual(documentDeliveries(f.ops,{...f.task,id:'foreign-task'}),[]);assert.deepEqual(f.ops.list('file'),[]);
  assert.equal((await f.invoke('document_generate',args,{run:'r2'})).id,a.id);
  writeFileSync(path,JSON.stringify({...spec,title:'not the same spec'}));await assert.rejects(f.invoke('document_generate',args,{run:'r2'}),/command_id_conflict/);
  writeFileSync(path,JSON.stringify(spec));writeFileSync(a.artifact.path,'manual edit');await assert.rejects(f.invoke('document_generate',args,{run:'r3'}),/task_document_delivery_changed/);
  assert.equal(readFileSync(a.artifact.path,'utf8'),'manual edit');
});

test('a corrected task spec can publish once to the original destination after a pre-generation validation failure',async t=>{
  const f=setup(t);
  const args={format:'docx',specPath:'.nova-spec/report.json',outputPath:'report.docx'};
  const path=join(f.workspace,args.specPath),output=join(f.workspace,args.outputPath);
  const spec={schemaVersion:1,title:'选型说明',blocks:[{type:'paragraph',text:'采用 Maple'}]};
  writeFileSync(path,JSON.stringify({...spec,claims:[{claim:'选择已登记'}]}));
  const failure=await f.invoke('document_generate',args);
  assert.equal(failure.error,'invalid_evidence_claims');
  assert.equal(failure.status,'failed');
  assert.equal(f.ops.get(failure.id).phase,'not_committed');
  assert.equal(existsSync(output),false);
  f.restart();
  assert.equal((await f.invoke('document_generate',args,{run:'r2'})).id,failure.id);

  writeFileSync(path,JSON.stringify({...spec,schemaVersion:2}));
  const secondFailure=await f.invoke('document_generate',args,{run:'r2'});
  assert.equal(secondFailure.error,'invalid_document_spec');
  assert.notEqual(secondFailure.id,failure.id);
  writeFileSync(path,JSON.stringify(spec));
  const results=await Promise.all([f.invoke('document_generate',args),f.invoke('document_generate',args)]);
  assert.equal(results[0].status,'completed');
  assert.equal(results[1].id,results[0].id);
  assert.equal(results[0].artifact.path,output);
  assert.equal(documentDeliveries(f.ops,f.task).length,1);
  f.restart();
  assert.equal((await f.invoke('document_generate',args,{run:'r3'})).id,results[0].id);
  assert.equal(f.ops.get(failure.id).error,'invalid_evidence_claims');
  assert.equal(f.ops.get(secondFailure.id).error,'invalid_document_spec');
  writeFileSync(path,JSON.stringify({...spec,title:'another publication'}));
  await assert.rejects(f.invoke('document_generate',args),/command_id_conflict/);
});

test('a correction keeps a manually occupied destination intact',async t=>{
  const f=setup(t);
  const args={format:'docx',specPath:'.nova-spec/draft.json',outputPath:'report.docx'};
  const draft=join(f.workspace,args.specPath),output=join(f.workspace,args.outputPath);
  writeFileSync(draft,'{}');
  assert.equal((await f.invoke('document_generate',args)).error,'invalid_document_spec');
  writeFileSync(output,'manual content');
  writeFileSync(draft,JSON.stringify({schemaVersion:1,title:'补稿',blocks:[{type:'paragraph',text:'修正文本'}]}));
  assert.equal((await f.invoke('document_generate',args)).error,'document_target_exists');
  assert.equal(readFileSync(output,'utf8'),'manual content');
  assert.deepEqual(documentDeliveries(f.ops,f.task),[]);
});

test('concurrent different drafts and failures after executor entry cannot start a new generation',async t=>{
  const started=Promise.withResolvers(),release=Promise.withResolvers();
  let executions=0;
  const f=setup(t,{runner:async()=>{executions++;started.resolve();await release.promise;throw Error('invalid_evidence_claims');}});
  const args={format:'docx',specPath:'.nova-spec/draft.json',outputPath:'report.docx'};
  const draft=join(f.workspace,args.specPath),spec={schemaVersion:1,title:'已修正',blocks:[{type:'paragraph',text:'说明'}]};
  writeFileSync(draft,'{}');
  assert.equal((await f.invoke('document_generate',args)).error,'invalid_document_spec');
  writeFileSync(draft,JSON.stringify(spec));
  const running=f.invoke('document_generate',args);
  try{
    await started.promise;
    writeFileSync(draft,JSON.stringify({...spec,title:'不同的底稿'}));
    await assert.rejects(f.invoke('document_generate',args,{run:'r2'}),/command_id_conflict/);
  }finally{release.resolve();}
  const failure=await running;
  assert.equal(failure.error,'invalid_evidence_claims');
  assert.ok(f.ops.get(failure.id).stagePath);
  f.restart();
  await assert.rejects(f.invoke('document_generate',args,{run:'r3'}),/command_id_conflict/);
  assert.equal(executions,1);
  assert.deepEqual(documentDeliveries(f.ops,f.task),[]);
});

test('read-only text uses immutable bytes with the standard Harness read window even after the source and workspace change',async t=>{
  const f=setup(t),source=f.task.inputSnapshot.source,agentHome=join(f.home,'tasks','agents','worker');
  writeFileSync(join(source,'facts.txt'),'v1-first\nv1-second\n');
  const input=freezeDocumentInputs({home:f.home,source,projectId:'A',inputFiles:['facts.txt']}).files[0];
  rmSync(join(source,'facts.txt'));writeFileSync(join(f.workspace,'facts.txt'),'changed');
  const result=await readFrozenText({harnessRoot:join(ROOT,'engine/harness'),agentHome},input,{file_path:'facts.txt',offset:2,limit:1});
  assert.deepEqual(result.value.lines,[{number:2,text:'v1-second'}]);
  assert.equal(result.value.path,input.sourcePath);assert.equal(result.value.totalLines,2);
});

test('worker prose cannot mark an explicitly requested delivery completed without matching task/project/assignment receipt and file',async t=>{
  const f=setup(t),tasks=new TaskManager({home:f.home,workspace:f.task.inputSnapshot.source,ops:f.ops});
  clearInterval(tasks.timer);tasks.foregroundBusy=()=>true;
  tasks.projects={taskBinding:()=>({projectId:'A',cwd:f.task.inputSnapshot.source,projectRevision:1}),store:{get:()=>({name:'A'})}};
  try{
    for(const field of ['none','taskId','assignmentVersion','projectId','changed']){
      const id='verify-'+field;
      tasks.create({id,title:id,kind:'agent',goal:'交付文档',documentResearch:true,inputFiles:['plan.pdf'],documentOutputPath:id+'.docx',managementEnabled:false});
      const task=tasks.row('task',id),run=tasks.row('run',task.runId),job=tasks.row('job',run.jobId);
      const work=join(tasks.agentHome(task),'workspace');mkdirSync(work,{recursive:true});saveJson(join(tasks.agentHome(task),'workspace.json'),{path:work});
      saveJson(join(tasks.directory(job),'agent-result.json'),{runId:run.id,status:'completed',text:'已生成。'});
      writeFileSync(task.documentOutputPath,'manually created');
      if(field!=='none'){
        const receipt={id:'receipt-'+id,kind:'document_artifact',taskId:id,projectId:'A',assignmentVersion:task.assignmentVersion,path:task.documentOutputPath,size:16,sha256:'0'.repeat(64)};
        if(field!=='changed')receipt[field]=field==='assignmentVersion'?99:'elsewhere';
        f.ops.put(receipt);
      }
      tasks.finish(task,run,job,{status:'completed',cleanupConfirmed:true});
      assert.equal(tasks.row('job',job.id).error,field==='changed'?'task_document_delivery_changed':'task_document_receipt_unavailable');
      assert.equal(tasks.row('task',id).status,'failed');
    }
  }finally{await tasks.close();}
});
