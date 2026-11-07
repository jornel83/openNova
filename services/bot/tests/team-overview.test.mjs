import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {TeamOverview} from '../team/overview.mjs';
import {TeamWatch} from '../team/watch.mjs';
import {teamTools} from '../team/tools.mjs';
import {createControls} from '../controls.mjs';

function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  for(const table of ['background_task','background_run','background_job','team_report','team_review'])db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY,body TEXT NOT NULL)`);
  const put=(table,value)=>db.prepare(`INSERT INTO ${table} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(value.id,JSON.stringify(value));
  const row=(kind,id)=>JSON.parse(db.prepare(`SELECT body FROM background_${kind} WHERE id=?`).get(id).body);
  let reads=0;const now=new Date(2026,10,8,12,0).getTime();
  const tasks={db,row,summary(task){reads++;return {...task,cleanupConfirmed:row('job',row('run',task.runId).jobId).cleanupConfirmed};}};
  const team={chiefId:'chief',tasks,view:()=>({members:[{id:'chief',name:'总管',status:'idle'},{id:'writer',name:'资料员',status:'working'}]}),owner:task=>({assignedBotId:task.assignedBotId??'chief'})};
  tasks.team=team;const watch=new TeamWatch({tasks,team,now:()=>now});tasks.watch=watch;
  const overview=new TeamOverview({tasks,team,watch,now:()=>now});team.overview=overview;
  function seed(id,status='completed',extra={}){
    const task={id,status,title:id,runId:'run-'+id,assignmentVersion:1,assignedBotId:'writer',...extra};
    put('background_task',task);put('background_run',{id:task.runId,jobId:'job-'+id,number:1,finishedAt:now-1000});put('background_job',{id:'job-'+id,cleanupConfirmed:true});return task;
  }
  function report(task,{review='accepted',id='report-'+task.id,version=1}={}){
    put('team_report',{id,taskId:task.id,runId:task.runId,assignmentVersion:task.assignmentVersion,version,summary:'已提交 '+task.title,artifacts:[{name:'summary.md'}]});
    if(review)put('team_review',{id:'review-'+id,taskId:task.id,reportId:id,runId:task.runId,assignmentVersion:task.assignmentVersion,status:review,finishedAt:now-500});
  }
  return {db,put,row,now,seed,report,overview,watch,team,tasks,get reads(){return reads;}};
}

test('overview counts the full population beyond the task page and bounds evidence materialization',t=>{
  const f=fixture(t);
  for(let i=0;i<120;i++)f.report(f.seed('done-'+i));
  f.seed('hidden','completed',{managementReview:{reportId:'internal'}});
  f.seed('legacy','queued',{assignedBotId:undefined});
  f.seed('busy','running');f.put('background_job',{id:'job-busy',cleanupConfirmed:false});
  f.seed('question','waiting_input');f.seed('failed','failed');
  const v=f.overview.view({limit:3});
  assert.deepEqual(v.counts,{total:124,active:2,attention:2,completed:120,accepted:120,recent:120});
  assert.equal(v.recent.length,3);assert.equal(v.members.find(m=>m.id==='chief').activeCount,1);
  assert.equal(v.attention.some(t=>t.id==='busy'),false,'ordinary running cleanup=false is not a cleanup failure');
  assert.ok(f.reads<=7,'only visible cards materialize report evidence');
  assert.deepEqual(f.overview.view({ownerId:'chief'}).counts,{total:1,active:1,attention:0,completed:0,accepted:0,recent:0});
  assert.equal(f.overview.view({ownerId:'writer'}).counts.total,123);
  assert.equal(f.overview.view({ownerId:'missing'}).counts.total,0);
});

test('latest report, Run and assignment binding prevent stale acceptance; today uses local midnight',t=>{
  const f=fixture(t),old=f.seed('old');f.report(old);
  f.put('background_run',{...f.row('run',old.runId),finishedAt:f.now-86400000});
  f.put('team_review',{id:'review-report-old',taskId:old.id,reportId:'report-old',runId:old.runId,assignmentVersion:1,status:'accepted',finishedAt:f.now-86400000});
  const newReport=f.seed('recaptured');f.report(newReport);f.report(newReport,{id:'report-new',version:2,review:'needs_user'});
  const newRun=f.seed('new-run');f.report(newRun);f.put('background_task',{...newRun,runId:'newer-run',status:'queued'});f.put('background_run',{id:'newer-run',jobId:'job-new-run'});
  const reassigned=f.seed('reassigned');f.report(reassigned);f.put('background_task',{...reassigned,assignmentVersion:2});
  const v=f.overview.view({period:'today'});
  assert.equal(v.counts.accepted,0);assert.equal(v.counts.completed,2);assert.equal(v.counts.active,1);
  assert.deepEqual(v.recent.map(x=>x.id),['recaptured']);assert.deepEqual(v.attention.map(x=>x.id),['recaptured']);
  assert.equal(v.window.since,new Date(2026,10,8).getTime());assert.ok(v.window.timezone);
  assert.equal(f.overview.view().counts.accepted,1);
  f.put('team_review',{id:'review-report-old',taskId:old.id,reportId:'report-old',runId:old.runId,assignmentVersion:1,status:'accepted',finishedAt:f.now});
  assert.equal(f.overview.view({period:'today'}).counts.accepted,1,'yesterday execution accepted today is a today acceptance');
  assert.equal(f.overview.view({period:'today'}).counts.completed,2,'acceptance does not move the execution completion date');
});

