import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TeamWatch,WATCH_DEFAULTS,currentWatchAlertSql} from '../team/watch.mjs';

function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'nova-team-watch-')),path=join(home,'bridge.sqlite'),events=[],changes=[],activity=new Map();
  let db=new DatabaseSync(path),at=2000000000,sequence=0;
  db.exec('PRAGMA journal_mode=WAL');
  for(const table of ['task','run','job'])db.exec(`CREATE TABLE background_${table} (id TEXT PRIMARY KEY,body TEXT NOT NULL)`);
  const tasks={get db(){return db;},closed:false,events:{publish:(type,body)=>events.push({type,body})},
    team:{chiefId:'chief',owner:task=>({assignedBotId:task.assignedBotId??'chief',ownerName:task.assignedBotId??'总管'})},
    row(kind,id){const row=db.prepare(`SELECT body FROM background_${kind} WHERE id=?`).get(id);if(!row)throw Error('unknown_task');return JSON.parse(row.body);},
    put(kind,value){db.prepare(`INSERT INTO background_${kind} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(value.id,JSON.stringify(value));return value;},
    all(){throw Error('watch_must_not_scan_history');},changed:task=>changes.push(task),
    activity(task,run){return activity.get(task.id)??{phase:'model',lastActivityAt:run.startedAt??run.createdAt};},
    newRun(){throw Error('watch_must_not_replay_work');},pause(){throw Error('watch_must_not_stop_work');},cancel(){throw Error('watch_must_not_stop_work');},
  };
  let watch=new TeamWatch({tasks,now:()=>at});
  function add(patch={}){
    const n=++sequence,id=patch.id??'task-'+n,runId=patch.runId??'run-'+n,jobId='job-'+n;
    const task={id,runId,assignmentVersion:1,title:'任务 '+n,kind:'agent',status:'queued',priority:'normal',createdAt:at,updatedAt:at,...patch};
    tasks.put('task',task);tasks.put('run',{id:runId,taskId:id,jobId,status:task.status,createdAt:at,startedAt:task.status==='running'?at:undefined});
    tasks.put('job',{id:jobId,taskId:id,runId,status:task.status});return task;
  }
  t.after(()=>{tasks.closed=true;db.close();rmSync(home,{recursive:true,force:true});});
  return {tasks,events,changes,activity,add,get db(){return db;},get watch(){return watch;},get at(){return at;},
    advance(ms){at+=ms;},set(task,patch){return tasks.put('task',{...tasks.row('task',task.id),...patch});},
    reopen(){db.close();db=new DatabaseSync(path);watch=new TeamWatch({tasks,now:()=>at});return watch;},
    configure(patch){return watch.configure({actionId:'policy-'+(++sequence),revision:watch.policy().revision,...patch});},
  };
}
const ack=alert=>({id:alert.id,taskId:alert.taskId,runId:alert.runId,assignmentVersion:alert.assignmentVersion});
const stored=(f,id)=>JSON.parse(f.db.prepare('SELECT body FROM team_watch_alert WHERE id=?').get(id).body);
const sqlCurrent=f=>f.db.prepare(`SELECT a.id FROM team_watch_alert a JOIN background_task t ON t.id=json_extract(a.body,'$.taskId') WHERE ${currentWatchAlertSql('t','a',':now')}`).all({now:f.at}).map(row=>row.id);

test('deadline reminders transition once, persist across a real database reopen, and retain acknowledgements',t=>{
  const f=fixture(t),task=f.add({dueAt:f.at+10000});
  assert.deepEqual(Object.fromEntries(Object.keys(WATCH_DEFAULTS).map(key=>[key,f.watch.policy()[key]])),WATCH_DEFAULTS);
  f.watch.tick();let alert=f.watch.view().alerts[0];assert.equal(alert.type,'due_soon');assert.equal(f.events.length,1);
  f.watch.acknowledge({...ack(alert),actionId:'seen-near-deadline'});const seen=f.watch.view().alerts[0].acknowledgedAt;
  const before=f.events.length;f.advance(5000);f.watch.tick();f.reopen().tick();
  assert.equal(f.events.length,before,'unchanged observations and restart must not publish again');
  assert.equal(f.watch.view().alerts[0].acknowledgedAt,seen);assert.equal(f.watch.view().unacknowledged,0);
  f.advance(5000);f.watch.tick();const overdue=f.watch.view().alerts[0];
  assert.equal(overdue.type,'overdue');assert.notEqual(overdue.id,alert.id);assert.equal(overdue.acknowledgedAt,null);
  assert.equal(stored(f,alert.id).status,'resolved');assert.equal(f.tasks.row('task',task.id).priority,'normal');
  const alerts=f.db.prepare('SELECT COUNT(*) AS n FROM team_watch_alert').get().n;
  f.advance(10000);f.watch.tick();assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM team_watch_alert').get().n,alerts);
});

test('watch reconciliation is throttled to five seconds without hiding changed bindings in the view',t=>{
  const f=fixture(t),task=f.add({dueAt:f.at});f.watch.tick();const old=f.watch.view().alerts[0];
  f.set(task,{runId:'next-run'});f.advance(4999);f.watch.tick();
  assert.equal(f.events.length,1);assert.equal(f.watch.view().total,0,'stale receipts disappear immediately');
  f.advance(1);f.watch.tick();assert.equal(f.events.length,2);
  const next=f.watch.view().alerts[0];assert.equal(next.runId,'next-run');assert.notEqual(next.id,old.id);assert.equal(stored(f,old.id).status,'resolved');
});

test('closed parent invalidates nested check reminders immediately without rewriting child outcomes',t=>{
  const f=fixture(t),parent=f.add({status:'completed'}),child=f.add({parentTaskId:parent.id,status:'completed'}),check=f.add({parentTaskId:child.id,dueAt:f.at});
  f.watch.tick();const alert=f.watch.view().alerts[0];assert.equal(sqlCurrent(f).length,1);
  f.set(parent,{closure:{status:'closing'}});assert.equal(f.watch.view().total,1,'closing cleanup remains visible');
  f.set(parent,{closure:{status:'closed'}});assert.equal(f.watch.view().total,0);assert.deepEqual(sqlCurrent(f),[]);
  f.watch.tick({force:true});assert.equal(stored(f,alert.id).status,'resolved');assert.equal(f.tasks.row('task',check.id).status,'queued');
});

test('acknowledgement rejects an obsolete run, assignment, deadline or stopped task before reconciliation',t=>{
  for(const patch of [{runId:'new-run'},{assignmentVersion:2},{dueAt:5000000000},{status:'paused'},{status:'cancelled'},{status:'completed'},{closure:{status:'closing'}},{closure:{status:'closed'}}]){
    const f=fixture(t),task=f.add({dueAt:f.at});f.watch.tick();const alert=f.watch.view().alerts[0];
    f.set(task,patch);assert.throws(()=>f.watch.acknowledge(ack(alert)),/watch_alert_stale/);assert.equal(stored(f,alert.id).acknowledgedAt,null);
    assert.deepEqual(sqlCurrent(f),[],'SQL counts must invalidate the same changed binding immediately');
    f.watch.tick({force:true});assert.equal(stored(f,alert.id).status,'resolved');
  }
});

test('acknowledgement is idempotent, validates its binding and cannot reuse an action for another request',t=>{
  const f=fixture(t);f.add({dueAt:f.at});f.watch.tick();const alert=f.watch.view().alerts[0],body={...ack(alert),actionId:'ack-once'};
  assert.throws(()=>f.watch.acknowledge({...body,assignmentVersion:2}),/watch_alert_stale/);
  const first=f.watch.acknowledge(body);f.advance(5000);const count=f.events.length;
  assert.deepEqual(f.watch.acknowledge(body).alerts,first.alerts);assert.equal(f.events.length,count);
  f.watch.acknowledge({...body,actionId:'ack-already-seen'});
  assert.throws(()=>f.watch.acknowledge({...body,actionId:'ack-already-seen',taskId:'different'}),/watch_action_conflict/);
  assert.equal(f.events.length,count,'a second acknowledgement journals its action without another notification');
  assert.throws(()=>f.watch.acknowledge({...body,taskId:'different'}),/watch_action_conflict/);
  assert.throws(()=>f.watch.acknowledge({...body,id:'unknown',actionId:'ack-unknown'}),/unknown_watch_alert/);
  assert.throws(()=>f.watch.acknowledge({...body,assignmentVersion:0}),/invalid_watch_ack/);
});

test('policy updates persist, deduplicate reordered fields and reject stale revisions without changing policy',t=>{
  const f=fixture(t),body={actionId:'configure-once',revision:1,dueSoonMs:60000,raiseQueuedPriority:true};
  const policy=f.watch.configure(body).policy;assert.equal(policy.revision,2);const count=f.events.length;
  assert.deepEqual(f.watch.configure({raiseQueuedPriority:true,dueSoonMs:60000,revision:1,actionId:'configure-once'}).policy,policy);
  assert.equal(f.events.length,count);assert.throws(()=>f.watch.configure({...body,dueSoonMs:0}),/watch_action_conflict/);
  assert.throws(()=>f.watch.configure({...body,actionId:'old-revision'}),/watch_policy_changed/);
  assert.deepEqual(f.reopen().policy(),policy);
  for(const patch of [{enabled:1},{raiseQueuedPriority:'true'},{blockedMs:-1},{inactiveMs:999},{dueSoonMs:Infinity},{dueSoonMs:604800001},{unknown:true}])
    assert.throws(()=>f.configure(patch),/invalid_watch_policy/);
  assert.deepEqual(f.watch.policy(),policy);
});

test('blocked and event waits start from observation, survive restart, and reset when the wait changes',t=>{
  const f=fixture(t);f.configure({blockedMs:1000,dueSoonMs:0,inactiveMs:0});
  const task=f.add({status:'blocked',updatedAt:1,blockedReason:'dependency'});f.watch.tick({force:true});
  assert.equal(f.watch.view().total,0,'an old updatedAt does not prove how long this task was blocked');
  f.advance(1000);f.reopen().tick();const initial=f.watch.view().alerts[0];assert.equal(initial.type,'blocked');assert.equal(initial.observedSince,f.at-1000);
  f.set(task,{status:'queued'});f.watch.tick({force:true});assert.equal(f.watch.view().total,0);
  f.advance(1000);f.set(task,{status:'waiting_event',blockedReason:'test-completed'});f.watch.tick({force:true});assert.equal(f.watch.view().total,0);
  f.advance(1000);f.watch.tick({force:true});const second=f.watch.view().alerts[0];assert.notEqual(second.id,initial.id);
  f.set(task,{blockedReason:'different-event'});assert.throws(()=>f.watch.acknowledge(ack(second)),/watch_alert_stale/);
  f.watch.tick({force:true});assert.equal(f.watch.view().total,0);
});

test('unlimited running work gets an observation warning without failure, cancellation, continuation or artificial budget',t=>{
  const f=fixture(t);f.configure({inactiveMs:1000});const task=f.add({status:'running',maxSteps:0,timeoutMs:0,tokenBudget:0});
  f.activity.set(task.id,{phase:'tool',lastActivityAt:f.at,heartbeatAt:f.at+86400000,workerConnected:true});
  const before=f.tasks.row('task',task.id);f.advance(86400000);f.watch.tick();const alert=f.watch.view().alerts[0];
  assert.equal(alert.type,'no_activity');assert.equal(alert.phase,'tool');assert.match(alert.reason,/不代表任务失败/);
  assert.deepEqual(f.tasks.row('task',task.id),before);assert.equal(f.changes.length,0);
  f.watch.acknowledge(ack(alert));const count=f.events.length;f.reopen().tick();assert.equal(f.events.length,count);
  f.activity.set(task.id,{phase:'model',lastActivityAt:f.at,heartbeatAt:f.at});assert.equal(f.watch.view().total,0);
  assert.throws(()=>f.watch.acknowledge(ack(alert)),/watch_alert_stale/);f.watch.tick({force:true});
  f.advance(1000);f.watch.tick({force:true});assert.notEqual(f.watch.view().alerts[0].id,alert.id);assert.equal(f.watch.view().unacknowledged,1);
});

test('priority escalation is opt-in, applies once to an overdue queued version, and leaves running work untouched',t=>{
  const f=fixture(t),queued=f.add({dueAt:f.at}),running=f.add({status:'running',dueAt:f.at}),future=f.add({dueAt:f.at+50000});
  f.watch.tick();assert.equal(f.tasks.row('task',queued.id).priority,'normal');assert.equal(f.watch.view().actions.length,0);
  f.configure({raiseQueuedPriority:true});assert.equal(f.tasks.row('task',queued.id).priority,'high');
  assert.equal(f.tasks.row('task',running.id).priority,'normal');assert.equal(f.tasks.row('task',future.id).priority,'normal');
  const action=f.watch.view().actions[0];assert.equal(action.taskId,queued.id);assert.equal(action.previousPriority,'normal');assert.equal(action.policyRevision,2);assert.equal(f.changes.length,1);
  f.set(queued,{priority:'low'});f.advance(5000);f.reopen().tick();assert.equal(f.tasks.row('task',queued.id).priority,'low','manual later priority remains authoritative for this overdue episode');
  assert.equal(f.watch.view().actions.length,1);assert.equal(f.changes.length,1);
  f.set(queued,{runId:'run-next',assignmentVersion:2});f.watch.tick({force:true});assert.equal(f.tasks.row('task',queued.id).priority,'high');
  assert.equal(f.watch.view().actions.length,2);assert.equal(f.watch.view().actions[0].assignmentVersion,2);
});

test('queued priority and its audit record commit atomically, with no event on rollback',t=>{
  const f=fixture(t),task=f.add({dueAt:f.at});f.configure({raiseQueuedPriority:true});
  f.set(task,{runId:'another-run',priority:'normal'});const write=f.watch.write.bind(f.watch),count=f.events.length;
  f.watch.write=(kind,...args)=>{if(kind==='action')throw Error('disk-write-failed');return write(kind,...args);};
  assert.throws(()=>f.watch.tick({force:true}),/disk-write-failed/);assert.equal(f.tasks.row('task',task.id).priority,'normal');
  assert.equal(f.watch.view().actions.length,1);assert.equal(f.events.length,count);assert.equal(f.watch.view().problem,'disk-write-failed');
  f.watch.write=write;f.watch.tick({force:true});assert.equal(f.tasks.row('task',task.id).priority,'high');assert.equal(f.watch.view().problem,null);
});

test('disabling watch resolves alerts without changing work and restarting cannot resurrect disabled alerts',t=>{
  const f=fixture(t),task=f.add({dueAt:f.at});f.watch.tick();const alert=f.watch.view().alerts[0];f.watch.acknowledge(ack(alert));
  f.configure({enabled:false});assert.equal(f.watch.view().total,0);assert.equal(stored(f,alert.id).status,'resolved');
  const count=f.events.length;f.advance(86400000);f.reopen().tick();assert.equal(f.events.length,count);assert.equal(f.tasks.row('task',task.id).status,'queued');
  f.configure({enabled:true});assert.equal(f.watch.view().total,1);assert.equal(f.watch.view().unacknowledged,0,'same condition keeps the acknowledgement');
});

test('historical, terminal and internal review tasks stay outside the candidate scan and alert list',t=>{
  const f=fixture(t);f.db.exec('BEGIN');
  for(let i=0;i<2000;i++)f.tasks.put('task',{id:'historic-'+i,status:'completed',dueAt:1});
  for(const status of ['paused','cancelled','completed','failed','interrupted','pausing','cancelling'])f.add({status,dueAt:1});
  f.add({status:'running',dueAt:1,managementReview:{targetTaskId:'employee'}});f.add({status:'waiting_input'});
  f.db.exec('COMMIT');const task=f.add({status:'waiting_input',dueAt:f.at});f.watch.tick();
  assert.deepEqual(f.watch.view().alerts.map(alert=>[alert.taskId,alert.type]),[[task.id,'overdue']]);
  const plan=f.db.prepare("EXPLAIN QUERY PLAN SELECT body FROM background_task WHERE json_extract(body,'$.status') IN ('queued','running','blocked','waiting_input','waiting_event') AND json_extract(body,'$.managementReview') IS NULL").all();
  assert.ok(plan.some(row=>row.detail.includes('team_watch_task_status')));
});

test('owner filtering and pagination count all current reminders beyond the first page',t=>{
  const f=fixture(t);for(let i=0;i<23;i++)f.add({dueAt:f.at,assignedBotId:i<21?'employee':'other'});f.watch.tick();
  const page=f.watch.view({ownerId:'employee',limit:20});assert.equal(page.total,21);assert.equal(page.unacknowledged,21);assert.equal(page.alerts.length,20);assert.equal(page.hasMore,true);
  const next=f.watch.view({ownerId:'employee',limit:20,offset:20});assert.equal(next.alerts.length,1);assert.equal(next.hasMore,false);assert.equal(next.total,21);
  assert.ok(!page.alerts.some(alert=>alert.id===next.alerts[0].id));assert.equal(f.watch.view({ownerId:'other'}).total,2);
  f.watch.acknowledge(ack(next.alerts[0]));assert.equal(f.watch.view({ownerId:'employee'}).unacknowledged,20);
  for(const input of [{offset:-1},{offset:0.5},{limit:0},{limit:101},{ownerId:'../outside'}])assert.throws(()=>f.watch.view(input),/invalid_watch_page/);
});

test('shared SQL expires deadline alerts immediately on time, state, Run, assignment and deadline changes',t=>{
  const f=fixture(t),task=f.add({dueAt:f.at+1000});f.watch.tick();const near=f.watch.view().alerts[0];assert.deepEqual(sqlCurrent(f),[near.id]);
  f.advance(1000);assert.deepEqual(sqlCurrent(f),[],'near-deadline alert expires at the boundary, without a tick');
  f.watch.tick({force:true});const overdue=f.watch.view().alerts[0];assert.deepEqual(sqlCurrent(f),[overdue.id]);
  for(const patch of [{status:'paused'},{status:'completed'},{status:'cancelled'},{status:'failed'},{status:'interrupted'},{runId:'different-run'},{assignmentVersion:2},{dueAt:f.at-1},{dueAt:f.at+1000},{managementReview:{}}]){
    f.tasks.put('task',{...task,dueAt:f.at,...patch});assert.deepEqual(sqlCurrent(f),[],JSON.stringify(patch));
  }
  f.tasks.put('task',{...task,dueAt:f.at});assert.deepEqual(sqlCurrent(f),[overdue.id]);
  assert.throws(()=>currentWatchAlertSql('t; DROP TABLE background_task'),/invalid_watch_alias/);
});

test('shared SQL expires blocked and no-progress alerts immediately when their waiting state changes',t=>{
  const f=fixture(t);f.configure({blockedMs:1000,inactiveMs:1000});
  const blocked=f.add({status:'waiting_event',blockedReason:'file'}),running=f.add({status:'running'});
  f.watch.tick({force:true});f.advance(1000);f.watch.tick({force:true});const alerts=f.watch.view().alerts;
  const wait=alerts.find(a=>a.taskId===blocked.id),idle=alerts.find(a=>a.taskId===running.id);
  assert.deepEqual(sqlCurrent(f).sort(),[wait.id,idle.id].sort());
  f.set(blocked,{blockedReason:'different-file'});assert.deepEqual(sqlCurrent(f),[idle.id]);
  f.set(blocked,{blockedReason:'file',status:'blocked'});assert.deepEqual(sqlCurrent(f),[idle.id],'event wait cannot be mistaken for a different blocker');
  f.set(running,{status:'waiting_input'});assert.deepEqual(sqlCurrent(f),[]);
  f.set(blocked,{status:'waiting_event'});assert.deepEqual(sqlCurrent(f),[wait.id]);
});
