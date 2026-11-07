import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Operations} from '../operations.mjs';
import {TaskManager} from '../tasks/manager.mjs';
import {TeamRegistry} from '../team/registry.mjs';
import {TeamSupervisor} from '../team/supervisor.mjs';
import {readJson} from '../tasks/agent-files.mjs';

const provider=fileURLToPath(new URL('./fixtures/task-provider.mjs',import.meta.url));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
async function until(fn,ms=30000){
  const deadline=Date.now()+ms;
  while(Date.now()<deadline){const result=fn();if(result)return result;await delay(30);}
  throw Error('condition timed out');
}
function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'nova-real-handoff-')),workspace=join(home,'project');
  const ops=new Operations({home,workspace}),launches=[];
  let oldCommandPid;
  const options={ops,home,workspace,agentProviderModule:provider,spawnWorker:(command,args,options)=>{
    const spec=readJson(join(args[1],'agent-spec.json'));
    launches.push({spec,oldCommandAlive:oldCommandPid?alive(oldCommandPid):null});
    return spawn(command,args,options);
  }};
  const tasks=new TaskManager(options),managers=[tasks];
  const botHome=join(home,'bots'),state={mainBotIds:['chief'],bots:{
    chief:{id:'chief',name:'总管'},a:{id:'a',name:'资料整理员',instructions:'处理本人的任务。'},
    b:{id:'b',name:'编辑',instructions:'校对指定交接成果。'},
  }};
  tasks.team=new TeamRegistry({rt:{home:botHome,state,botOf:id=>state.bots[id]},db:ops.db,workspace});
  tasks.team.tasks=tasks;
  for(const id of ['a','b']){
    tasks.team.put('bot:'+id,{enabled:true,revision:1,taskTypes:[]});
    const memory=join(botHome,'memory','bots',id);mkdirSync(memory,{recursive:true});
    writeFileSync(join(memory,'MEMORY.md'),id==='a'?'REMEMBER_ALPHA: a 的私有记忆':'B_PRIVATE_MEMORY: b 的私有记忆');
  }
  const supervisor=manager=>new TeamSupervisor({tasks:manager,reports:manager.reports,createManagementTask:()=>{throw Error('unexpected management task');}});
  tasks.supervisor=supervisor(tasks);
  const reopen=()=>{
    const next=new TaskManager(options);managers.push(next);next.foregroundBusy=()=>true;
    next.team=new TeamRegistry({rt:tasks.team.rt,db:ops.db,workspace});next.team.tasks=next;next.supervisor=supervisor(next);return next;
  };
  t.after(async()=>{for(const manager of managers.toReversed())await manager.close();ops.close();rmSync(home,{recursive:true,force:true});});
  return {tasks,launches,reopen,setOldPid:pid=>{oldCommandPid=pid;}};
}
const create=(tasks,goal,extra={})=>tasks.create({id:'handoff',kind:'agent',title:'真实改派',goal,assignedBotId:'a',workspaceMode:'general',managementEnabled:false,timeoutMs:60000,...extra});
const reassign=(tasks,task)=>tasks.reassign({id:task.id,runId:task.runId,assignmentVersion:task.assignmentVersion,assignedBotId:'b',actionId:'reassign-once',summary:'RESUME_ONLY 检查交接说明，然后报告状态。'});

test('real Harness handoff kills the old nested command before launching a fresh employee session', {timeout:45000},async t=>{
  const {tasks,launches,setOldPid}=fixture(t);create(tasks,'FIXTURE_COMMAND',{permission:'full'});
  const old=await until(()=>{const detail=tasks.detail('handoff');return detail.workspace&&existsSync(join(detail.workspace.path,'started'))&&detail;});
  const commandPid=Number(readFileSync(join(old.workspace.path,'started'),'utf8'));setOldPid(commandPid);
  assert.equal(alive(commandPid),true);
  writeFileSync(join(old.workspace.path,'private-draft.txt'),'a 的未指定私有草稿');
  const oldHome=tasks.agentHome(old.task),oldSession=old.task.sessionId;
  assert.match(launches[0].spec.employee.memory.own,/REMEMBER_ALPHA/);
  reassign(tasks,old.task);
  const next=await until(()=>{const detail=tasks.detail('handoff');return detail.task.assignmentVersion===2&&detail.task.status==='completed'&&detail.task.cleanupConfirmed&&detail;});
  assert.equal(launches.length,2);assert.equal(launches[1].oldCommandAlive,false,'new employee must wait for old process death');
  assert.equal(alive(commandPid),false);
  assert.equal(next.runs[0].status,'paused');
  assert.equal(next.runs[0].jobs.find(step=>step.tool==='task_command').status,'interrupted');
  const oldRun=tasks.row('run',old.task.runId);assert.equal(tasks.row('job',oldRun.jobId).cleanupConfirmed,true);
  assert.equal(next.task.assignedBotId,'b');assert.notEqual(next.task.sessionId,oldSession);
  assert.notEqual(tasks.agentHome(next.task),oldHome);assert.notEqual(next.workspace.path,old.workspace.path);
  assert.equal(next.task.permission,'full');assert.equal(next.task.policyVersion,old.task.policyVersion);
  assert.equal(launches[1].spec.permission,'full');assert.equal(launches[1].spec.employee.botId,'b');
  assert.match(launches[1].spec.employee.memory.own,/B_PRIVATE_MEMORY/);
  assert.doesNotMatch(JSON.stringify(launches[1].spec),/REMEMBER_ALPHA/);
  assert.match(next.runs[1].result.text,/remembered=false/,'old Harness history must not enter the new session');
  assert.equal(existsSync(join(next.workspace.path,'private-draft.txt')),false);
  assert.equal(existsSync(join(next.workspace.path,'started')),false);
  assert.equal(readFileSync(join(old.workspace.path,'private-draft.txt'),'utf8'),'a 的未指定私有草稿');
  assert.equal(reassign(tasks,old.task).task.runId,next.task.runId,'retrying handoff cannot launch another run');
});

