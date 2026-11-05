import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Operations} from '../operations.mjs';
import {TaskManager} from '../tasks/manager.mjs';
import {git,prepareWorkspace,workspaceDiff,applyWorkspace} from '../tasks/workspace.mjs';
const provider=fileURLToPath(new URL('./fixtures/task-provider.mjs',import.meta.url));
async function until(fn,ms=40000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await delay(50);}throw Error('condition timed out');}
async function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'nova-agent-')),workspace=join(home,'project'),ops=new Operations({home,workspace});
  await git(workspace,['init','-q']);await git(workspace,['config','user.name','Test']);await git(workspace,['config','user.email','test@localhost']);
  writeFileSync(join(workspace,'sample.txt'),'original\n');writeFileSync(join(workspace,'.gitignore'),'secret\n');await git(workspace,['add','.']);await git(workspace,['commit','-qm','fixture']);
  const tasks=new TaskManager({ops,home,workspace,agentProviderModule:provider}),managers=[tasks];
  t.after(async()=>{for(const manager of managers)await manager.close();ops.close();rmSync(home,{recursive:true,force:true});});return {home,workspace,ops,tasks,managers};
}
const done=(tasks,id)=>until(()=>{const d=tasks.detail(id);return !['running','queued','cancelling','pausing'].includes(d.task.status)&&d.task.cleanupConfirmed&&d;});
const start=(tasks,goal,extra={})=>tasks.create({id:'agent',kind:'agent',title:'Fixture',goal,mode:'edit',timeoutMs:60000,...extra});
test('real Harness performs native read/write/test in isolation and continues its persisted session',async t=>{
  const {tasks,workspace}=await fixture(t);start(tasks,'FIXTURE_EDIT REMEMBER_ALPHA');
  const d=await done(tasks,'agent');assert.equal(d.task.status,'completed',tasks.log({id:'agent'}).text);
  assert.equal(readFileSync(join(workspace,'sample.txt'),'utf8'),'original\n');
  assert.equal(readFileSync(join(d.workspace.path,'sample.txt'),'utf8'),'updated\n',JSON.stringify(d));
  assert.equal(d.runs[0].jobs.find(j=>j.tool==='task_command').exitCode,0);assert.ok(d.runs[0].progress.totalTokens>0);assert.equal(d.runs[0].progress.estimatedTokens,true);
  tasks.continue({id:'agent',runId:d.task.runId,actionId:'next',text:'请报告之前记住的标记。'});
  const next=await done(tasks,'agent');assert.equal(next.task.status,'completed',tasks.log({id:'agent'}).text);
  assert.equal(next.task.sessionId,d.task.sessionId);assert.match(next.runs[1].result.text,/remembered=true/);
});
test('dirty snapshot, repeat apply and conflicts preserve source index and ignored data',async t=>{
  const {tasks,workspace}=await fixture(t),home=tasks.agentHome({id:'work'});
  writeFileSync(join(workspace,'sample.txt'),'dirty\n');writeFileSync(join(workspace,'secret'),'credential');
  const index=await git(workspace,['diff','--cached']);const w=await prepareWorkspace({source:workspace,home,taskId:'work',mode:'edit'});
  assert.equal(existsSync(join(w.path,'secret')),false);assert.equal(readFileSync(join(w.path,'sample.txt'),'utf8'),'dirty\n');
  writeFileSync(join(w.path,'sample.txt'),'first\n');let diff=await workspaceDiff(home);
  const first=await applyWorkspace(home,{revision:diff.revision,actionId:'first'});assert.equal(first.status,'applied');assert.deepEqual(await applyWorkspace(home,{revision:diff.revision,actionId:'first'}),first);
  assert.equal((await workspaceDiff(home)).empty,true);
  writeFileSync(join(w.path,'new.bin'),Buffer.from([0,1,2,255]));writeFileSync(join(w.path,'sample.txt'),'second\n');diff=await workspaceDiff(home);await applyWorkspace(home,{revision:diff.revision,actionId:'second'});
  assert.equal(readFileSync(join(workspace,'sample.txt'),'utf8'),'second\n');assert.deepEqual(readFileSync(join(workspace,'new.bin')),Buffer.from([0,1,2,255]));assert.equal(await git(workspace,['diff','--cached']),index);
  writeFileSync(join(workspace,'sample.txt'),'user edit\n');writeFileSync(join(w.path,'sample.txt'),'third\n');diff=await workspaceDiff(home);await assert.rejects(applyWorkspace(home,{revision:diff.revision,actionId:'conflict'}),/task_apply_conflict/);
});
test('pause terminates nested commands, preserves files, and resume after host restart keeps the session',async t=>{
  const {tasks,ops,home,workspace,managers}=await fixture(t);start(tasks,'FIXTURE_COMMAND REMEMBER_ALPHA');
  const work=await until(()=>{const d=tasks.detail('agent');return d.workspace&&existsSync(join(d.workspace.path,'started'))&&d;});
  const stepId=work.runs[0].jobs.find(j=>j.tool==='task_command').id;
  await until(()=>tasks.log({id:'agent',runId:work.task.runId,stepId}).text.includes('command running'));
  assert.throws(()=>tasks.log({id:'agent',stepId:'../../outside'}),/unknown_task_step/);
  tasks.pause({id:'agent',runId:work.task.runId});const paused=await done(tasks,'agent');assert.equal(paused.task.status,'paused');assert.equal(paused.runs[0].jobs.find(j=>j.tool==='task_command').status,'interrupted');assert.throws(()=>process.kill(Number(readFileSync(join(work.workspace.path,'started'),'utf8')),0),{code:'ESRCH'});
  await tasks.close();const reopened=new TaskManager({ops,home,workspace,agentProviderModule:provider});managers.push(reopened);
  assert.equal(reopened.detail('agent').task.status,'paused');
  // Original goal still contains the long-command marker; continuation checks
  // its own instruction and must not replay that command.
  reopened.continue({id:'agent',runId:paused.task.runId,actionId:'resume',text:'RESUME_ONLY'});
  const resumed=await done(reopened,'agent');assert.equal(resumed.task.status,'completed',reopened.log({id:'agent'}).text);assert.match(resumed.runs[1].result.text,/remembered=true/);
});
test('question waits and explicit continuation consumes the durable supplement once',async t=>{
  const {tasks}=await fixture(t);start(tasks,'FIXTURE_QUESTION');let d=await done(tasks,'agent');assert.equal(d.task.status,'waiting_input');assert.equal(d.task.question,'需要哪种颜色？');
  tasks.message({id:'agent',messageId:'answer',text:'选择蓝色 REMEMBER_ALPHA'});assert.equal(tasks.detail('agent').messages[0].delivery.status,'pending');
  tasks.continue({id:'agent',runId:d.task.runId,actionId:'answer',text:'RESUME_ONLY'});d=await done(tasks,'agent');assert.equal(d.task.status,'completed');assert.equal(d.messages[0].delivery.status,'delivered');assert.match(d.runs[1].result.text,/remembered=true/);
});
test('read-only tools refuse writes, model budget stops the turn, invalid command never blocks queue',async t=>{
  const {tasks}=await fixture(t);start(tasks,'FIXTURE_EDIT',{mode:'analysis',maxSteps:2});const d=await done(tasks,'agent');assert.equal(d.task.status,'failed');assert.equal(readFileSync(join(d.workspace.path,'sample.txt'),'utf8'),'original\n');
  tasks.create({id:'invalid',kind:'agent',title:'invalid',goal:'FIXTURE_INVALID',mode:'edit',timeoutMs:30000});assert.equal((await done(tasks,'invalid')).task.status,'completed');
  tasks.create({id:'after',title:'queue remains available',command:'true'});assert.equal((await done(tasks,'after')).task.status,'completed');
});

