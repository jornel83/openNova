import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Operations} from '../operations.mjs';
import {TaskManager,taskTools} from '../tasks/manager.mjs';
import {capBudget,remainingBudget} from '../tasks/budgets.mjs';

function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'nova-budgets-')),workspace=join(home,'project'),ops=new Operations({home,workspace});
  const tasks=new TaskManager({ops,home,workspace});tasks.tick=()=>{};
  t.after(async()=>{await tasks.close();ops.close();rmSync(home,{recursive:true,force:true});});return tasks;
}
const input={id:'work',kind:'agent',title:'任务',goal:'完成工作'};

test('new agent tasks persist unlimited defaults without enabling additional continuations',t=>{
  const tasks=fixture(t),detail=tasks.create(input),task=tasks.row('task',detail.task.id);
  assert.deepEqual([task.maxSteps,task.tokenBudget,task.timeoutMs,task.management.tokenBudget,task.management.timeBudgetMs],[0,0,0,0,0]);
  assert.equal(task.management.maxReworks,2);assert.equal(task.autoContinue,undefined);
  assert.equal(task.budgetVersion,2);assert.throws(()=>tasks.create({...input,maxSteps:32,tokenBudget:200000,timeoutMs:1800000,managementTokenBudget:600000,managementTimeBudgetMs:7200000}),/task_id_conflict/);
  assert.equal(JSON.parse(tasks.db.prepare('SELECT body FROM background_task WHERE id=?').get(task.id).body).timeoutMs,0);
  assert.equal(tasks.spec({title:'命令',command:'true'}).timeoutMs,1800000,'command task timeout is an independent option');
  const tool=taskTools(tasks,()=>({id:'request'})).find(([name])=>name==='background_agent_start');
  for(const key of ['maxSteps','tokenBudget','timeoutMs','managementTokenBudget','managementTimeBudgetMs'])assert.match(tool[2][key].description,/默认0.*不限制/);
});

test('explicit limits and per-dimension unlimited values are accepted, invalid values are rejected',t=>{
  const tasks=fixture(t),limited={...input,maxSteps:32,tokenBudget:200000,timeoutMs:1800000,managementTokenBudget:600000,managementTimeBudgetMs:7200000};
  const spec=tasks.spec(limited);assert.deepEqual([spec.maxSteps,spec.tokenBudget,spec.timeoutMs,spec.management.tokenBudget,spec.management.timeBudgetMs],[32,200000,1800000,600000,7200000]);
  for(const key of ['maxSteps','tokenBudget','timeoutMs','managementTokenBudget','managementTimeBudgetMs']){
    assert.doesNotThrow(()=>tasks.spec({...limited,[key]:0}));
    for(const bad of [-1,null,'0',Infinity,NaN,0.5])assert.throws(()=>tasks.spec({...input,[key]:bad}),/invalid_(agent_budget|task_timeout|management_budget)/);
  }
  assert.throws(()=>tasks.spec({...input,tokenBudget:999}),/invalid_agent_budget/);
  assert.throws(()=>tasks.spec({...input,managementTimeBudgetMs:999}),/invalid_management_budget/);
});

test('unlimited arithmetic never persists Infinity and finite cumulative budgets still stop continuation',t=>{
  const tasks=fixture(t);tasks.supervisor={usage:()=>({usedTokens:700000,usedDurationMs:9000000}),summary:()=>({}),view:()=>({})};
  tasks.create({...input,managementEnabled:true});let task=tasks.row('task',input.id);
  assert.deepEqual(tasks.runBudget(task),{tokenBudget:0,timeoutMs:0});
  let run=tasks.row('run',task.runId);assert.deepEqual(run.executionBudget,{tokenBudget:0,timeoutMs:0});
  tasks.newRun(task,2,'继续',{executionBudget:{tokenBudget:1500,timeoutMs:5000}});run=tasks.row('run',task.runId);
  assert.deepEqual(run.executionBudget,{tokenBudget:1500,timeoutMs:5000});
  task.tokenBudget=10000;task.timeoutMs=20000;
  assert.deepEqual(tasks.runBudget(task),{tokenBudget:10000,timeoutMs:20000});
  task.management.tokenBudget=705000;task.management.timeBudgetMs=9010000;
  assert.deepEqual(tasks.runBudget(task),{tokenBudget:5000,timeoutMs:10000});
  task.management.tokenBudget=700000;assert.throws(()=>tasks.runBudget(task),/management_budget_exhausted/);
  task.management.tokenBudget=0;task.management.timeBudgetMs=9000000;assert.throws(()=>tasks.runBudget(task),/management_budget_exhausted/);
  assert.equal(capBudget(600000,0),600000,'unlimited parent does not erase a command check timeout');
  assert.equal(capBudget(0,remainingBudget(0,9999999)),0);
});

test('existing persisted finite task limits survive reload and later rounds',t=>{
  const tasks=fixture(t),detail=tasks.create({...input,maxSteps:32,tokenBudget:200000,timeoutMs:1800000,managementEnabled:true,managementTokenBudget:600000,managementTimeBudgetMs:7200000});
  const before=tasks.row('task',detail.task.id);delete before.budgetVersion;tasks.put('task',before);
  assert.equal(tasks.create({...input,managementEnabled:true}).task.runId,detail.task.runId,'old omitted defaults retry the same submission after upgrade');
  assert.throws(()=>tasks.create({...input,managementEnabled:true,tokenBudget:0}),/task_id_conflict/,'an explicit budget change remains a conflict');
  tasks.newRun(before,2,'继续');const after=tasks.row('task',detail.task.id),run=tasks.row('run',after.runId);
  assert.deepEqual([after.maxSteps,after.tokenBudget,after.timeoutMs],[32,200000,1800000]);
  assert.deepEqual([after.management.tokenBudget,after.management.timeBudgetMs],[600000,7200000]);
  assert.deepEqual(run.executionBudget,{tokenBudget:200000,timeoutMs:1800000});
  const command={id:'command',title:'命令',command:'true'},created=tasks.create({...command,managementTokenBudget:600000,managementTimeBudgetMs:7200000}),old=tasks.row('task','command');delete old.budgetVersion;tasks.put('task',old);
  assert.equal(tasks.create(command).task.runId,created.task.runId,'command submissions retain upgrade idempotency too');
});