test('a read-only employee handoff retains the exact permission and isolated memory in the real runner', {timeout:45000},async t=>{
  const {tasks,launches}=fixture(t);create(tasks,'FIXTURE_READ',{permission:'read-only'});
  const old=await until(()=>{const detail=tasks.detail('handoff');return detail.task.status==='completed'&&detail.task.cleanupConfirmed&&detail;});
  assert.match(old.runs[0].result.text,/remembered=true/);
  reassign(tasks,old.task);
  const next=await until(()=>{const detail=tasks.detail('handoff');return detail.task.assignmentVersion===2&&detail.task.status==='completed'&&detail.task.cleanupConfirmed&&detail;});
  assert.equal(next.task.permission,'read-only');assert.equal(next.task.mode,'analysis');
  assert.equal(launches[1].spec.permission,'read-only');assert.equal(launches[1].spec.mode,'analysis');
  assert.match(next.runs[1].result.text,/remembered=false/);
});

test('restart after pausing a live handoff completes exactly one new assignment and never replays the old command', {timeout:45000},async t=>{
  const {tasks,reopen,launches,setOldPid}=fixture(t);create(tasks,'FIXTURE_COMMAND');
  const old=await until(()=>{const detail=tasks.detail('handoff');return detail.workspace&&existsSync(join(detail.workspace.path,'started'))&&detail;});
  const pid=Number(readFileSync(join(old.workspace.path,'started'),'utf8'));setOldPid(pid);
  reassign(tasks,old.task);await tasks.close();
  const stopped=tasks.row('task','handoff');assert.equal(stopped.handoff.status,'stopping');assert.ok(['paused','interrupted'].includes(stopped.status));
  // The nested command supervisor may finish its durable receipt after the
  // outer worker exits. Restart must reconcile that receipt before handoff.
  const firstRestart=reopen();firstRestart.tick();const transferred=await until(()=>{const current=firstRestart.row('task','handoff');return current.handoff.status==='completed'&&current;});
  assert.equal(alive(pid),false);
  assert.equal(transferred.handoff.status,'completed');assert.equal(transferred.assignmentVersion,2);assert.equal(transferred.status,'queued');
  firstRestart.tick();assert.equal(firstRestart.detail('handoff').runs.length,2);assert.equal(reassign(firstRestart,old.task).task.runId,transferred.runId);
  await firstRestart.close();const secondRestart=reopen();secondRestart.foregroundBusy=()=>false;secondRestart.tick();
  const finished=await until(()=>{const detail=secondRestart.detail('handoff');return detail.task.status==='completed'&&detail.task.cleanupConfirmed&&detail;});
  assert.equal(finished.task.runId,transferred.runId);assert.equal(finished.task.assignmentVersion,2);assert.equal(finished.runs.length,2);
  assert.equal(launches.length,2);assert.equal(launches[1].oldCommandAlive,false);assert.match(finished.runs[1].result.text,/remembered=false/);
  assert.equal(existsSync(join(finished.workspace.path,'started')),false);
});

test('a queued consumer keeps its accepted frozen input after source drift and a host restart', {timeout:45000},async t=>{
  const {tasks,reopen}=fixture(t);
  tasks.create({id:'source',kind:'agent',title:'上游资料',goal:'FIXTURE_DOCUMENT',assignedBotId:'a',managementEnabled:false});
  const source=await until(()=>{const detail=tasks.detail('source');return detail.task.status==='completed'&&detail.task.cleanupConfirmed&&detail;});
  const report=source.teamReview.current,original=readFileSync(report.artifacts[0].path,'utf8');
  tasks.review({id:'source',runId:source.task.runId,reportId:report.id,actionId:'accept-source',action:'accept',text:'已核对固定内容。'});
  tasks.foregroundBusy=()=>true;create(tasks,'RESUME_ONLY',{assignedBotId:'b',permission:'read-only',dependsOn:['source']});tasks.assignments.tick();
  const queued=tasks.row('task','handoff'),pinned=queued.transferInputs[0];assert.equal(queued.status,'queued');assert.equal(pinned.reportId,report.id);
  writeFileSync(report.artifacts[0].sourcePath,'上游后续变化，不应覆盖固定副本');tasks.assignments.tick();
  assert.deepEqual(tasks.row('task','handoff').inputsStale,['source']);await tasks.close();
  const next=reopen();next.tick();const restored=next.row('task','handoff');
  assert.equal(restored.runId,queued.runId);assert.deepEqual(restored.transferInputs,queued.transferInputs);assert.deepEqual(restored.inputsStale,['source']);
  next.foregroundBusy=()=>false;next.tick();
  const finished=await until(()=>{const detail=next.detail('handoff');return detail.task.status==='completed'&&detail.task.cleanupConfirmed&&detail;});
  assert.equal(readFileSync(join(finished.workspace.path,pinned.name),'utf8'),original);
  assert.equal(finished.task.dependencyInputs[0].reportId,report.id);assert.deepEqual(finished.task.inputsStale,['source']);
  assert.equal(finished.teamReview.current.artifacts.length,0,'unchanged frozen inputs are not new employee deliverables');
});
