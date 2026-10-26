import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {once} from 'node:events';
import {ROOT,requireBuiltHarness} from '../../runtime/sources.mjs';
import {botSettings} from '../settings.mjs';
import {runtimePatch} from '../configuration.mjs';

async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}

test('included Harness hosts the tracked Bot plugin, shared requests, cancellation and restart history without an account',{timeout:90000},async t=>{
  const sources=requireBuiltHarness(),home=mkdtempSync(join(tmpdir(),'nova-runtime-'));
  const port=await freePort();let webPort=await freePort();while(webPort===port)webPort=await freePort();
  const b={...botSettings({OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(port),OPENNOVA_BOT_WEB_PORT:String(webPort)}),workspace:join(home,'workspace')};
  mkdirSync(b.workspace);writeFileSync(b.tokenPath,'offline-fixture-token');
  const patch=runtimePatch({bot:b,agent:{harnessRoot:sources.harnessRoot},webAssets:join(ROOT,'output/bot/web')});
  patch.find(row=>row.insert).insert.find(p=>p.id==='opennova-chatgpt').name=join(ROOT,'services/bot/tests/fixtures/mock-provider.mjs');
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
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status,200);
  await api('/ask',{id:'first',text:'hello',source:'text'});
  const result=await waitFor(async()=>{const r=await api('/result',{id:'first'});if(r.status==='failed')throw Error(JSON.stringify(r));return r.status==='completed'&&r;});
  assert.equal(result.text,'offline:hello');
  await api('/ask',{id:'cancel-me',text:'slow',source:'voice'});
  await waitFor(async()=>(await api('/result',{id:'cancel-me'})).status==='running');
  assert.equal((await api('/cancel',{id:'cancel-me'})).status,'cancelled');
  await stop();const next=await start();assert.equal(next.botId,health.botId);
  assert.equal((await api('/result',{id:'first'})).text,'offline:hello');
  assert.ok((await api('/snapshot')).messages.some(m=>m.id==='first'));
});
