import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {lifecycleHost,alive} from './fixtures/lifecycle-host.mjs';

test('voice close removes failed tasks from attention, preserves evidence, and reopen never retries',{timeout:60000},async t=>{
  const h=await lifecycleHost(t);await h.start();
  for(const id of ['unwanted','keep'])await h.api('/background-task-start',{id,title:id,command:'printf failure; exit 7',managementEnabled:false});
  const before=await h.until(async()=>{const a=await h.api('/background-task',{id:'unwanted'}),b=await h.api('/background-task',{id:'keep'});return a.task.status==='failed'&&b.task.status==='failed'&&{a,b};});
  const args={id:'unwanted',runId:before.a.task.runId,assignmentVersion:before.a.task.assignmentVersion??1};
  await h.foreground('voice-close','background_task_close',args);
  const closed=await h.until(async()=>{const d=await h.api('/background-task',{id:'unwanted'});return d.task.closure?.status==='closed'&&d;});
  assert.equal(closed.task.status,'failed');assert.equal(closed.task.exitCode,7);assert.deepEqual(closed.runs,before.a.runs);
  for(const key of ['current','history','currentReview','reviewHistory'])assert.deepEqual(closed.teamReview[key],before.a.teamReview[key]);
  assert.equal(closed.teamReview.management.paused,true);assert.match((await h.api('/background-task-log',args)).text,/failure/);
  assert.deepEqual((await h.api('/background-tasks',{filter:'attention'})).tasks.map(x=>x.id),['keep']);
  assert.deepEqual((await h.api('/background-tasks',{filter:'closed'})).tasks.map(x=>x.id),['unwanted']);
  assert.deepEqual((await h.api('/background-task',{id:'keep'})).task,before.b.task);
  await h.api('/background-task-retry',{...args,actionId:'forbidden-retry'},400).then(v=>assert.equal(v.error,'task_closed'));
  await h.stop();await h.start();
  assert.equal((await h.api('/background-task',{id:'unwanted'})).task.closure.status,'closed');
  await h.foreground('voice-reopen','background_task_reopen',{id:args.id,runId:args.runId});
  const reopened=await h.api('/background-task',{id:'unwanted'});assert.equal(reopened.task.closure,undefined);assert.equal(reopened.task.status,'failed');assert.equal(reopened.runs.length,1);
  await h.api('/background-task-close',{...args,actionId:closed.task.closure.actionId});
  assert.equal((await h.api('/background-task',{id:'unwanted'})).task.closure,undefined,'old close delivery cannot close a reopened task');
  assert.equal((await h.api('/team-overview')).counts.attention,2);
});

test('closing a live employee command waits for real process cleanup and survives host restart',{timeout:90000},async t=>{
  const h=await lifecycleHost(t);await h.start();const employee=await h.employee();
  await h.foreground('dispatch-close-test','background_agent_start',{title:'关闭实际执行任务',goal:'FIXTURE_COMMAND',assignedBotId:employee.id,managementEnabled:false});
  const task=await h.until(async()=>(await h.api('/background-tasks')).tasks.find(x=>x.requestId==='dispatch-close-test'));
  const live=await h.until(async()=>{const d=await h.api('/background-task',{id:task.id});return d.workspace&&existsSync(join(d.workspace.path,'started'))&&d;});
  const marker=join(live.workspace.path,'started'),pid=Number(readFileSync(marker,'utf8'));assert.equal(alive(pid),true);
  await h.foreground('close-employee','background_task_close',{id:task.id,runId:task.runId,assignmentVersion:task.assignmentVersion});
  const closed=await h.until(async()=>{const d=await h.api('/background-task',{id:task.id});return d.task.closure?.status==='closed'&&d;});
  assert.equal(alive(pid),false);assert.equal(closed.task.cleanupConfirmed,true);assert.equal(closed.task.automationPaused,true);assert.equal(closed.task.management.paused,true);
  assert.equal((await h.api('/background-tasks')).total,0);assert.equal((await h.api('/background-tasks',{filter:'closed'})).total,1);
  await h.stop();await h.start();
  const restored=await h.api('/background-task',{id:task.id});assert.equal(restored.task.closure.status,'closed');assert.equal(restored.runs.length,1);assert.equal(alive(pid),false);
  await h.api('/background-task-reopen',{id:task.id,runId:task.runId,actionId:'reopen-live'});
  const reopened=await h.api('/background-task',{id:task.id});assert.equal(reopened.runs.length,1);assert.equal(reopened.task.status,'cancelled');assert.equal(reopened.task.automationPaused,true);assert.equal(reopened.task.management.paused,true);assert.equal(alive(pid),false);
});
