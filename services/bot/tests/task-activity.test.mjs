import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createTaskActivity,readTaskActivity,taskActivity} from '../tasks/activity.mjs';
import {taskActivityText} from '../web/task-view.mjs';

test('runtime heartbeat is separate from model progress and throttled updates preserve the latest activity',t=>{
  const home=mkdtempSync(join(tmpdir(),'nova-activity-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  let now=1000;const path=join(home,'activity.json'),activity=createTaskActivity({path,taskId:'task',runId:'run',now:()=>now});
  activity.phase('model');now=6000;activity.heartbeat();let record=readTaskActivity(path);
  assert.equal(record.heartbeatAt,6000);assert.equal(record.lastActivityAt,1000);
  now=6100;activity.touch();now=7000;activity.heartbeat();record=readTaskActivity(path);
  assert.equal(record.lastActivityAt,6100);assert.equal(record.since,1000);
  now=8000;activity.phase('tool','read');record=readTaskActivity(path);assert.equal(record.tool,'read');assert.equal(record.since,8000);
  writeFileSync(path,'incomplete');assert.equal(readTaskActivity(path),null,'corrupt optional telemetry must not hide task detail');
  writeFileSync(join(home,'file'),'not a directory');assert.doesNotThrow(()=>createTaskActivity({path:join(home,'file','activity.json'),taskId:'task',runId:'run'}).heartbeat());
  const blocked=join(home,'blocked.json');mkdirSync(blocked);const failing=createTaskActivity({path:blocked,taskId:'task',runId:'run'});
  for(let i=0;i<50;i++)failing.heartbeat();
  assert.equal(readdirSync(home).filter(name=>name.endsWith('.tmp')).length,0,'repeated telemetry rename failures must not leak temporary files');
});

test('long model waits remain running; stale telemetry reports uncertainty without cancelling a task',()=>{
  const task={id:'task',kind:'agent',runId:'run',status:'running'},run={id:'run',status:'running',createdAt:1000,startedAt:2000},job={cleanupConfirmed:false};
  const record={taskId:'task',runId:'run',phase:'model',lastActivityAt:3000,since:3000,heartbeatAt:3600000};
  let activity=taskActivity({task,run,job,record,workerConnected:true,now:3600000});
  assert.equal(activity.phase,'model');assert.equal(activity.lastActivityAt,3000);assert.equal(activity.workerConnected,true);
  assert.match(taskActivityText({...run,activity},3600000),/等待模型响应.*最近活动/);assert.doesNotMatch(taskActivityText({...run,activity},3600000),/失败|超时|中断/);
  activity=taskActivity({task,run,job,record:{...record,heartbeatAt:3000},now:3600000});
  assert.match(taskActivityText({...run,activity},3600000),/尚不能确认执行是否中断/);assert.equal(task.status,'running');
  assert.equal(taskActivity({task,run,job,record:{...record,runId:'foreign'},now:3600000}).phase,'initializing');
  assert.equal(taskActivity({task,run,job,record:{...record,taskId:'foreign'},now:3600000}).phase,'initializing');
});

test('history and terminal states override stale live phases while queue and command logs remain factual',()=>{
  const task={id:'task',kind:'agent',runId:'new'},run={id:'old',status:'completed',createdAt:1000,startedAt:2000,finishedAt:4000},job={cleanupConfirmed:true};
  const record={taskId:'task',runId:'old',phase:'tool',tool:'write',lastActivityAt:3000,heartbeatAt:9000};
  const activity=taskActivity({task,run,job,record,now:10000});assert.equal(activity.phase,'completed');assert.equal(activity.lastActivityAt,4000);assert.equal(activity.tool,undefined);assert.equal(taskActivityText({...run,activity}), '');
  const queued=taskActivity({task,run:{id:'new',createdAt:5000,status:'queued'},job,foregroundBusy:true,now:10000});assert.equal(queued.phase,'waiting_foreground');
  const command=taskActivity({task:{...task,kind:'command'},run:{id:'new',createdAt:5000,startedAt:6000,status:'running'},job,logActivityAt:9000,now:10000});assert.equal(command.phase,'command');assert.equal(command.lastActivityAt,9000);
  const future=taskActivity({task,run:{...run,status:'running'},job,record:{...record,lastActivityAt:20000},now:10000});assert.equal(future.lastActivityAt,2000);
});
