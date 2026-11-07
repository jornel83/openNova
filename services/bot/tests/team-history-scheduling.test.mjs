import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Operations} from '../operations.mjs';
import {TaskManager} from '../tasks/manager.mjs';
import {TeamSupervisor} from '../team/supervisor.mjs';
import {TeamOutbox} from '../team/outbox.mjs';
import {ManagementDelivery} from '../team/delivery.mjs';

function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'nova-history-scheduling-')),workspace=join(home,'project'),ops=new Operations({home,workspace}),tasks=new TaskManager({ops,home,workspace}),created=[];
  tasks.tick=()=>{};clearInterval(tasks.timer);
  tasks.team={chiefId:'chief',assignment:input=>({assignedBotId:input.assignedBotId??'employee',supervisorBotId:'chief',reportTo:'chief',assignmentVersion:1}),snapshot:task=>({botId:task.assignedBotId}),owner:()=>({})};
  const outbox=new TeamOutbox({db:ops.db,delivery:new ManagementDelivery({home,chiefId:'chief'})});
  const supervisor=new TeamSupervisor({tasks,reports:tasks.reports,createManagementTask:({id,report,managementReview,goal,budgets})=>{
    created.push(report.id);return tasks.create({id,kind:'agent',title:'review',goal,assignedBotId:'chief',managementEnabled:false,...budgets},{source:'supervisor',managementReview});
  }});tasks.supervisor=supervisor;
  t.after(async()=>{await tasks.close();await outbox.close();ops.close();rmSync(home,{recursive:true,force:true});});
  async function complete(id){
    const detail=tasks.create({id,kind:'agent',title:id,goal:'交付报告',assignedBotId:'employee'}),task=tasks.row('task',id),run=tasks.row('run',detail.task.runId),job=tasks.row('job',run.jobId),path=join(task.cwd,id+'.md');writeFileSync(path,'original report');
    Object.assign(task,{status:'completed'});Object.assign(run,{status:'completed',finishedAt:Date.now()});Object.assign(job,{status:'completed',cleanupConfirmed:true,finishedAt:run.finishedAt,artifacts:[{name:id+'.md',path}]});tasks.put('task',task);tasks.put('run',run);tasks.put('job',job);
    const report=tasks.reports.capture(task,run,job);assert.equal(report.artifacts[0].status,'available');await outbox.tick();assert.equal(tasks.reports.isDelivered(report.id),true);return {task,run,job,report,path};
  }
  function review(record,patch={}){
    const value={id:'review-'+createHash('sha256').update(record.report.id).digest('hex'),taskId:record.task.id,runId:record.run.id,assignmentVersion:record.task.assignmentVersion,reportId:record.report.id,status:'accepted',source:'supervisor',createdAt:Date.now(),decision:{action:'accept',summary:'已检查',evidenceIds:[record.report.artifacts[0].id]},...patch};
    ops.db.prepare('INSERT INTO team_review VALUES (?,?)').run(value.id,JSON.stringify(value));return value;
  }
  return {tasks,supervisor,outbox,created,complete,review,db:ops.db};
}

test('idle supervision skips materializing settled reports while explicit views still detect changed artifacts',async t=>{
  const f=fixture(t);let last;
  for(let i=0;i<100;i++){last=await f.complete('history-'+i);f.review(last);}
  let gets=0;const get=f.tasks.reports.get.bind(f.tasks.reports);f.tasks.reports.get=(...args)=>{gets++;return get(...args);};
  f.supervisor.tick();f.supervisor.tick();assert.equal(gets,0,'idle ticks must not read/hash every historical artifact');assert.equal(f.created.length,0);
  writeFileSync(last.path,'changed report');f.supervisor.tick();assert.equal(gets,0);
  assert.equal(f.supervisor.summary(last.task).reviewStatus,'stale','opening the current view still checks real file changes without cross-tick status caching');assert.ok(gets>0);
  for(const [sql,values,index] of [
    ["SELECT id FROM team_report WHERE json_extract(body,'$.taskId')=? AND json_extract(body,'$.runId')=? AND json_extract(body,'$.assignmentVersion')=? ORDER BY json_extract(body,'$.version') DESC LIMIT 1",[last.task.id,last.run.id,1],'team_report_current'],
    ["SELECT id FROM team_review WHERE json_extract(body,'$.taskId')=? AND json_extract(body,'$.reportId')=? AND json_extract(body,'$.runId')=? AND json_extract(body,'$.assignmentVersion')=? LIMIT 1",[last.task.id,last.report.id,last.run.id,1],'team_review_current'],
  ])assert.ok(f.db.prepare('EXPLAIN QUERY PLAN '+sql).all(...values).some(row=>row.detail.includes(index)),index+' must serve the scheduling lookup');
});

test('a newly captured report in the same Run is reviewed even after its previous report was accepted',async t=>{
  const f=fixture(t),record=await f.complete('recapture');f.review(record);f.supervisor.tick();assert.equal(f.created.length,0);
  writeFileSync(record.path,'updated report');record.job.exitCode=0;f.tasks.put('job',record.job);
  const newer=f.tasks.reports.capture(record.task,record.run,record.job);assert.notEqual(newer.id,record.report.id);assert.equal(newer.runId,record.report.runId);await f.outbox.tick();
  f.supervisor.tick();assert.deepEqual(f.created,[newer.id],JSON.stringify(f.supervisor.history(record.task.id)));assert.equal(f.tasks.reports.currentId(record.task),newer.id);
  f.supervisor.tick();assert.deepEqual(f.created,[newer.id],'the same queued review is not created twice');
});

test('a review with a foreign task, old Run or old assignment cannot suppress the current report',async t=>{
  for(const mismatch of [{taskId:'foreign'},{runId:'old-run'},{assignmentVersion:0}]){
    const f=fixture(t),record=await f.complete('current');f.review(record,{id:'unrelated-user-review',source:'user',...mismatch});
    assert.equal(f.supervisor.hasReview(record.task,record.report.id),false);assert.equal(f.supervisor.summary(record.task).reviewStatus,'pending');
    f.supervisor.tick();assert.deepEqual(f.created,[record.report.id],JSON.stringify(f.supervisor.history(record.task.id)));
  }
});
