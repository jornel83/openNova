import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Operations} from '../operations.mjs';
import {TaskManager,taskTools} from '../tasks/manager.mjs';

function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'nova-management-policy-')),workspace=join(home,'project'),ops=new Operations({home,workspace});
  const tasks=new TaskManager({ops,home,workspace});tasks.tick=()=>{};
  tasks.team={chiefId:'chief',assignment:input=>({assignedBotId:input.assignedBotId??'chief',supervisorBotId:'chief',reportTo:'chief',assignmentVersion:1}),
    snapshot:task=>({botId:task.assignedBotId}),owner:()=>({})};
  t.after(async()=>{await tasks.close();ops.close();rmSync(home,{recursive:true,force:true});});return tasks;
}
const input={id:'work',kind:'agent',title:'独立检查',goal:'完成任务并交付可核对的成果'};

test('chief and employee business tasks default to review while explicit opt-outs and internal work stay disabled',t=>{
  const tasks=fixture(t),chief=tasks.create(input);
  assert.equal(chief.task.assignedBotId,'chief');assert.equal(chief.task.management.enabled,true);assert.equal(chief.task.managementPolicyVersion,1);
  assert.equal(tasks.create({...input,id:'employee',assignedBotId:'employee'}).task.management.enabled,true);
  assert.equal(tasks.create({id:'command',title:'命令',command:'true'}).task.management.enabled,true);
  assert.equal(tasks.create({...input,id:'manual',managementEnabled:false}).task.management.enabled,false);
  assert.equal(tasks.create({id:'manual-command',title:'命令',command:'true',managementEnabled:false}).task.management.enabled,false);
  for(const kind of [undefined,'skill-extraction']){
    const detail=tasks.create({...input,id:kind?'extraction':'review',managementEnabled:true},{source:'supervisor',managementReview:{kind,targetTaskId:chief.task.id}});
    assert.equal(detail.task.management.enabled,false,'internal tasks cannot enable their own review');
  }
  const check=tasks.create({id:'check',title:'检查子任务',command:'true',managementEnabled:true},{check:{taskId:chief.task.id,runId:chief.task.runId,workspace:tasks.workspace}});
  assert.equal(check.task.management.enabled,false);assert.equal(check.task.parentTaskId,chief.task.id);
});

test('retrying a pre-upgrade omitted management default preserves the original task and explicit choices still conflict',t=>{
  const tasks=fixture(t),first=tasks.create({...input,managementEnabled:false}),old=tasks.row('task',input.id);
  delete old.managementPolicyVersion;tasks.put('task',old);
  const replay=tasks.create(input);
  assert.equal(replay.task.runId,first.task.runId);assert.equal(replay.runs.length,1);assert.equal(replay.task.management.enabled,false);
  assert.throws(()=>tasks.create({...input,managementEnabled:true}),/task_id_conflict/);
  assert.throws(()=>tasks.create({...input,goal:'different work'}),/task_id_conflict/);
  const modern=tasks.create({...input,id:'modern',managementEnabled:false});
  assert.throws(()=>tasks.create({...input,id:modern.task.id}),/task_id_conflict/,'new explicit false is not treated as a legacy default');
});

test('management-default retry composes with legacy budget defaults without re-enabling history',t=>{
  const tasks=fixture(t),first=tasks.create({...input,managementEnabled:false,maxSteps:32,tokenBudget:200000,timeoutMs:1800000,managementTokenBudget:600000,managementTimeBudgetMs:7200000});
  const old=tasks.row('task',input.id);delete old.managementPolicyVersion;delete old.budgetVersion;tasks.put('task',old);
  const replay=tasks.create(input);
  assert.equal(replay.task.runId,first.task.runId);assert.equal(replay.task.management.enabled,false);assert.equal(replay.task.tokenBudget,200000);
  assert.throws(()=>tasks.create({...input,tokenBudget:0}),/task_id_conflict/);
  const command={id:'old-command',title:'命令',command:'true'};
  const prior=tasks.create({...command,managementEnabled:false}),saved=tasks.row('task',command.id);delete saved.managementPolicyVersion;tasks.put('task',saved);
  assert.equal(tasks.create(command).task.runId,prior.task.runId);assert.equal(tasks.row('task',command.id).management.enabled,false);
});

test('foreground command and agent tools preserve an explicit request to disable automatic checking',t=>{
  const tasks=fixture(t),tools=taskTools(tasks,()=>({id:'foreground-disable-review'}));
  for(const [name,args] of [['background_task_start',{title:'只执行命令',command:'true'}],['background_agent_start',{title:'只执行工作',goal:'创建报告'}]]){
    const tool=tools.find(([toolName])=>toolName===name);assert.equal(tool[2].managementEnabled.type,'boolean');
    const result=tool[3]({...args,managementEnabled:false});
    assert.equal(result.task.management.enabled,false);assert.equal(result.task.source,'assistant');
    assert.equal(tool[3]({...args,managementEnabled:false}).task.runId,result.task.runId);
  }
});
