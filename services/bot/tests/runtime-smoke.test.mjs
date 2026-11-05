import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
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

test('included Harness hosts the tracked Bot plugin, shared requests, cancellation and restart history without an account',{timeout:90000},async t=>{
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
  const health=await start();assert.equal(health.workspace,b.workspace);
  assert.equal(health.desktopEnabled,true);
  assert.equal((await api('/desktop/status')).paired,false);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status,200);
  await api('/ask',{id:'first',text:'hello',source:'text'});
  const result=await waitFor(async()=>{const r=await api('/result',{id:'first'});if(r.status==='failed')throw Error(JSON.stringify(r));return r.status==='completed'&&r;});
  assert.equal(result.text,'offline:hello');
  // A real Harness tool call must hand off a command and finish its turn while
  // the command is still running, so the next user message is admitted.
  await api('/ask',{id:'background-tool',text:'background:'+JSON.stringify({title:'后台验证',command:"printf 'task started\\n'; sleep 5; printf 'done\\n'"}),source:'voice'});
  await waitFor(async()=>(await api('/result',{id:'background-tool'})).status==='completed');
  const task=await waitFor(async()=>{const {tasks}=await api('/background-tasks');return tasks.find(t=>t.requestId==='background-tool'&&t.status==='running');});
  assert.equal((await api('/snapshot')).busy,false);
  await api('/ask',{id:'chat-during-task',text:'hello',source:'web'});
  await waitFor(async()=>(await api('/result',{id:'chat-during-task'})).status==='completed');
  assert.equal((await api('/background-task',{id:task.id})).task.status,'running');
  await api('/background-task-cancel',{id:task.id,runId:task.runId});
  await waitFor(async()=>(await api('/background-task',{id:task.id})).task.status==='cancelled');
  await api('/ask',{id:'agent-tool',text:'agent:'+JSON.stringify({title:'独立开发会话',goal:'FIXTURE_COMMAND REMEMBER_ALPHA',mode:'edit',timeoutMs:60000}),source:'web'});
  await waitFor(async()=>(await api('/result',{id:'agent-tool'})).status==='completed');
  const agentTask=await waitFor(async()=>{const {tasks}=await api('/background-tasks');return tasks.find(t=>t.requestId==='agent-tool'&&t.status==='running');});
  await waitFor(async()=>{const d=await api('/background-task',{id:agentTask.id});return d.runs[0].jobs?.some(j=>j.tool==='task_command');});
  assert.equal((await api('/snapshot')).busy,false);
  await api('/ask',{id:'chat-during-agent',text:'hello',source:'voice'});
  assert.equal((await waitFor(async()=>{const r=await api('/result',{id:'chat-during-agent'});return r.status==='completed'&&r;})).text,'offline:hello');
  await api('/background-task-pause',{id:agentTask.id,runId:agentTask.runId});
  await waitFor(async()=>(await api('/background-task',{id:agentTask.id})).task.status==='paused');
  assert.equal(health.outputMode,'hybrid-stream');
  await api('/ask',{id:'streamed',text:'stream',source:'voice'});
  const early=await waitFor(async()=>{const s=await api('/stream-snapshot',{id:'streamed'});return s.stream?.speechText&&s;});
  assert.equal(early.stream.speechText,'第一句已经生成。');assert.equal(early.result.status,'running');assert.ok(early.cursor.hostEpoch);
  const streamed=await waitFor(async()=>{const r=await api('/result',{id:'streamed'});return r.status==='completed'&&r;});
  assert.equal(streamed.text,'第一句已经生成。第二句稍后完成。');
  assert.ok(streamed.replyTimings.firstSpeechDraftAt<streamed.replyTimings.botCompletedAt);
  await api('/ask',{id:'cancel-streamed',text:'cancel-stream',source:'voice'});
  await waitFor(async()=>(await api('/stream-snapshot',{id:'cancel-streamed'})).stream?.speechText);
  assert.equal((await api('/cancel',{id:'cancel-streamed'})).status,'cancelled');
  const interrupted=await api('/result',{id:'cancel-streamed'});
  assert.equal(interrupted.partialText,'第一句已经生成。');assert.equal(interrupted.text,undefined);
  await api('/ask',{id:'failed-stream',text:'stream-fail',source:'voice'});
  const failed=await waitFor(async()=>{const r=await api('/result',{id:'failed-stream'});return r.status==='failed'&&r;});
  assert.equal(failed.partialText,'第一句已经生成。');assert.equal(failed.text,undefined);assert.equal(failed.replyStream.status,'abandoned');
  await api('/ask',{id:'cancel-me',text:'slow',source:'voice'});
  await waitFor(async()=>(await api('/result',{id:'cancel-me'})).status==='running');
  assert.equal((await api('/cancel',{id:'cancel-me'})).status,'cancelled');
  await stop();const next=await start();assert.equal(next.botId,health.botId);
  assert.equal((await api('/result',{id:'first'})).text,'offline:hello');
  assert.equal((await api('/result',{id:'failed-stream'})).partialText,'第一句已经生成。');
  assert.ok((await api('/snapshot')).messages.some(m=>m.id==='first'));
  assert.equal((await api('/background-task',{id:task.id})).task.status,'cancelled');
  assert.equal((await api('/background-task',{id:agentTask.id})).task.status,'paused');
  await api('/background-task-continue',{id:agentTask.id,runId:agentTask.runId,actionId:'continue-after-restart',text:'RESUME_ONLY'});
  const resumed=await waitFor(async()=>{const d=await api('/background-task',{id:agentTask.id});return d.task.status==='completed'&&d;});
  assert.match(resumed.runs[1].result.text,/remembered=true/);
});
