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
import {ANSWER,CORRECTION,QUESTION} from './fixtures/context-provider.mjs';

function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'nova-context-runtime-')),workspace=join(home,'project'),ops=new Operations({home,workspace});
  const tasks=new TaskManager({ops,home,workspace,agentProviderModule:fileURLToPath(new URL('./fixtures/context-provider.mjs',import.meta.url))});
  tasks.team={chiefId:'chief',assignment:input=>({assignedBotId:input.assignedBotId??'chief',supervisorBotId:'chief',reportTo:'chief',assignmentVersion:1}),
    snapshot:task=>({botId:task.assignedBotId,name:task.assignedBotId,role:task.assignedBotId==='chief'?'总管':'文案员'}),owner:task=>({ownerName:task.assignedBotId})};
  tasks.outbox=new TeamOutbox({db:ops.db,delivery:new ManagementDelivery({home,chiefId:'chief'})});
  tasks.supervisor=new TeamSupervisor({tasks,reports:tasks.reports,createManagementTask:({id,goal,budgets,managementReview})=>tasks.create({id,kind:'agent',title:'核对问答与成果',assignedBotId:'chief',goal,workspaceMode:'general',permission:'read-only',managementEnabled:false,...budgets},{source:'supervisor',managementReview})});
  t.after(async()=>{await tasks.close();ops.close();rmSync(home,{recursive:true,force:true});});
  return tasks;
}
async function reviewed(tasks,id,expected){
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){
    const task=tasks.row('task',id),report=tasks.reports.current(task),review=report&&tasks.supervisor.history(id).find(item=>item.reportId===report.id);
    if(review?.status===expected&&review.decision)return {task,report,review};
    if(review&&['accepted','needs_user','failed','budget_exhausted','stale'].includes(review.status))throw Error(JSON.stringify({expected,review,report,child:review.managementTaskId&&tasks.detail(review.managementTaskId),log:review.managementTaskId&&tasks.log({id:review.managementTaskId}).text}));
    await delay(20);
  }
  throw Error(JSON.stringify({error:'context_fixture_timeout',expected,tasks:tasks.all(),reviews:tasks.supervisor.history(id),scheduler:tasks.lastError}));
}
for(const entry of ['review-answer','continue'])test('real Harness preserves question and '+entry+' answer through independent review and later correction',{timeout:60000},async t=>{
  const tasks=fixture(t),id='context-'+entry;
  tasks.create({id,kind:'agent',title:'欢迎文案',goal:'先询问用户读书会名称，得到用户回答后生成 welcome.md。',acceptanceCriteria:'使用用户最新指定的名称，包含标题和一句欢迎文案。',assignedBotId:'employee',timeoutMs:20000});
  const first=await reviewed(tasks,id,'needs_user');assert.equal(first.task.status,'waiting_input');assert.equal(first.report.question,QUESTION);
  const firstBytes=readFileSync(join(tasks.reports.root,first.report.id,'report.json'),'utf8');
  if(entry==='review-answer')tasks.supervisor.userDecision({id,runId:first.task.runId,reportId:first.report.id,action:'answer',text:ANSWER,actionId:'answer-'+entry});
  else tasks.continue({id,runId:first.task.runId,text:ANSWER,actionId:'answer-'+entry});
  const second=await reviewed(tasks,id,'accepted'),events=second.report.taskContext.events;
  assert.ok(events.some(event=>event.kind==='question'&&event.source==='employee'&&event.runId===first.task.runId&&event.text===QUESTION));
  assert.ok(events.some(event=>event.kind==='instruction'&&event.source==='user'&&event.runId===second.task.runId&&event.text===ANSWER));
  const secondSnapshot=JSON.stringify(second.report.taskContext),secondBytes=readFileSync(join(tasks.reports.root,second.report.id,'report.json'),'utf8');
  assert.equal(tasks.detail(id).runs.length,2);assert.match(readFileSync(join(tasks.detail(id).workspace.path,'welcome.md'),'utf8'),/冬季读书会/);
  tasks.continue({id,runId:second.task.runId,text:CORRECTION,actionId:'correct-'+entry});
  const third=await reviewed(tasks,id,'accepted'),thirdEvents=third.report.taskContext.events;
  assert.equal(third.report.taskContext.throughRunId,third.task.runId);
  assert.ok(thirdEvents.some(event=>event.text===QUESTION));assert.ok(thirdEvents.some(event=>event.source==='user'&&event.text===ANSWER));
  assert.equal(thirdEvents.filter(event=>event.source==='user').at(-1).text,CORRECTION);
  assert.match(readFileSync(join(tasks.detail(id).workspace.path,'welcome.md'),'utf8'),/春日读书会/);assert.equal(tasks.detail(id).runs.length,3);
  assert.equal(JSON.stringify(tasks.reports.get(second.report.id).taskContext),secondSnapshot,'later corrections do not mutate prior report context');
  assert.equal(readFileSync(join(tasks.reports.root,first.report.id,'report.json'),'utf8'),firstBytes);assert.equal(readFileSync(join(tasks.reports.root,second.report.id,'report.json'),'utf8'),secondBytes);
  for(const delivery of [second,third]){
    const child=tasks.detail(delivery.review.managementTaskId),payload=JSON.parse(readFileSync(join(child.workspace.path,'report.json'),'utf8'));
    assert.deepEqual(payload.taskContext,delivery.report.taskContext,'the readonly management workspace receives the exact context snapshot');
    assert.deepEqual(child.runs[0].jobs.map(step=>step.tool),['read','read','review_decide']);assert.ok(child.runs[0].jobs.every(step=>step.status==='completed'));
    assert.equal(child.task.permission,'read-only');assert.notEqual(child.task.sessionId,tasks.row('task',id).sessionId);
  }
});
