import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Operations} from '../operations.mjs';
import {TaskManager,taskTools} from '../tasks/manager.mjs';

async function until(fn,ms=12000){const end=Date.now()+ms;while(Date.now()<end){const result=fn();if(result)return result;await delay(25);}throw Error('condition timed out');}
function fixture(t,{running=false}={}){
  const home=mkdtempSync(join(tmpdir(),'nova-task-closure-')),workspace=join(home,'project'),ops=new Operations({home,workspace}),tasks=new TaskManager({ops,home,workspace});
  if(!running){clearInterval(tasks.timer);tasks.foregroundBusy=()=>true;}
  t.after(async()=>{await tasks.close();ops.close();rmSync(home,{recursive:true,force:true});});
  function record(id,patch={},jobPatch={}){
    const task={id,title:id,runId:id+'-run',status:'failed',createdAt:1,updatedAt:1,artifacts:[],cwd:workspace,unread:true,...patch};
    tasks.put('task',task);tasks.put('run',{id:task.runId,taskId:id,jobId:task.runId+'-job',number:1,status:task.status,createdAt:1});
    tasks.put('job',{id:task.runId+'-job',taskId:id,runId:task.runId,status:task.status,kind:task.kind??'command',exitCode:7,cleanupConfirmed:true,...jobPatch});return task;
  }
  const close=(task,actionId='close-'+task.id)=>tasks.closeTask({id:task.id,runId:task.runId,actionId});
  return {tasks,ops,home,workspace,record,close};
}

test('closing a failed legacy check preserves execution and its parent, hides it only after cleanup',t=>{
  const f=fixture(t),parent=f.record('parent'),check=f.record('check',{parentTaskId:parent.id,parentRunId:parent.runId});
  const before=f.tasks.detail(check.id),closed=f.close(check);
  assert.equal(closed.task.closure.status,'closed');assert.equal(closed.task.closure.assignmentVersion,1);
  assert.equal(closed.task.status,'failed');assert.equal(closed.task.exitCode,7);assert.equal(closed.task.cleanupConfirmed,true);
  assert.deepEqual(closed.runs,before.runs);assert.deepEqual(f.tasks.row('task',parent.id),parent);
  assert.equal(closed.task.canClose,false);assert.equal(closed.task.canReopen,true);assert.equal(closed.task.canRetry,false);
  assert.deepEqual(f.tasks.list({filter:'attention'}).tasks.map(x=>x.id),[parent.id]);
  assert.deepEqual(f.tasks.list({filter:'closed'}).tasks.map(x=>x.id),[check.id]);
  const list=taskTools(f.tasks,()=>({id:'turn'})).find(tool=>tool[0]==='background_task_list');
  assert.ok(list[2].filter.enum.includes('closed'));assert.equal(list[3]({filter:'closed'}).tasks[0].id,check.id);
});

test('durable action IDs cannot re-close restored work or override another action or Run',async t=>{
  const f=fixture(t),task=f.record('retryable'),close={id:task.id,runId:task.runId,actionId:'close-once',reason:'不需要了'};
  const first=f.tasks.closeTask(close);assert.deepEqual(f.tasks.closeTask(close),first);
  const restored=f.tasks.reopenTask({id:task.id,runId:task.runId,actionId:'restore-once'});
  assert.equal(restored.task.closure,undefined);assert.equal(restored.task.status,'failed');assert.equal(restored.task.canRetry,true);
  assert.equal(restored.task.automationPaused,true);assert.equal(restored.task.management.paused,true);assert.equal(restored.runs.length,1);
  assert.equal(f.tasks.closeTask(close).task.closure,undefined,'old acknowledged close is a no-op after restore');
  assert.throws(()=>f.tasks.closeTask({...close,reason:'different'}),/task_id_conflict/);
  assert.throws(()=>f.tasks.closeTask({...close,actionId:'stale-owner',assignmentVersion:2}),/task_assignment_changed/);
  assert.throws(()=>f.tasks.closeTask({...close,actionId:'stale-run',runId:'another-run'}),/task_run_changed/);
  await f.tasks.close();
  const restarted=new TaskManager(f);clearInterval(restarted.timer);restarted.foregroundBusy=()=>true;
  try{
    assert.equal(restarted.closeTask(close).task.closure,undefined,'action audit survives restart');
    const second=restarted.closeTask({...close,actionId:'close-again'});
    assert.equal(second.task.closure.status,'closed');
    assert.equal(restarted.reopenTask({id:task.id,runId:task.runId,actionId:'restore-once'}).task.closure.status,'closed','old restore cannot undo a later close');
  }finally{await restarted.close();}
});

