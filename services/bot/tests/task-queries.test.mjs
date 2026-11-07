import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Operations} from '../operations.mjs';
import {TaskManager} from '../tasks/manager.mjs';
import {TeamSupervisor} from '../team/supervisor.mjs';
import {TeamRegistry} from '../team/registry.mjs';
import {TeamOutbox} from '../team/outbox.mjs';

function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'nova-task-query-')),workspace=join(home,'project'),ops=new Operations({home,workspace}),tasks=new TaskManager({ops,home,workspace});
  clearInterval(tasks.timer);tasks.foregroundBusy=()=>true;tasks.team={chiefId:'chief',assignment:()=>({}),owner:()=>({})};
  tasks.supervisor=new TeamSupervisor({tasks,reports:tasks.reports,createManagementTask(){throw Error('unexpected review');}});
  t.after(async()=>{await tasks.close();ops.close();rmSync(home,{recursive:true,force:true});});
  const insert=(table,value)=>ops.db.prepare(`INSERT INTO ${table} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(value.id,JSON.stringify(value));
  function record(id,patch={}){
    const task={id,title:id,runId:id+'-run',assignedBotId:'employee',supervisorBotId:'chief',assignmentVersion:1,status:'completed',createdAt:1,updatedAt:1,artifacts:[],cwd:workspace,unread:false,...patch};
    tasks.put('job',{id:task.runId+'-job',taskId:id,runId:task.runId,status:task.status,kind:'command',cleanupConfirmed:true});
    tasks.put('run',{id:task.runId,taskId:id,jobId:task.runId+'-job',number:1,status:task.status,createdAt:task.createdAt});tasks.put('task',task);return task;
  }
  function report(task,version=1){const value={id:task.id+'-report-'+version,eventId:'event-'+task.id+'-'+version,taskId:task.id,runId:task.runId,assignmentVersion:task.assignmentVersion,version,artifacts:[]};insert('team_report',value);return value;}
  function review(task,report,patch={}){const value={id:report.id+'-review',taskId:task.id,runId:task.runId,assignmentVersion:task.assignmentVersion,reportId:report.id,status:'accepted',...patch};insert('team_review',value);return value;}
  return {tasks,db:ops.db,home,workspace,record,report,review,insert};
}

test('SQL pagination filters the complete history and preserves full counts and legacy chief ownership',t=>{
  const f=fixture(t);
  for(let i=0;i<125;i++)f.record('old-'+i,{assignedBotId:i<60?'alice':'bob',unread:i<60});
  f.record('new-active',{status:'queued',assignedBotId:'bob'});f.record('internal',{status:'queued',managementReview:{targetTaskId:'old-0'}});
  f.record('legacy',{assignedBotId:undefined});f.record('literal-percent',{title:'100% 成果'});
  const page=f.tasks.list({ownerId:'alice',limit:7,offset:56});
  assert.equal(page.total,60);assert.equal(page.tasks.length,4);assert.equal(page.hasMore,false);assert.equal(page.unreadCount,60);
  assert.equal(f.tasks.list({filter:'active'}).total,1);assert.equal(f.tasks.list().activeCount,1);
  assert.deepEqual(f.tasks.list({ownerId:'chief'}).tasks.map(x=>x.id),['legacy']);
  assert.deepEqual(f.tasks.list({search:'%'}).tasks.map(x=>x.id),['literal-percent']);
  assert.equal(f.tasks.list({filter:'recent',ownerId:'alice'}).total,0,'finished tasks without a report are not deliveries');
  f.report(f.tasks.row('task','old-0'));f.report(f.tasks.row('task','old-1'));
  const waiting=f.record('partial-delivery',{status:'waiting_input',assignedBotId:'alice'});f.report(waiting);
  assert.equal(f.tasks.list({filter:'recent',ownerId:'alice',offset:2}).total,3);
  assert.throws(()=>f.tasks.list({filter:'invalid'}),/invalid_task_filter/);
});

test('attention binds reviews and watch alerts to the current task Run and assignment',t=>{
  const f=fixture(t),target=f.record('target'),report=f.report(target);
  f.review(target,report,{status:'needs_user',runId:'old-run'});
  f.record('failed',{status:'failed'});f.record('question',{status:'waiting_input'});
  const busy=f.record('busy',{status:'running'});f.tasks.put('job',{...f.tasks.row('job',busy.runId+'-job'),cleanupConfirmed:false});
  assert.deepEqual(f.tasks.list({filter:'attention'}).tasks.map(x=>x.id).sort(),['failed','question']);
  f.review(target,report,{status:'needs_user'});assert.equal(f.tasks.list({filter:'attention'}).total,3);
  f.review(target,report,{status:'accepted'});
  const watched={...target,status:'queued',dueAt:1};f.tasks.put('task',watched);
  f.db.exec('CREATE TABLE team_watch_alert(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
  const alert={id:'late',taskId:target.id,runId:target.runId,assignmentVersion:1,status:'active',type:'overdue',dueAt:1};
  f.insert('team_watch_alert',{...alert,assignmentVersion:0});
  assert.equal(f.tasks.list({filter:'attention'}).total,2);
  f.insert('team_watch_alert',alert);
  assert.equal(f.tasks.list({filter:'attention'}).total,3);
  f.tasks.put('task',{...watched,dueAt:Date.now()+100000});assert.equal(f.tasks.list({filter:'attention'}).total,2,'deadline change invalidates the previous alert before the next watch tick');
  f.tasks.put('task',{...watched,status:'completed'});assert.equal(f.tasks.list({filter:'attention'}).total,2,'completed work cannot retain an active deadline alert');
  f.tasks.put('task',watched);
  f.insert('team_watch_alert',{...alert,acknowledgedAt:1});
  assert.equal(f.tasks.list({filter:'attention'}).total,2);
  f.tasks.put('task',{...busy,status:'completed'});assert.equal(f.tasks.list({filter:'attention'}).total,3,'unconfirmed cleanup after execution remains actionable');
});

test('only current Run cleanup holds the queue and obsolete receipts cannot be consumed',t=>{
  const f=fixture(t),old=f.record('old-task');
  f.tasks.put('job',{...f.tasks.row('job',old.runId+'-job'),cleanupConfirmed:false});
  f.record('old-task',{runId:'new-run'});f.record('queued',{status:'queued'});
  assert.deepEqual(f.tasks.queries.currentWork(),[]);assert.equal(f.tasks.queries.holdsSlot(),false);
  let receipts=0,launched;f.tasks.receipt=()=>{receipts++;throw Error('old receipt must not be read');};f.tasks.launch=task=>{launched=task.id;};f.tasks.foregroundBusy=()=>false;
  f.tasks.tick();assert.equal(f.tasks.lastError,null);assert.equal(receipts,0);assert.equal(launched,'queued');
  const job=f.tasks.row('job','new-run-job');f.tasks.put('job',{...job,cleanupConfirmed:false});f.tasks.receipt=()=>null;launched=null;
  f.tasks.tick();assert.equal(f.tasks.queries.holdsSlot(),true);assert.equal(launched,null);
  f.tasks.put('job',{...job,cleanupConfirmed:true});f.tasks.foregroundBusy=()=>true;f.tasks.tick();assert.equal(launched,null,'foreground keeps priority');
});

test('queue ordering retains supervisor priority, explicit priority, due time and Run age',t=>{
  const f=fixture(t);
  f.record('normal',{status:'queued',createdAt:1});
  f.record('high-later',{status:'queued',priority:'high',dueAt:20,createdAt:2});
  f.record('high-due-newer',{status:'queued',priority:'high',dueAt:10,createdAt:4});
  f.record('high-due-older',{status:'queued',priority:'high',dueAt:10,createdAt:3});
  f.record('review',{status:'queued',priority:'low',managementReview:{targetTaskId:'normal'},createdAt:5});
  const order=[];
  for(let next;(next=f.tasks.queries.nextQueued());){order.push(next.id);f.tasks.put('task',{...next,status:'completed'});}
  assert.deepEqual(order,['review','high-due-older','high-due-newer','high-later','normal']);
});

test('review candidate projection handles rollback, same-Run recapture, assignment changes and restart repair',t=>{
  const f=fixture(t),task=f.record('employee',{management:{enabled:true,paused:false}}),first=f.report(task);
  assert.deepEqual(f.tasks.queries.pendingReviews().map(x=>x.id),[task.id]);
  assert.throws(()=>f.tasks.atomic(()=>{f.review(task,first);throw Error('transaction aborted');}),/aborted/);
  assert.equal(f.tasks.queries.pendingReviews().length,1,'review rollback must not lose its pending work');
  f.review(task,first);assert.equal(f.tasks.queries.pendingReviews().length,0);
  const second=f.report(task,2);assert.equal(f.tasks.queries.pendingReviews().length,1,'same Run recapture is independent');
  f.review(task,second,{assignmentVersion:0});assert.equal(f.tasks.queries.pendingReviews().length,1,'foreign assignment never suppresses review');
  f.tasks.put('task',{...task,management:{enabled:true,paused:true}});assert.equal(f.tasks.queries.pendingReviews().length,0);
  f.tasks.put('task',task);assert.equal(f.tasks.queries.pendingReviews().length,1);
  f.db.exec('DELETE FROM task_review_candidate');f.tasks.queries.initializeReviews();assert.equal(f.tasks.queries.pendingReviews().length,1);
  f.tasks.put('task',{...task,assignmentVersion:2});assert.equal(f.tasks.queries.pendingReviews().length,0,'old report no longer belongs to the current owner');
});

test('thousands of accepted tasks do not enter scheduler, assignment or roster materialization',t=>{
  const f=fixture(t);
  f.tasks.atomic(()=>{for(let i=0;i<2500;i++){const task=f.record('history-'+i,{management:{enabled:true,paused:false},...(i?{dependencyInputs:[{taskId:'history-0',reportId:'history-0-report-1'}]}:{})});f.review(task,f.report(task));}});
  f.tasks.all=()=>{throw Error('full history materialization');};
  const originalRow=f.tasks.row.bind(f.tasks);let reads=0;f.tasks.row=(...args)=>{reads++;return originalRow(...args);};
  for(let i=0;i<5;i++)f.tasks.tick();assert.equal(f.tasks.lastError,null);assert.equal(reads,0);
  assert.equal(f.tasks.queries.assignmentCandidates().length,0);assert.equal(f.tasks.queries.pendingReviews().length,0);
  const state={mainBotIds:['chief'],bots:{chief:{id:'chief',name:'Nova'},employee:{id:'employee',name:'员工'}}};
  const registry=new TeamRegistry({rt:{home:f.home,state,botOf:id=>state.bots[id]},db:f.db,workspace:f.workspace});registry.tasks=f.tasks;
  assert.deepEqual(registry.view().members.map(x=>x.status),['idle','idle']);
  assert.deepEqual(f.tasks.summary(f.tasks.row('task','history-2499')).inputsStale,[],'opening history validates its pinned inputs');
  f.tasks.put('task',{...f.tasks.row('task','history-0'),assignmentVersion:2});
  assert.deepEqual(f.tasks.summary(f.tasks.row('task','history-2499')).inputsStale,['history-0'],'historical views never reuse a stale dependency result');
  const query=f.db.prepare('EXPLAIN QUERY PLAN SELECT t.body FROM task_review_candidate q CROSS JOIN background_task t ON t.id=q.task_id').all();
  assert.ok(query.some(row=>/^SCAN q\b/.test(row.detail)),JSON.stringify(query));assert.ok(!query.some(row=>/^SCAN t\b/.test(row.detail)),'pending review query starts at the candidate set');
  const prepare=f.db.prepare.bind(f.db);let workSql;
  f.db.prepare=sql=>{workSql=sql;return prepare(sql);};f.tasks.queries.currentWork();f.db.prepare=prepare;
  const workPlan=prepare('EXPLAIN QUERY PLAN '+workSql).all();
  assert.ok(workPlan.some(row=>row.detail.includes('background_job_cleanup')),JSON.stringify(workPlan));
  assert.ok(!workPlan.some(row=>/^SCAN (?:t2|r2)\b/.test(row.detail)),'cleanup lookup starts from unconfirmed Jobs instead of scanning historical Tasks');
  let pageSql;f.db.prepare=sql=>{pageSql=sql;return prepare(sql);};f.tasks.queries.page({filter:'recent',limit:1});f.db.prepare=prepare;
  const pagePlan=prepare('EXPLAIN QUERY PLAN '+pageSql).all(1,0);
  assert.ok(pagePlan.some(row=>row.detail.includes('SEARCH p USING INDEX team_report_current')),JSON.stringify(pagePlan));
  assert.ok(!pagePlan.some(row=>/^SCAN [pv]\b/.test(row.detail)),'correlated report/review lookups must use expression indexes');
  let assignmentsSql;f.db.prepare=sql=>{assignmentsSql=sql;return prepare(sql);};f.tasks.queries.assignmentCandidates();f.db.prepare=prepare;
  const assignmentPlan=prepare('EXPLAIN QUERY PLAN '+assignmentsSql).all();
  assert.ok(assignmentPlan.some(row=>row.detail.includes('background_task_unfinished_dependencies')),'dependency candidate lookup scans only its unfinished partial index');
});

test('outbox idle ticks skip delivered history and due selection preserves batching and missing timestamps',async t=>{
  const f=fixture(t),outbox=new TeamOutbox({db:f.db,now:()=>100,delivery:{lookup(){throw Error('unexpected delivery');}}});
  f.tasks.atomic(()=>{for(let i=0;i<2500;i++)f.insert('team_outbox',{id:'sent-'+i,status:'delivered',nextAttemptAt:0});});
  outbox.list=()=>{throw Error('full outbox history decoded');};await outbox.tick();assert.deepEqual(outbox.pending(),[]);
  const prepare=f.db.prepare.bind(f.db);let pendingSql;f.db.prepare=sql=>{pendingSql=sql;return prepare(sql);};outbox.pending();f.db.prepare=prepare;
  assert.ok(prepare('EXPLAIN QUERY PLAN '+pendingSql).all(100).some(row=>row.detail.includes('team_outbox_pending_due')),'outbox query must use its partial pending index');
  f.insert('team_outbox',{id:'missing-time',status:'retry'});f.insert('team_outbox',{id:'future',status:'retry',nextAttemptAt:101});
  f.insert('team_outbox',{id:'legacy-null',status:'retry',nextAttemptAt:null});
  for(let i=0;i<12;i++)f.insert('team_outbox',{id:'due-'+i,status:i===0?'sending':'pending',nextAttemptAt:100});
  assert.deepEqual(outbox.pending().map(row=>row.id),['legacy-null',...Array.from({length:9},(_,i)=>'due-'+i)]);
  await outbox.close();
});