test('requirements saved during an active turn are delivered at its boundary without replaying the original operation',async t=>{
  const {tasks}=await fixture(t);start(tasks,'FIXTURE_DELAY');
  await until(()=>tasks.detail('agent').runs[0].progress?.steps===1);
  const message={id:'agent',messageId:'during',text:'REMEMBER_ALPHA'};
  tasks.message(message);tasks.message(message);assert.throws(()=>tasks.message({...message,text:'conflict'}),/task_id_conflict/);
  const d=await done(tasks,'agent');assert.equal(d.task.status,'completed');assert.equal(d.messages.length,1);assert.equal(d.messages[0].delivery.status,'delivered');assert.match(d.runs[0].result.text,/remembered=true/);assert.equal(d.runs[0].progress.steps,2);
});
test('workspace creation recovery only accepts a completed clean worktree; new diff invalidates review',async t=>{
  const {tasks,workspace}=await fixture(t),home=tasks.agentHome({id:'recover'});
  const w=await prepareWorkspace({source:workspace,home,taskId:'recover',mode:'edit'});
  rmSync(join(home,'workspace.json'));assert.equal((await prepareWorkspace({source:workspace,home,taskId:'recover',mode:'edit'})).base,w.base);
  writeFileSync(join(w.path,'sample.txt'),'one\n');const diff=await workspaceDiff(home);writeFileSync(join(w.path,'sample.txt'),'two\n');
  await assert.rejects(applyWorkspace(home,{revision:diff.revision,actionId:'stale'}),/task_diff_changed/);
  rmSync(join(home,'workspace.json'));await assert.rejects(prepareWorkspace({source:workspace,home,taskId:'recover',mode:'edit'}),/workspace_preparation_interrupted/);
});

test('token budget rejects a request even when the adapter does not report usage',async t=>{
  const {tasks}=await fixture(t);start(tasks,'FIXTURE_EDIT '+'.'.repeat(6000),{tokenBudget:1000});
  const d=await done(tasks,'agent');assert.equal(d.task.status,'failed');assert.match(tasks.log({id:'agent'}).text,/task_token_budget_exhausted/);assert.equal(d.runs[0].jobs.length,0);
});

test('a failed policy plugin prevents model execution instead of exposing unguarded native tools',async t=>{
  const {tasks}=await fixture(t);tasks.agentPluginModule=join(tasks.root,'missing-plugin.mjs');start(tasks,'FIXTURE_EDIT',{mode:'analysis'});
  const d=await done(tasks,'agent');assert.equal(d.task.status,'failed');assert.match(tasks.log({id:'agent'}).text,/task_policy_not_ready/);assert.equal(readFileSync(join(d.workspace.path,'sample.txt'),'utf8'),'original\n');assert.equal(d.runs[0].jobs.length,0);
});