test('closure waits for every related cleanup receipt and worker exit, then survives restart',async t=>{
  const f=fixture(t),parent=f.record('employee',{kind:'agent',status:'waiting_input',management:{enabled:true,paused:false}});
  const check=f.record('check',{parentTaskId:parent.id,status:'interrupted'},{cleanupConfirmed:false});
  const review=f.record('review',{kind:'agent',status:'queued',managementReview:{targetTaskId:parent.id}});
  f.tasks.workers.set(check.runId+'-job',{connected:false});
  const pending=f.close(parent);assert.equal(pending.task.closure.status,'closing');assert.equal(pending.task.status,'cancelled');
  assert.equal(f.tasks.detail(review.id).task.status,'cancelled');
  assert.ok(f.tasks.list({filter:'attention'}).tasks.some(x=>x.id===parent.id),'closing remains visible');
  assert.throws(()=>f.tasks.reopenTask({id:parent.id,runId:parent.runId,actionId:'too-early'}),/task_reopen_unavailable/);
  assert.throws(()=>f.tasks.continue({id:parent.id,runId:parent.runId,actionId:'resume'}),/task_closed/);
  assert.throws(()=>f.tasks.message({id:parent.id,messageId:'message',text:'continue'}),/task_closed/);
  assert.throws(()=>f.tasks.newRun({...parent,closure:undefined},2),/task_closed/);
  f.tasks.put('job',{...f.tasks.row('job',check.runId+'-job'),cleanupConfirmed:true});f.tasks.closures.tick();
  assert.equal(f.tasks.detail(parent.id).task.closure.status,'closing','a receipt alone does not mean the worker exited');
  f.tasks.workers.delete(check.runId+'-job');
  // Simulate the receipt being unconfirmed again before a host restart.
  f.tasks.put('job',{...f.tasks.row('job',check.runId+'-job'),cleanupConfirmed:false});await f.tasks.close();
  const restarted=new TaskManager(f);clearInterval(restarted.timer);restarted.foregroundBusy=()=>true;
  try{
    restarted.tick();assert.equal(restarted.detail(parent.id).task.closure.status,'closing');
    const job=restarted.row('job',check.runId+'-job'),dir=restarted.directory(job);mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,'result.json'),JSON.stringify({jobId:job.id,runId:check.runId,status:'interrupted',cleanupConfirmed:true}));
    restarted.tick();assert.equal(restarted.lastError,null);assert.equal(restarted.detail(parent.id).task.closure.status,'closed');
    assert.equal(restarted.detail(parent.id).runs.length,1);assert.equal(restarted.detail(check.id).task.status,'interrupted');
    assert.throws(()=>restarted.retry({id:check.id,runId:check.runId,actionId:'retry-child'}),/task_closed/);
  }finally{await restarted.close();}
});

test('worker completion cannot erase a close requested after it captured the task',t=>{
  const f=fixture(t),stale=f.record('racing',{status:'running'},{cleanupConfirmed:false});
  f.close(stale);const run=f.tasks.row('run',stale.runId),job=f.tasks.row('job',run.jobId);
  f.tasks.finish(stale,run,job,{status:'failed',exitCode:1,cleanupConfirmed:true});f.tasks.closures.tick();
  const result=f.tasks.detail(stale.id);assert.equal(result.task.closure.status,'closed');assert.equal(result.task.status,'cancelled');
  assert.equal(result.task.automationPaused,true);assert.equal(result.task.management.paused,true);
});

