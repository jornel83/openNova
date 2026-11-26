import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Operations} from '../operations.mjs';
import {TaskManager} from '../tasks/manager.mjs';
import {researchCheckpoints} from '../tasks/research-recovery.mjs';
import {saveJson} from '../tasks/agent-files.mjs';

function fixture(t){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-resume-'))),workspace=join(home,'project');
  mkdirSync(workspace);writeFileSync(join(workspace,'input.txt'),'original research');
  let projectId='A',tasks,ops;
  function start(){
    ops=new Operations({home,workspace});
    tasks=new TaskManager({ops,home,workspace});clearInterval(tasks.timer);
    tasks.foregroundBusy=()=>true;
    tasks.projects={taskBinding:()=>({projectId,cwd:workspace,projectRevision:4}),store:{get:()=>({name:projectId})}};
  }
  function reboot(){tasks.closed=true;ops.close();projectId='B';start();}
  start();t.after(async()=>{await tasks.close();ops.close();rmSync(home,{recursive:true,force:true});});
  function stage(id){
    tasks.create({id,title:id,goal:'Read material',kind:'agent',documentResearch:true,inputFiles:['input.txt'],managementEnabled:false,maxSteps:8,tokenBudget:12000});
    const task=tasks.row('task',id),run=tasks.row('run',task.runId),job=tasks.row('job',run.jobId);
    Object.assign(task,{status:'running'});Object.assign(run,{status:'running',startedAt:Date.now()-500});Object.assign(job,{status:'running',cleanupConfirmed:false});
    for(const [kind,row] of Object.entries({task,run,job}))tasks.put(kind,row);
    const dir=tasks.directory(job);mkdirSync(dir,{recursive:true});return {task,run,job,dir};
  }
  function stopped({dir,run,job}){saveJson(join(dir,'result.json'),{jobId:job.id,runId:run.id,status:'interrupted',finishedAt:Date.now(),cleanupConfirmed:true});}
  return {stage,stopped,reboot,get tasks(){return tasks;},get ops(){return ops;}};
}
test('reboot waits for clean worker exit, preserves input/project and remaining budget, reuses a host commit missed by the worker',t=>{
  const f=fixture(t),first=f.stage('original');
  f.ops.put({id:'published',kind:'tool',operation:'document_generate',status:'completed',projectId:'A',taskId:'original',runId:first.run.id,
    assignmentVersion:first.task.assignmentVersion,artifact:{path:'/project/report.pdf',sha256:'old-version'}});
  saveJson(join(first.dir,'progress.json'),{steps:2,totalTokens:3000});
  f.reboot();f.tasks.tick();assert.equal(f.tasks.detail('original').runs.length,1);
  f.stopped(first);f.tasks.tick();f.tasks.tick();
  const after=f.tasks.detail('original');
  assert.equal(after.task.status,'queued');assert.equal(after.task.projectId,'A');assert.deepEqual(after.task.inputSnapshot,first.task.inputSnapshot);
  assert.equal(after.runs.length,2);const next=after.runs[1];
  assert.equal(next.researchResume.originRunId,first.run.id);assert.equal(next.researchResume.remainingSteps,6);
  assert.equal(next.executionBudget.tokenBudget,9000);assert.ok(next.researchResume.evidence.some(e=>e.id==='published'&&e.sha256==='old-version'));
  f.reboot();f.tasks.tick();assert.equal(f.tasks.detail('original').runs.length,2);
});
test('only safe interrupted work resumes: ambiguous writes, pending questions, pause/cancel and a completed reply are not re-run',t=>{
  const f=fixture(t),bad=f.stage('lost-write'),q=f.stage('question'),stopped=f.stage('paused'),cancel=f.stage('cancelled'),done=f.stage('done');
  saveJson(join(bad.dir,'steps','unfinished.json'),{id:'unfinished',tool:'write',status:'running',arguments:{file_path:'.nova-spec/base.json',content:'{}'}});
  saveJson(join(q.dir,'progress.json'),{waiting:'need more data'});
  f.tasks.pause({id:stopped.task.id,runId:stopped.run.id});f.tasks.cancel(cancel.task.id,cancel.run.id);
  saveJson(join(done.dir,'agent-result.json'),{taskId:done.task.id,runId:done.run.id,status:'completed',text:'Already finished.'});
  for(const work of [bad,q,stopped,cancel,done])f.stopped(work);
  f.reboot();f.tasks.tick();
  for(const [id,status,error] of [['lost-write','interrupted','research_write_outcome_unknown'],['question','interrupted','research_waiting_for_input'],['paused','paused'],['cancelled','cancelled'],['done','completed']]){
    const detail=f.tasks.detail(id);assert.equal(detail.task.status,status);assert.equal(detail.runs.length,1);if(error)assert.equal(detail.task.error,error);
  }
});
test('same research step across process lifetimes returns the original result; an intentional new run is independent',async t=>{
  const home=mkdtempSync(join(tmpdir(),'nova-research-steps-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const base={agentHome:home,taskId:'T',projectId:'A',runId:'original',documentResearch:true,workspaceMode:'documents',inputSnapshot:{version:2}};
  let count=0;const fetch=()=>({value:'page '+ ++count,content:[],isError:false});
  const first=await researchCheckpoints(base)({name:'web_fetch',arguments:{url:'https://example.org',limit:2}},fetch);
  let reused;const second=await researchCheckpoints({...base,runId:'new',researchResume:{originRunId:'original'}})(
    {name:'web_fetch',arguments:{limit:2,url:'https://example.org'}},fetch,run=>{reused=run;});
  assert.deepEqual(second,first);assert.equal(reused,'original');assert.equal(count,1);
  await researchCheckpoints({...base,runId:'explicit-new-goal'})({name:'web_fetch',arguments:{limit:2,url:'https://example.org'}},fetch);
  assert.equal(count,2);
});

test('resuming an already written spec or text delivery checks the actual bytes, including missing and edited files',async t=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-replay-write-')));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const base={agentHome:home,workspace:home,taskId:'T',projectId:'A',runId:'r1',documentResearch:true,workspaceMode:'documents',inputSnapshot:{version:2}};
  mkdirSync(join(home,'.nova-spec'));
  for(const file of ['.nova-spec/summary.json','report.md']){
    const step={name:'write',arguments:{file_path:file,content:'Saved bytes'}},path=join(home,file);
    let writes=0;
    const write=()=>{writes++;writeFileSync(path,step.arguments.content);return {value:'saved',content:[]};};
    await researchCheckpoints(base)(step,write);
    const resumed=researchCheckpoints({...base,runId:'r2',researchResume:{originRunId:'r1'}});
    assert.equal((await resumed(step,write)).value,'saved');
    writeFileSync(path,'Other bytes');
    await assert.rejects(resumed(step,write),/task_document_delivery_changed/);
    rmSync(path);await assert.rejects(resumed(step,write),/task_document_delivery_changed/);
    assert.equal(writes,1);
  }
});
