import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Operations} from '../operations.mjs';
import {TaskManager} from '../tasks/manager.mjs';

function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'nova-full-check-')),workspace=join(home,'project'),external=join(home,'external'),ops=new Operations({home,workspace});mkdirSync(external);
  const tasks=new TaskManager({ops,home,workspace});clearInterval(tasks.timer);tasks.foregroundBusy=()=>true;
  t.after(async()=>{await tasks.close();ops.close();rmSync(home,{recursive:true,force:true});});
  function parent(id,patch={}){
    tasks.create({id,kind:'agent',title:id,goal:'fixture check',autoContinue:1});
    const task={...tasks.row('task',id),status:'running',...patch};tasks.put('task',task);
    const directory=join(tasks.agentHome(task),'workspace');mkdirSync(directory,{recursive:true});writeFileSync(join(tasks.agentHome(task),'workspace.json'),JSON.stringify({path:directory}));
    return task;
  }
  return {tasks,external,workspace,parent};
}

test('full access asynchronous check uses external cwd and keeps the real job receipt',async t=>{
  const {tasks,external,parent}=fixture(t),task=parent('full');
  const input={taskId:task.id,runId:task.runId,stepId:'outside-check',command:'printf verified > check-result.txt',workdir:external};
  const check=tasks.createCheck(input);assert.equal(check.task.cwd,realpathSync(external));assert.equal(tasks.createCheck(input).task.id,check.task.id);
  tasks.put('task',{...task,status:'waiting_event',automationPaused:true});
  const run=tasks.row('run',task.runId),job=tasks.row('job',run.jobId);tasks.put('run',{...run,status:'waiting_event'});tasks.put('job',{...job,status:'waiting_event',cleanupConfirmed:true});
  tasks.foregroundBusy=()=>false;const deadline=Date.now()+10000;let detail;
  while(Date.now()<deadline){tasks.tick();detail=tasks.detail(check.task.id);if(detail.task.status==='completed')break;await delay(25);}
  assert.equal(detail.task.status,'completed');assert.equal(detail.task.exitCode,0);assert.equal(detail.task.cleanupConfirmed,true);assert.equal(readFileSync(join(external,'check-result.txt'),'utf8'),'verified');
  assert.equal(detail.task.parentTaskId,task.id);assert.equal(detail.task.parentRunId,task.runId);
});

test('check directory authority comes from the stored parent and legacy scope stays restricted',t=>{
  const {tasks,external,parent}=fixture(t);
  const readonly=parent('readonly',{permission:'read-only',mode:'analysis'}),legacy=parent('legacy',{policyVersion:1,permission:undefined}),full=parent('full');
  const args=task=>({taskId:task.id,runId:task.runId,stepId:'outside',command:'true',workdir:external,permission:'full',policyVersion:2});
  assert.throws(()=>tasks.createCheck(args(readonly)),/task_check_unavailable/);
  assert.throws(()=>tasks.createCheck(args(legacy)),/invalid_task_workdir/);
  writeFileSync(join(external,'file'),'file');assert.throws(()=>tasks.createCheck({...args(full),workdir:join(external,'file')}),/invalid_task_workdir/);
  assert.throws(()=>tasks.createCheck({...args(full),workdir:join(external,'missing')}),/invalid_task_workdir/);
  assert.throws(()=>tasks.create({id:'standalone',title:'standalone',command:'true',workdir:external,permission:'full'}),/invalid_task_workdir/,'a command without an Agent permission grant keeps its existing project cwd contract');
});