test('unconfirmed historical Run cleanup keeps closure visible without rewriting outcomes',t=>{
  const f=fixture(t),old=f.record('history',{}, {cleanupConfirmed:false}),current=f.record('history',{runId:'history-current',status:'completed'},{exitCode:0});
  const before=f.tasks.row('run',old.runId),pending=f.close(current);
  assert.equal(pending.task.closure.status,'closing');assert.equal(pending.task.status,'completed');
  const job=f.tasks.row('job',old.runId+'-job'),directory=f.tasks.directory(job);mkdirSync(directory,{recursive:true});
  writeFileSync(join(directory,'result.json'),JSON.stringify({jobId:'foreign',runId:old.runId,status:'failed',cleanupConfirmed:true}));
  f.tasks.closures.tick();assert.equal(f.tasks.detail(current.id).task.closure.status,'closing');
  writeFileSync(join(directory,'result.json'),JSON.stringify({jobId:job.id,runId:old.runId,status:'cancelled',cleanupConfirmed:true}));
  f.tasks.closures.tick();const done=f.tasks.detail(current.id);
  assert.equal(done.task.closure.status,'closed');assert.equal(done.task.status,'completed');assert.equal(done.task.exitCode,0);
  assert.deepEqual(f.tasks.row('run',old.runId),before);assert.equal(f.tasks.row('job',job.id).status,'failed');
  assert.equal(f.tasks.row('job',job.id).cleanupConfirmed,true);
});

test('closing a parent blocks all child mutations, preserving independent child history',t=>{
  const f=fixture(t),parent=f.record('parent'),child=f.record('child',{parentTaskId:parent.id}),grandchild=f.record('grandchild',{parentTaskId:child.id});
  f.close(parent);
  for(const task of [child,grandchild]){
    const detail=f.tasks.detail(task.id);assert.equal(detail.task.closure,undefined);assert.equal(detail.task.status,'failed');
    assert.deepEqual(detail.task.parentClosure,{id:parent.id,title:parent.title,status:'closed'});
    assert.equal(detail.task.canRetry,false);assert.equal(detail.task.canClose,false);
    assert.throws(()=>f.tasks.retry({id:task.id,runId:task.runId,actionId:'retry-'+task.id}),/task_closed/);
    assert.throws(()=>f.close(task),/task_closed/);
    for(const method of ['review','configureManagement','reassign','setDependencies','automationPause'])assert.throws(()=>f.tasks[method]({id:task.id,runId:task.runId}),/task_closed/);
    assert.throws(()=>f.tasks.ruleCreate({taskId:task.id}),/task_closed/);
  }
  f.tasks.reopenTask({id:parent.id,runId:parent.runId,actionId:'restore-parent'});
  assert.equal(f.tasks.detail(child.id).task.canRetry,true);assert.equal(f.tasks.detail(child.id).task.parentClosure,undefined);
  assert.equal(f.tasks.detail(child.id).task.automationPaused,true);
});

test('running close cleans process descendants; a queued closed command never starts',{timeout:20000},async t=>{
  const f=fixture(t,{running:true}),quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  const command=quote(process.execPath)+' -e '+quote("const {spawn}=require('child_process');spawn(process.execPath,['-e',\"setTimeout(()=>require('fs').writeFileSync('late','bad'),1800)\"],{stdio:'inherit'});console.log('started');setInterval(()=>{},1000)");
  const running=f.tasks.create({id:'running',title:'active',command});
  await until(()=>f.tasks.log({id:'running'}).text.includes('started'));
  const queued=f.tasks.create({id:'queued',title:'queued',command:'touch never'});f.close(queued.task);
  assert.equal(f.tasks.detail('queued').task.closure.status,'closed');assert.equal(f.tasks.detail('queued').task.status,'cancelled');
  const closing=f.close(running.task);assert.equal(closing.task.closure.status,'closing');
  const done=await until(()=>{const d=f.tasks.detail('running');return d.task.closure.status==='closed'&&d;});
  assert.equal(done.task.status,'cancelled');assert.equal(done.task.cleanupConfirmed,true);assert.equal(f.tasks.workers.size,0);
  await delay(1900);assert.equal(existsSync(join(f.workspace,'late')),false);assert.equal(existsSync(join(f.workspace,'never')),false);
});
