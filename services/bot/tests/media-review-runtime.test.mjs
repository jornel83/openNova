import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
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
  const home=mkdtempSync(join(tmpdir(),'nova-media-review-')),workspace=join(home,'project'),ops=new Operations({home,workspace});
  const tasks=new TaskManager({ops,home,workspace,agentProviderModule:fileURLToPath(new URL('./fixtures/media-review-provider.mjs',import.meta.url))});
  tasks.team={chiefId:'chief',assignment:input=>({assignedBotId:input.assignedBotId??'chief',supervisorBotId:'chief',reportTo:'chief',assignmentVersion:1}),
    snapshot:task=>({botId:task.assignedBotId,name:task.assignedBotId,role:task.assignedBotId==='chief'?'总管':'员工'}),owner:task=>({ownerName:task.assignedBotId})};
  const delivery=new ManagementDelivery({home,chiefId:'chief'});tasks.outbox=new TeamOutbox({db:ops.db,delivery});
  tasks.supervisor=new TeamSupervisor({tasks,reports:tasks.reports,createManagementTask:({id,goal,budgets,managementReview})=>tasks.create({id,kind:'agent',title:'只检查媒体是否生成',assignedBotId:'chief',goal,workspaceMode:'general',permission:'read-only',managementEnabled:false,...budgets},{source:'supervisor',managementReview})});
  t.after(async()=>{await tasks.close();ops.close();rmSync(home,{recursive:true,force:true});});
  return {tasks,delivery};
}

async function waitReview(tasks,id){
  const deadline=Date.now()+45000;
  while(Date.now()<deadline){
    const review=tasks.supervisor.history(id).find(value=>['accepted','needs_user','failed','budget_exhausted'].includes(value.status));
    if(review)return review;
    if(tasks.row('task',id).status==='failed')throw Error(JSON.stringify({task:tasks.detail(id),log:tasks.log({id}).text}));
    await delay(30);
  }
  throw Error(JSON.stringify({tasks:tasks.all(),reviews:tasks.supervisor.history(id),scheduler:tasks.lastError}));
}

for(const [assignee,format] of [['employee','png'],['chief','mp4']])test(`real Harness automatically accepts generated ${format} from ${assignee} without a human or rework`,{timeout:60000},async t=>{
  const {tasks,delivery}=fixture(t),id='media-'+format;
  const created=tasks.create({id,kind:'agent',title:'生成本地媒体',goal:'生成一个本地媒体文件。MEDIA_FIXTURE_'+format.toUpperCase(),assignedBotId:assignee,timeoutMs:20000});
  const review=await waitReview(tasks,id),detail=tasks.detail(id),report=tasks.reports.current(tasks.row('task',id));
  assert.equal(review.status,'accepted',JSON.stringify({review,logs:review.managementTaskId&&tasks.log({id:review.managementTaskId}).text}));
  assert.equal(review.source,'supervisor');assert.equal(detail.runs.length,1);assert.equal(detail.task.runId,created.task.runId);assert.equal(detail.task.management.usedReworks,0);
  assert.equal(report.artifacts.length,1);assert.equal(report.artifacts[0].name,'result.'+format);assert.ok(statSync(report.artifacts[0].path).size>0);
  assert.equal(report.evidence.commands.length,1);assert.equal(report.evidence.commands[0].exitCode,0);
  assert.equal(tasks.all().filter(task=>task.managementReview).length,1);assert.equal(delivery.messages().length,1);
  const child=tasks.detail(review.managementTaskId);
  assert.equal(child.task.permission,'read-only');assert.notEqual(child.task.sessionId,detail.task.sessionId);
  assert.deepEqual(child.runs[0].jobs.map(job=>job.tool),['read','read','review_decide']);assert.ok(child.runs[0].jobs.every(job=>job.status==='completed'));
  const evidence=JSON.parse(readFileSync(join(review.managementReview.evidenceDirectory,'report.json'),'utf8'));
  assert.equal(evidence.artifacts[0].reviewContent,'generated_media');assert.match(evidence.artifacts[0].path,/\.json$/);
  const receipt=JSON.parse(readFileSync(join(tasks.directory(child.runs[0].job),'review-decision.json'),'utf8'));
  assert.equal(receipt.decision.action,'accept');assert.deepEqual(receipt.decision.evidenceIds,[report.artifacts[0].id]);
});

test('real Harness cannot accept media without reading its generation receipt',{timeout:60000},async t=>{
  const {tasks}=fixture(t),id='media-uninspected';
  tasks.create({id,kind:'agent',title:'生成媒体证明必须被检查',goal:'生成本地 PNG。MEDIA_FIXTURE_PNG MEDIA_SKIP_RECEIPT',timeoutMs:20000});
  const review=await waitReview(tasks,id),detail=tasks.detail(id);
  assert.equal(review.status,'needs_user');assert.equal(detail.runs.length,1);assert.equal(detail.task.management.usedReworks,0);
  const child=tasks.detail(review.managementTaskId),attempt=child.runs[0].jobs.find(job=>job.tool==='review_decide');
  assert.equal(attempt.status,'failed');assert.match(JSON.stringify(attempt),/review_artifact_not_inspected/);
  assert.equal(tasks.supervisor.isAccepted(tasks.reports.current(tasks.row('task',id))),false);
});
