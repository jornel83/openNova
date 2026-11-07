import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {once} from 'node:events';
import {git} from '../tasks/workspace.mjs';
import {ROOT,requireBuiltHarness} from '../../runtime/sources.mjs';
import {botSettings} from '../settings.mjs';
import {runtimePatch} from '../configuration.mjs';

async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}

test('team roster, assigned document work, task snapshots and restart use real Bot and Harness',{timeout:90000},async t=>{
  const sources=requireBuiltHarness(),home=mkdtempSync(join(tmpdir(),'nova-runtime-'));
  const port=await freePort();let webPort=await freePort();while(webPort===port)webPort=await freePort();
  const b={...botSettings({OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(port),OPENNOVA_BOT_WEB_PORT:String(webPort)}),workspace:join(home,'workspace')};
  mkdirSync(b.workspace);await git(b.workspace,['init','-q']);await git(b.workspace,['config','user.name','Test']);await git(b.workspace,['config','user.email','test@localhost']);writeFileSync(join(b.workspace,'sample.txt'),'original\n');await git(b.workspace,['add','.']);await git(b.workspace,['commit','-qm','fixture']);writeFileSync(b.tokenPath,'offline-fixture-token');
  const patch=runtimePatch({bot:b,agent:{harnessRoot:sources.harnessRoot},webAssets:join(ROOT,'output/bot/web'),desktop:true});
  patch.find(row=>row.insert).insert.find(p=>p.id==='opennova-chatgpt').name=join(ROOT,'services/bot/tests/fixtures/mock-provider.mjs');
  patch.find(row=>row.insert).insert.find(p=>p.id==='opennova-bot').config.agentProviderModule=join(ROOT,'services/bot/tests/fixtures/task-provider.mjs');
  const patchPath=join(home,'test.patch.json');writeFileSync(patchPath,JSON.stringify(patch));
  let child,logs='';
  async function stop(){
    if(!child||child.exitCode!==null||child.signalCode!==null)return;
    const exit=once(child,'exit');child.kill('SIGTERM');
    const kill=setTimeout(()=>child.kill('SIGKILL'),5000);
    try{await exit;}finally{clearTimeout(kill);}
  }
  t.after(async()=>{await stop();rmSync(home,{recursive:true,force:true});});
  async function api(path,body={}){
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{Authorization:'Bearer offline-fixture-token','Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    assert.equal(response.status,200,await response.clone().text());return response.json();
  }
  async function waitFor(fn){
    const end=Date.now()+30000;
    while(Date.now()<end){try{const result=await fn();if(result)return result;}catch(error){if(child.exitCode!==null)throw Error(logs+'\n'+error.message);}
      await delay(50);
    }
    throw Error('offline runtime timed out\n'+logs);
  }
  async function start(){
    child=spawn(process.execPath,[join(sources.harnessRoot,'apps/cli/lib/bin.js'),'--profile','web','--patch',patchPath,'--host','127.0.0.1','--port',String(webPort),'--no-open'],{
      cwd:b.workspace,stdio:['ignore','pipe','pipe'],env:{...process.env,DSH_HOME:join(home,'harness'),
        OPENNOVA_BOT_PLUGIN:sources.botRoot,OPENNOVA_HARNESS_ROOT:sources.harnessRoot,
        NODE_OPTIONS:'--import='+JSON.stringify(join(ROOT,'services/bot/resolve.mjs')),PATH:dirname(process.execPath)+':'+process.env.PATH}});
    child.stdout.on('data',d=>{logs=(logs+d).slice(-16000);});child.stderr.on('data',d=>{logs=(logs+d).slice(-16000);});
    return waitFor(async()=>{const health=await api('/health');return health.ready&&health;});
  }
  const health=await start();const before=await api('/snapshot');
  const input={action:'create',actionId:'new-member',name:'资料员',role:'资料整理员',instructions:'保留资料来源，按主题整理。',taskTypes:['documents']};
  const team=await api('/team-member',input);const member=team.members.find(m=>!m.chief);assert.ok(member);assert.equal(team.chiefBotId,health.botId);
  assert.equal((await api('/team-member',input)).members.length,2);
  assert.equal((await api('/snapshot')).messages.length,before.messages.length);
  await api('/ask',{id:'assigned-work',text:'agent:'+JSON.stringify({title:'整理资料',goal:'FIXTURE_DOCUMENT',workspaceMode:'documents',inputFiles:['sample.txt'],assignedBotId:member.id}),source:'voice'});
  await waitFor(async()=>(await api('/result',{id:'assigned-work'})).status==='completed');
  const task=await waitFor(async()=>{const {tasks}=await api('/background-tasks');return tasks.find(t=>t.requestId==='assigned-work');});
  const done=await waitFor(async()=>{const d=await api('/background-task',{id:task.id});if(d.task.status==='failed')throw Error(JSON.stringify(d));return d.task.status==='completed'&&d;});
  assert.equal(done.task.assignedBotId,member.id);assert.equal(done.task.ownerName,member.name);assert.equal(done.runs[0].employee.role,'资料整理员');
  assert.equal(done.task.mode,'edit');assert.equal(done.task.permission,'full');assert.equal(done.task.policyVersion,2);
  assert.match(done.runs[0].result.text,/employee=true/);assert.equal(done.workspace.kind,'documents');assert.ok(done.runs[0].job.artifacts.length,JSON.stringify(done));assert.equal(done.runs[0].job.artifacts[0].name,'report.md');
  assert.equal(readFileSync(join(b.workspace,'sample.txt'),'utf8'),'original\n');
  // A research specialty is routing context, not a permission boundary. The
  // same employee can execute a general task that uses files and a command.
  await api('/ask',{id:'general-work',text:'agent:'+JSON.stringify({title:'跨场景处理',goal:'FIXTURE_GENERIC_PIPELINE',inputFiles:['sample.txt'],assignedBotId:member.id}),source:'voice'});
  await waitFor(async()=>(await api('/result',{id:'general-work'})).status==='completed');
  const generic=await waitFor(async()=>{const {tasks}=await api('/background-tasks');return tasks.find(t=>t.requestId==='general-work');});
  const processed=await waitFor(async()=>{const d=await api('/background-task',{id:generic.id});if(d.task.status==='failed')throw Error(JSON.stringify(d));return d.task.status==='completed'&&d;});
  assert.equal(processed.task.assignedBotId,member.id);assert.equal(processed.task.workspaceMode,'general');
  assert.equal(processed.runs[0].jobs.find(j=>j.tool==='task_command')?.exitCode,0);
  assert.equal(readFileSync(join(processed.workspace.path,'processed.md'),'utf8'),'ORIGINAL\n');
  assert.equal(readFileSync(join(b.workspace,'sample.txt'),'utf8'),'original\n');
  await api('/team-member',{...input,action:'update',actionId:'rename',id:member.id,revision:member.revision,name:'资料专家',role:'新职责'});
  const changed=await api('/background-task',{id:task.id});assert.equal(changed.task.ownerName,'资料专家');assert.equal(changed.runs[0].employee.role,'资料整理员');
  await stop();await start();assert.equal((await api('/team')).members.length,2);assert.equal((await api('/background-task',{id:task.id})).task.status,'completed');
  await api('/background-task-continue',{id:task.id,runId:task.runId,actionId:'resume-document',text:'RESUME_ONLY'});
  const resumed=await waitFor(async()=>{const d=await api('/background-task',{id:task.id});return d.task.status==='completed'&&d;});assert.equal(resumed.runs.length,2);assert.equal(resumed.runs[1].employee.role,'新职责');
});
