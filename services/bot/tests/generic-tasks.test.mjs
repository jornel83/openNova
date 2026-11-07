import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Operations} from '../operations.mjs';
import {TaskManager} from '../tasks/manager.mjs';

const provider=fileURLToPath(new URL('./fixtures/task-provider.mjs',import.meta.url));
function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'nova-general-')),workspace=join(home,'project'),ops=new Operations({home,workspace});
  writeFileSync(join(workspace,'sample.txt'),'original\n');
  const tasks=new TaskManager({ops,home,workspace,agentProviderModule:provider}),managers=[tasks];
  t.after(async()=>{for(const manager of managers)await manager.close();ops.close();rmSync(home,{recursive:true,force:true});});
  return {home,workspace,ops,tasks,managers};
}
async function done(tasks,id){
  const deadline=Date.now()+40000;
  while(Date.now()<deadline){
    const d=tasks.detail(id);
    if(!['queued','running','pausing','cancelling'].includes(d.task.status)&&d.task.cleanupConfirmed)return d;
    await delay(50);
  }
  throw Error('task did not settle: '+tasks.log({id}).text);
}
const start=(tasks,extra={})=>tasks.create({id:'generic',kind:'agent',title:'通用工作',goal:'FIXTURE_GENERIC_PIPELINE',inputFiles:['sample.txt'],timeoutMs:30000,...extra});

for(const template of ['general','documents'])test(`${template} template reads input, runs a processing script and delivers files with full permission`,async t=>{
  const {tasks,workspace}=fixture(t);
  assert.equal(existsSync(join(workspace,'.git')),false);
  // Omitting both fields exercises the general/full defaults; the documents
  // case proves the template no longer removes command capability.
  start(tasks,template==='general'?{}:{workspaceMode:template,permission:'full'});
  const d=await done(tasks,'generic');assert.equal(d.task.status,'completed',tasks.log({id:'generic'}).text);
  assert.equal(d.task.workspaceMode,template);assert.equal(d.task.permission,'full');assert.equal(d.task.policyVersion,2);
  assert.equal(d.workspace.kind,template);assert.equal(d.runs[0].permission,'full');
  assert.deepEqual(d.runs[0].jobs.map(j=>[j.tool,j.status]),[['read','completed'],['write','completed'],['task_command','completed'],['read','completed']]);
  const command=d.runs[0].jobs.find(j=>j.tool==='task_command');assert.equal(command.exitCode,0);
  assert.match(tasks.log({id:d.task.id,runId:d.task.runId,stepId:command.id}).text,/processed input/);
  assert.equal(readFileSync(join(d.workspace.path,'processed.md'),'utf8'),'ORIGINAL\n');
  assert.equal(readFileSync(join(workspace,'sample.txt'),'utf8'),'original\n');
  assert.equal(existsSync(join(workspace,'processed.md')),false);
  assert.ok(d.runs[0].job.artifacts.some(a=>a.name==='processed.md'&&a.status==='available'));
  assert.ok(!d.runs[0].job.artifacts.some(a=>a.name==='sample.txt'));
  await assert.rejects(tasks.diff({id:d.task.id,runId:d.task.runId}),/no_git_diff/);
});

test('an edited input copy is delivered under its original name without changing the source file',async t=>{
  const {tasks,workspace}=fixture(t);start(tasks,{goal:'FIXTURE_EDIT'});
  const d=await done(tasks,'generic');assert.equal(d.task.status,'completed',tasks.log({id:'generic'}).text);
  assert.equal(d.task.workspaceMode,'general');assert.equal(d.runs[0].jobs.find(j=>j.tool==='task_command')?.exitCode,0);
  assert.equal(readFileSync(join(d.workspace.path,'sample.txt'),'utf8'),'updated\n');
  assert.equal(readFileSync(join(workspace,'sample.txt'),'utf8'),'original\n');
  const artifact=d.runs[0].job.artifacts.find(a=>a.name==='sample.txt');assert.ok(artifact,'edited input is a deliverable');
  assert.equal(artifact.status,'available');
  const file=tasks.artifact({id:d.task.id,runId:d.task.runId,artifactId:artifact.id});
  assert.equal(readFileSync(file.path,'utf8'),'updated\n');
});