test('watch attention deduplicates tasks, ignores old bindings and acknowledgement never completes work',t=>{
  const f=fixture(t),task=f.seed('deadline','queued',{dueAt:f.now-5000});f.watch.tick();
  const v=f.overview.view();assert.equal(v.counts.attention,1);assert.equal(v.attention[0].alerts.length,1);assert.match(v.attention[0].reasons[0],/截止时间/);
  f.put('background_task',{...task,status:'paused'});
  assert.equal(f.overview.view().counts.attention,0,'same-Run paused state invalidates an alert before the next watch tick');
  f.put('background_task',{...task,dueAt:f.now+9000000});
  assert.equal(f.overview.view().counts.attention,0,'deadline edits invalidate stale persisted observations immediately');
  f.put('background_task',task);
  const alert=v.watch.alerts[0];f.watch.acknowledge({id:alert.id,taskId:task.id,runId:task.runId,assignmentVersion:1});
  assert.equal(f.overview.view().counts.attention,0);assert.equal(f.row('task',task.id).status,'queued');
  f.watch.write('alert','stale-alert',{...alert,id:'stale-alert',acknowledgedAt:null,runId:'old-run'});
  assert.equal(f.overview.view().counts.attention,0);
  f.seed('cleanup','interrupted');f.put('background_job',{id:'job-cleanup',cleanupConfirmed:false});
  const cleanup=f.overview.view().attention[0];assert.equal(cleanup.reasons.length,2);assert.equal(f.overview.view().counts.attention,1);
});

test('overview and watch routes and tools share state; supervisor cannot change watch policy',async t=>{
  const f=fixture(t);f.seed('work','queued');
  let request={id:'foreground'};const list=teamTools(f.team,()=>request),tool=name=>list.find(entry=>entry[0]===name)[3];
  const controls=createControls({team:f.team,tasks:f.tasks,requests:{exclusive:fn=>fn()}});
  assert.deepEqual(await controls('/team-overview',{}),tool('team_overview')({}));
  const policy=await controls('/team-watch',{});assert.equal(policy.policy.raiseQueuedPriority,false);
  request={id:'review-run',actor:{kind:'supervisor'}};
  assert.throws(()=>tool('team_watch_policy')({revision:1,raiseQueuedPriority:true}),/actor_denied/);
  request={id:'user-policy'};tool('team_watch_policy')({revision:1,enabled:false});assert.equal(f.watch.policy().enabled,false);
  tool('team_watch_policy')({revision:1,enabled:false});assert.equal(f.watch.policy().revision,2,'duplicate user tool call is idempotent');
  assert.throws(()=>f.overview.view({limit:51}),/invalid_team_overview/);
});

test('overview correlated report and review joins use their indexes rather than rescanning history per task',t=>{
  const f=fixture(t);
  f.db.exec(`CREATE INDEX team_report_current ON team_report(json_extract(body,'$.taskId'),json_extract(body,'$.runId'),json_extract(body,'$.assignmentVersion'),json_extract(body,'$.version'));
    CREATE INDEX team_review_current ON team_review(json_extract(body,'$.taskId'),json_extract(body,'$.reportId'),json_extract(body,'$.runId'),json_extract(body,'$.assignmentVersion'));`);
  for(let i=0;i<3;i++)f.report(f.seed('history-'+i));
  const prepare=f.db.prepare.bind(f.db),queries=[];
  f.db.prepare=sql=>{if(sql.startsWith('WITH alerts'))queries.push(sql);return prepare(sql);};
  f.overview.view({limit:1});f.db.prepare=prepare;assert.equal(queries.length,5);
  for(const sql of queries){
    const statement=prepare('EXPLAIN QUERY PLAN '+sql);statement.setAllowUnknownNamedParameters(true);
    const plan=statement.all({chief:'chief',owner:null,limit:1,since:0,now:f.now}).map(row=>row.detail).join('\n');
    assert.match(plan,/SEARCH x USING (?:COVERING )?INDEX team_report_current/);
    assert.match(plan,/SEARCH x USING (?:COVERING )?INDEX team_review_current/);
    assert.doesNotMatch(plan,/SCAN x\b/);
  }
});
