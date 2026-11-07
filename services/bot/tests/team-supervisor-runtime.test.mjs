import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Operations} from '../operations.mjs';
import {TaskManager} from '../tasks/manager.mjs';
import {TeamSupervisor} from '../team/supervisor.mjs';
import {TeamOutbox} from '../team/outbox.mjs';
import {ManagementDelivery} from '../team/delivery.mjs';

function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'nova-supervisor-runtime-')),workspace=join(home,'project'),ops=new Operations({home,workspace});
  const tasks=new TaskManager({ops,home,workspace,agentProviderModule:fileURLToPath(new URL('./fixtures/management-provider.mjs',import.meta.url))});
  tasks.team={chiefId:'chief',assignment:input=>({assignedBotId:input.assignedBotId??'chief',supervisorBotId:'chief',reportTo:'chief',assignmentVersion:1}),
    snapshot:task=>({botId:task.assignedBotId,name:task.assignedBotId,role:task.assignedBotId==='chief'?'总管':'资料员'}),owner:task=>({ownerName:task.assignedBotId})};
  const delivery=new ManagementDelivery({home,chiefId:'chief'});tasks.outbox=new TeamOutbox({db:ops.db,delivery});
  tasks.supervisor=new TeamSupervisor({tasks,reports:tasks.reports,createManagementTask:({id,goal,budgets,managementReview})=>tasks.create({id,kind:'agent',title:'独立验收',assignedBotId:'chief',goal,workspaceMode:'general',permission:'read-only',managementEnabled:false,...budgets},{source:'supervisor',managementReview})});
  t.after(async()=>{await tasks.close();ops.close();rmSync(home,{recursive:true,force:true});});
  return {tasks,delivery};
}
test('real Harness independently reviews a delivery, requests bounded rework and accepts the new evidence',{timeout:60000},async t=>{
  const {tasks,delivery}=fixture(t);
  tasks.create({id:'employee-task',kind:'agent',title:'提交完整报告',goal:'生成 report.md，完整说明结论。',assignedBotId:'employee',timeoutMs:20000});
  const deadline=Date.now()+45000;let accepted;
  while(Date.now()<deadline){
    const task=tasks.row('task','employee-task'),report=tasks.reports.current(task);if(report&&tasks.supervisor.isAccepted(report)){accepted=tasks.detail(task.id);break;}
    const problem=tasks.supervisor.history(task.id).find(review=>['needs_user','failed','budget_exhausted'].includes(review.status));
    if(problem){const child=problem.managementTaskId&&tasks.detail(problem.managementTaskId);throw Error(JSON.stringify({problem,child,logs:child&&tasks.log({id:child.task.id}).text}));}
    await delay(50);
  }
  assert.ok(accepted,JSON.stringify({tasks:tasks.all(),reviews:tasks.supervisor.history('employee-task'),scheduler:tasks.lastError}));
  assert.equal(accepted.runs.length,2);assert.equal(accepted.task.management.usedReworks,1);
  assert.match(readFileSync(join(accepted.workspace.path,'report.md'),'utf8'),/COMPLETE_MARKER/);
  const reviews=tasks.supervisor.history('employee-task');assert.deepEqual(reviews.map(review=>review.status),['accepted','changes_requested']);
  assert.equal(tasks.all().filter(task=>task.managementReview).length,2);assert.equal(tasks.list().tasks.length,1);
  for(const child of tasks.all().filter(task=>task.managementReview)){
    const detail=tasks.detail(child.id);assert.equal(child.permission,'read-only');assert.notEqual(child.sessionId,accepted.task.sessionId);
    assert.deepEqual(detail.runs[0].jobs.map(job=>job.tool),['read','read','review_decide']);assert.ok(detail.runs[0].jobs.every(job=>job.status==='completed'));
    assert.equal(tasks.reports.history(child.id).length,0,'management tasks never generate a new employee report');
  }
  assert.equal(delivery.messages().length,2);assert.ok(accepted.teamReview.management.usedTokens>0);
});
test('real Harness resumes a paused supervisor session against the same report with a fresh decision receipt',{timeout:60000},async t=>{
  const {tasks}=fixture(t);
  tasks.create({id:'paused-review-task',kind:'agent',title:'暂停后验收',goal:'生成 report.md。REWORK_COMPLETE_MARKER PAUSE_REVIEW_FIXTURE',assignedBotId:'employee',timeoutMs:20000});
  let reviewing;const deadline=Date.now()+45000;
  while(Date.now()<deadline){
    const child=tasks.all().find(task=>task.managementReview);
    if(child){const detail=tasks.detail(child.id);if(child.status==='running'&&detail.runs[0].jobs.some(job=>job.tool==='read'&&job.status==='completed')){reviewing={child,detail};break;}}
    await delay(20);
  }
  assert.ok(reviewing,'the management Harness must actually read evidence before pausing');
  const target=tasks.row('task','paused-review-task'),report=tasks.reports.current(target),firstRun=reviewing.child.runId,sessionId=reviewing.child.sessionId;
  tasks.supervisor.configure({id:target.id,runId:target.runId,paused:true});
  assert.equal(tasks.row('task',reviewing.child.id).status,'pausing');
  tasks.supervisor.configure({id:target.id,runId:target.runId,paused:false});
  assert.equal(tasks.supervisor.history(target.id)[0].resumePending,true);assert.equal(tasks.row('task',reviewing.child.id).runId,firstRun);
  while(Date.now()<deadline&&!tasks.supervisor.isAccepted(report)){
    const review=tasks.supervisor.history(target.id)[0];
    if(['needs_user','failed','budget_exhausted','stale'].includes(review.status))throw Error(JSON.stringify({review,detail:tasks.detail(reviewing.child.id),log:tasks.log({id:reviewing.child.id}).text}));
    await delay(20);
  }
  assert.equal(tasks.supervisor.isAccepted(report),true);
  const child=tasks.row('task',reviewing.child.id),detail=tasks.detail(child.id);
  assert.equal(child.sessionId,sessionId);assert.equal(child.managementReview.reportId,report.id);assert.notEqual(child.runId,firstRun);
  assert.equal(detail.runs.length,2);assert.equal(detail.runs[0].status,'paused');assert.equal(detail.runs[0].job.cleanupConfirmed,true);
  assert.equal(detail.runs[1].status,'completed');assert.deepEqual(detail.runs[1].jobs.map(job=>job.tool),['read','read','review_decide']);
  const receipt=JSON.parse(readFileSync(join(tasks.directory(detail.runs[1].job),'review-decision.json'),'utf8'));
  assert.equal(receipt.managementRunId,detail.runs[1].id);assert.equal(receipt.reportId,report.id);
  assert.equal(tasks.all().filter(task=>task.managementReview).length,1);assert.equal(tasks.detail(target.id).runs.length,1);
});