test('read-only general and document tasks cannot write or run a command even if the model requests it',async t=>{
  const {tasks,workspace}=fixture(t);
  for(const workspaceMode of ['general','documents'])for(const [marker,tool] of [['WRITE','write'],['COMMAND','task_command']]){
    const id=workspaceMode+'-'+marker;
    start(tasks,{id,workspaceMode,permission:'read-only',goal:'FIXTURE_FORBIDDEN_'+marker,maxSteps:2});
    const d=await done(tasks,id);assert.equal(d.task.permission,'read-only');assert.equal(d.task.mode,'analysis');
    assert.ok(d.workspace,tasks.log({id}).text);
    assert.equal(existsSync(join(d.workspace.path,'forbidden.txt')),false);
    assert.ok(!d.runs[0].jobs.some(j=>j.tool===tool&&j.status==='completed'));
  }
  assert.equal(readFileSync(join(workspace,'sample.txt'),'utf8'),'original\n');
});

test('legacy document tasks keep their original command restriction through restart and continuation',async t=>{
  const {tasks,home,workspace,ops,managers}=fixture(t);
  const first=start(tasks,{workspaceMode:'documents',goal:'FIXTURE_FORBIDDEN_COMMAND',maxSteps:2});
  // Simulate the exact persisted M1 shape before the scheduler starts its Run.
  const old=tasks.row('task',first.task.id),run=tasks.row('run',first.task.runId);
  delete old.permission;delete old.policyVersion;delete run.permission;delete run.policyVersion;
  tasks.put('task',old);tasks.put('run',run);
  const d=await done(tasks,old.id);assert.ok(d.workspace,tasks.log({id:old.id}).text);
  assert.equal(existsSync(join(d.workspace.path,'forbidden.txt')),false);
  assert.ok(!d.runs[0].jobs.some(j=>j.tool==='task_command'&&j.status==='completed'));
  await tasks.close();const next=new TaskManager({ops,home,workspace,agentProviderModule:provider});managers.push(next);
  next.continue({id:d.task.id,runId:d.task.runId,actionId:'legacy-resume',text:'FIXTURE_FORBIDDEN_COMMAND'});
  const resumed=await done(next,d.task.id);
  assert.equal(resumed.task.policyVersion,undefined);assert.equal(resumed.task.permission,undefined);
  assert.equal(existsSync(join(resumed.workspace.path,'forbidden.txt')),false);
  assert.ok(!resumed.runs[1].jobs.some(j=>j.tool==='task_command'&&j.status==='completed'));
});

test('invalid or contradictory permissions are rejected before a task is created',t=>{
  const {tasks}=fixture(t);
  for(const permission of ['edit','analysis','unrestricted','',false])assert.throws(()=>start(tasks,{permission}),/invalid_task_permission/);
  assert.throws(()=>start(tasks,{permission:'full',mode:'analysis'}),/conflicting_task_permission/);
  assert.throws(()=>start(tasks,{permission:'read-only',mode:'edit'}),/conflicting_task_permission/);
  assert.throws(()=>start(tasks,{permission:'read-only',autoContinue:1}),/invalid_event_budget/);
  assert.equal(tasks.all().length,0);
});

test('an unprepared general workspace never lists source project files as deliverables',t=>{
  const {tasks,workspace}=fixture(t);
  writeFileSync(join(workspace,'source-only.md'),'not a task output');
  const task={id:'unprepared',kind:'agent',workspaceMode:'general',cwd:workspace,inputFiles:[],artifacts:[]};
  assert.deepEqual(tasks.artifacts(task,{id:'unprepared-job'}),[]);
});
