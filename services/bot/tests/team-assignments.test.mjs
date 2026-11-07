import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Operations} from '../operations.mjs';
import {TaskManager} from '../tasks/manager.mjs';
import {TeamRegistry} from '../team/registry.mjs';
import {TeamSupervisor} from '../team/supervisor.mjs';
import {prepareDocuments} from '../tasks/documents.mjs';
import {stageTaskInputs} from '../tasks/inputs.mjs';
import {saveJson} from '../tasks/agent-files.mjs';
function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'nova-handoff-')),workspace=join(home,'project');
  const ops=new Operations({home,workspace}),tasks=new TaskManager({ops,home,workspace});tasks.foregroundBusy=()=>true;
  const state={mainBotIds:['chief'],bots:{chief:{id:'chief',name:'总管'},a:{id:'a',name:'资料员'},b:{id:'b',name:'编辑'}}};
  const rt={home:join(home,'bot'),state,botOf:id=>state.bots[id]};
  tasks.team=new TeamRegistry({rt,db:ops.db,workspace});tasks.team.tasks=tasks;
  for(const id of ['a','b'])tasks.team.put('bot:'+id,{enabled:true,revision:1,taskTypes:[]});
  tasks.supervisor=new TeamSupervisor({tasks,reports:tasks.reports,createManagementTask:()=>{throw Error('unexpected management');}});
  t.after(async()=>{await tasks.close();ops.close();rmSync(home,{recursive:true,force:true});});return {tasks,home,workspace};
}
const create=(tasks,id,extra={})=>tasks.create({id,kind:'agent',assignedBotId:'a',title:id,goal:'整理资料',managementEnabled:false,...extra});
async function completed(tasks,id){
  const t=tasks.row('task',id),run=tasks.row('run',t.runId),job=tasks.row('job',run.jobId);
  const workspace=await prepareDocuments({source:tasks.workspace,home:tasks.agentHome(t),mode:'edit',workspaceMode:'general'});
  writeFileSync(join(workspace.path,'report.md'),'固定版本成果');mkdirSync(tasks.directory(job),{recursive:true});
  saveJson(join(tasks.directory(job),'agent-result.json'),{runId:run.id,taskId:id,status:'completed',text:'已整理资料，report.md 已生成。'});
  tasks.finish(t,run,job,{status:'completed',cleanupConfirmed:true,exitCode:0});return tasks.reports.current(tasks.row('task',id));
}
const accept=(tasks,id,report)=>tasks.review({id,runId:report.runId,reportId:report.id,actionId:'accept-'+report.id,action:'accept',text:'用户已核对成果，验收通过。'});
test('explicit dependencies wait for acceptance, pin immutable inputs once, and mark later changes stale',async t=>{
  const {tasks}=fixture(t);create(tasks,'source');const report=await completed(tasks,'source');
  create(tasks,'consumer',{assignedBotId:'b',dependsOn:['source']});tasks.assignments.tick();
  assert.equal(tasks.row('task','consumer').status,'blocked');assert.match(tasks.row('task','consumer').blockedReason,/waiting_acceptance/);
  accept(tasks,'source',report);tasks.assignments.tick();let consumer=tasks.row('task','consumer');
  assert.equal(consumer.status,'queued');assert.equal(consumer.dependencyInputs[0].reportId,report.id);
  const runId=consumer.runId;tasks.assignments.tick();assert.equal(tasks.row('task','consumer').runId,runId);
  const space=await prepareDocuments({source:tasks.workspace,home:tasks.agentHome(consumer),mode:'edit',workspaceMode:'general'});
  stageTaskInputs({workspace:space,inputs:consumer.transferInputs});const path=join(space.path,consumer.transferInputs[0].name);
  assert.equal(readFileSync(path,'utf8'),'固定版本成果');
  writeFileSync(path,'下游自己的修改');stageTaskInputs({workspace:space,inputs:consumer.transferInputs});assert.equal(readFileSync(path,'utf8'),'下游自己的修改');
  tasks.continue({id:'source',runId:report.runId,actionId:'new-source',text:'再增加资料'});tasks.assignments.tick();consumer=tasks.row('task','consumer');
  assert.deepEqual(consumer.inputsStale,['source']);assert.equal(consumer.dependencyInputs[0].reportId,report.id);assert.equal(readFileSync(path,'utf8'),'下游自己的修改');
});
test('dependency cycles, stale form submissions and mutation after launch are rejected',t=>{
  const {tasks}=fixture(t);const a=create(tasks,'a-task'),b=create(tasks,'b-task',{dependsOn:['a-task']});
  assert.throws(()=>tasks.setDependencies({id:'a-task',runId:a.task.runId,dependsOn:['b-task']}),/cycle/);
  assert.throws(()=>tasks.setDependencies({id:'a-task',runId:'stale',dependsOn:[]}),/run_changed/);
  const run=tasks.row('run',b.task.runId);tasks.put('run',{...run,startedAt:Date.now()});
  assert.throws(()=>tasks.setDependencies({id:'b-task',runId:run.id,dependsOn:[]}),/locked/);
});
test('reassignment waits for confirmed process cleanup and gives the next owner a fresh session and workspace',async t=>{
  const {tasks}=fixture(t);create(tasks,'handoff');const report=await completed(tasks,'handoff');
  const old=tasks.row('task','handoff'),oldHome=tasks.agentHome(old),oldRun=tasks.row('run',old.runId),oldJob=tasks.row('job',oldRun.jobId);
  // Simulate a stopped worker whose descendant cleanup is still unresolved.
  tasks.put('job',{...oldJob,cleanupConfirmed:false});
  const input={id:old.id,runId:old.runId,assignmentVersion:1,assignedBotId:'b',actionId:'handoff-1',summary:'保留已整理内容，继续校对',reportId:report.id};
  tasks.reassign(input);assert.equal(tasks.row('task',old.id).assignedBotId,'a');assert.equal(tasks.row('task',old.id).handoff.status,'stopping');
  tasks.put('job',{...oldJob,cleanupConfirmed:true});tasks.assignments.tick();const next=tasks.row('task',old.id);
  assert.equal(next.assignedBotId,'b');assert.equal(next.assignmentVersion,2);assert.notEqual(next.sessionId,old.sessionId);assert.notEqual(tasks.agentHome(next),oldHome);
  assert.equal(next.handoff.status,'completed');assert.equal(next.transferInputs[0].reportId,report.id);
  assert.equal(tasks.detail(old.id).runs.length,2);assert.equal(tasks.reassign(input).task.runId,next.runId);
  assert.throws(()=>accept(tasks,old.id,report),/run_changed|stale/);
  tasks.finish(old,oldRun,oldJob,{status:'completed',cleanupConfirmed:true});assert.equal(tasks.row('task',old.id).runId,next.runId);
});
test('changed accepted files block new consumers and transferred snapshot corruption is detected',async t=>{
  const {tasks}=fixture(t);create(tasks,'source');const report=await completed(tasks,'source');accept(tasks,'source',report);
  const artifact=report.artifacts[0];writeFileSync(artifact.sourcePath,'changed after acceptance');
  create(tasks,'consumer',{dependsOn:['source']});tasks.assignments.tick();assert.equal(tasks.row('task','consumer').status,'blocked');
  const space=await prepareDocuments({source:tasks.workspace,home:tasks.agentHome(tasks.row('task','consumer')),mode:'edit',workspaceMode:'general'});
  const input={reportId:report.id,artifactId:artifact.id,name:'dependencies/report.md',path:artifact.path,sha256:artifact.sha256};writeFileSync(artifact.path,'corrupt snapshot');
  assert.throws(()=>stageTaskInputs({workspace:space,inputs:[input]}),/artifact_changed/);
});
test('disabled employees expose a blocking reason without silently choosing a different owner',t=>{
  const {tasks}=fixture(t);const d=create(tasks,'blocked-worker');tasks.team.put('bot:a',{enabled:false,revision:2,taskTypes:[]});tasks.assignments.tick();
  const task=tasks.row('task',d.task.id);assert.equal(task.status,'blocked');assert.equal(task.blockedReason,'team_member_disabled');assert.equal(task.assignedBotId,'a');
});
test('handoff preserves already pinned dependency material in the new employee workspace',async t=>{
  const {tasks}=fixture(t);create(tasks,'source');const sourceReport=await completed(tasks,'source');accept(tasks,'source',sourceReport);
  create(tasks,'consumer',{dependsOn:['source']});tasks.assignments.tick();const old=tasks.row('task','consumer'),inputs=old.transferInputs;
  tasks.reassign({id:old.id,runId:old.runId,assignmentVersion:old.assignmentVersion,assignedBotId:'b',actionId:'switch-consumer',summary:'使用原已验收资料继续整理'});
  const next=tasks.row('task',old.id);assert.equal(next.assignmentVersion,2);assert.deepEqual(next.transferInputs,inputs);
  const space=await prepareDocuments({source:tasks.workspace,home:tasks.agentHome(next),mode:'edit',workspaceMode:'general'});
  stageTaskInputs({workspace:space,inputs:next.transferInputs});assert.equal(readFileSync(join(space.path,inputs[0].name),'utf8'),'固定版本成果');
});
test('a new managed task cannot exceed its smaller cumulative budget in its first Run',t=>{
  const {tasks}=fixture(t),d=create(tasks,'small-budget',{managementEnabled:true,managementTokenBudget:4000,managementTimeBudgetMs:5000});
  assert.deepEqual(d.runs[0].executionBudget,{tokenBudget:4000,timeoutMs:5000});
});
test('explicit continuation and handoff retain the configured cumulative ceiling until the user adjusts it',async t=>{
  const {tasks}=fixture(t);create(tasks,'limited',{managementEnabled:true,managementTokenBudget:4000});const report=await completed(tasks,'limited');
  const old=tasks.row('task','limited'),run=tasks.row('run',old.runId);saveJson(join(tasks.directory(tasks.row('job',run.jobId)),'progress.json'),{totalTokens:4000});
  assert.throws(()=>tasks.continue({id:old.id,runId:old.runId,actionId:'manual-resume',text:'继续'}),/budget_exhausted/);
  const input={id:old.id,runId:old.runId,assignmentVersion:old.assignmentVersion,assignedBotId:'b',actionId:'budget-handoff',summary:'保留成果继续校对',reportId:report.id};
  tasks.reassign(input);assert.equal(tasks.row('task',old.id).assignedBotId,'a');assert.equal(tasks.row('task',old.id).blockedReason,'management_budget_exhausted');
  tasks.configureManagement({id:old.id,runId:old.runId,tokenBudget:8000});tasks.assignments.tick();
  const next=tasks.row('task',old.id);assert.equal(next.assignedBotId,'b');assert.equal(tasks.row('run',next.runId).executionBudget.tokenBudget,4000);
});
test('an asynchronous check is limited by the parent managed task remaining execution time',async t=>{
  const {tasks}=fixture(t),d=create(tasks,'check-budget',{managementEnabled:true,managementTimeBudgetMs:5000,autoContinue:1});
  const task=tasks.row('task',d.task.id),run=tasks.row('run',task.runId);task.status='running';run.status='running';run.startedAt=Date.now()-1000;tasks.put('task',task);tasks.put('run',run);
  await prepareDocuments({source:tasks.workspace,home:tasks.agentHome(task),mode:'edit',workspaceMode:'general'});
  const child=tasks.createCheck({taskId:task.id,runId:run.id,stepId:'check',command:'true',timeoutMs:600000});
  assert.ok(child.task.timeoutMs<=4000&&child.task.timeoutMs>=1000);
  tasks.put('task',{...task,status:'paused'});tasks.put('run',{...run,status:'paused'});
});
