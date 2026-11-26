import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
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
import {INPUT} from './fixtures/project-runtime-provider.mjs';

async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

test('real Harness keeps project and daily histories separate through natural routing, restart and directory changes',{timeout:120000},async t=>{
  const sources=requireBuiltHarness(),home=realpathSync(mkdtempSync(join(tmpdir(),'nova-project-runtime-')));
  const port=await freePort();let webPort=await freePort();while(webPort===port)webPort=await freePort();
  const b={...botSettings({OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(port),OPENNOVA_BOT_WEB_PORT:String(webPort)}),workspace:join(home,'workspace')};
  for(const dir of ['workspace','alpha','beta','alpha-moved'])mkdirSync(join(home,dir));
  await git(b.workspace,['init','-q']);await git(b.workspace,['config','user.name','Test']);await git(b.workspace,['config','user.email','test@localhost']);
  writeFileSync(join(b.workspace,'sample.txt'),'fixture');await git(b.workspace,['add','.']);await git(b.workspace,['commit','-qm','fixture']);
  writeFileSync(b.tokenPath,'offline-project-fixture');
  const routeTracePath=join(home,'routing.jsonl');
  const patch=runtimePatch({bot:b,agent:{harnessRoot:sources.harnessRoot},desktop:false});
  const provider=patch.find(row=>row.insert).insert.find(plugin=>plugin.id==='opennova-chatgpt');
  provider.name=join(ROOT,'services/bot/tests/fixtures/project-runtime-provider.mjs');provider.config.routeTracePath=routeTracePath;
  const patchPath=join(home,'test.patch.json');writeFileSync(patchPath,JSON.stringify(patch));
  let child,logs='';
  async function stop(){
    if(!child||child.exitCode!==null||child.signalCode!==null)return;
    const exit=once(child,'exit');child.kill('SIGTERM');const kill=setTimeout(()=>child.kill('SIGKILL'),5000);
    try{await exit;}finally{clearTimeout(kill);}
  }
  t.after(async()=>{await stop();rmSync(home,{recursive:true,force:true});});
  async function api(path,body={}){
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{Authorization:'Bearer offline-project-fixture','Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    assert.equal(response.status,200,await response.clone().text());return response.json();
  }
  async function waitFor(fn){
    const end=Date.now()+30000;
    while(Date.now()<end){try{const result=await fn();if(result)return result;}catch(error){if(child.exitCode!==null)throw Error(logs+'\n'+error.message);if(error.code==='ERR_ASSERTION')throw error;}
      await delay(50);
    }
    throw Error('project runtime timed out\n'+logs);
  }
  async function start(){
    child=spawn(process.execPath,[join(sources.harnessRoot,'apps/cli/lib/bin.js'),'--profile','web','--patch',patchPath,'--host','127.0.0.1','--port',String(webPort),'--no-open'],{
      cwd:b.workspace,stdio:['ignore','pipe','pipe'],env:{...process.env,DSH_HOME:join(home,'harness'),OPENNOVA_BOT_PLUGIN:sources.botRoot,OPENNOVA_HARNESS_ROOT:sources.harnessRoot,
        NODE_OPTIONS:'--import='+JSON.stringify(join(ROOT,'services/bot/resolve.mjs')),PATH:dirname(process.execPath)+':'+process.env.PATH}});
    child.stdout.on('data',data=>{logs=(logs+data).slice(-20000);});child.stderr.on('data',data=>{logs=(logs+data).slice(-20000);});
    return waitFor(async()=>{const health=await api('/health');return health.ready&&health;});
  }
  async function ask(id,text){
    const {state}=await api('/projects');
    await api('/ask',{id,text,source:'text',expectedProject:{projectId:state.projectId,revision:state.revision}});
    return waitFor(async()=>{const result=await api('/result',{id});assert.ok(!['failed','cancelled'].includes(result.status),JSON.stringify(result)+'\n'+logs);return result.status==='completed'&&result;});
  }
  const health=await start(),identity=health.botId;
  const a=(await api('/project-action',{action:'create',actionId:'create-alpha',name:'甲项目',directory:join(home,'alpha')})).result;
  const beta=(await api('/project-action',{action:'create',actionId:'create-beta',name:'乙项目',directory:join(home,'beta')})).result;
  const first=await ask('alpha-first',INPUT.a),alpha=JSON.parse(first.text);
  assert.deepEqual({a:alpha.a,b:alpha.b,daily:alpha.daily},{a:true,b:false,daily:false});assert.equal(first.projectId,a.id);
  const casual=await ask('daily-first',INPUT.daily),daily=JSON.parse(casual.text);
  assert.deepEqual({a:daily.a,b:daily.b,daily:daily.daily},{a:false,b:false,daily:true});assert.equal(casual.projectId,null);assert.equal(casual.binding.resumableProjectId,a.id);
  const second=await ask('beta-first',INPUT.b),other=JSON.parse(second.text);
  assert.deepEqual({a:other.a,b:other.b,daily:other.daily},{a:false,b:true,daily:false});assert.equal(second.projectId,beta.id);
  const dailyAgain=JSON.parse((await ask('daily-again',INPUT.dailyReturn)).text);
  assert.deepEqual(dailyAgain,daily);assert.equal((await api('/health')).botId,identity);
  const alphaAgain=JSON.parse((await ask('alpha-again',INPUT.aReturn)).text);assert.deepEqual(alphaAgain,alpha);
  const before=await api('/projects'),session=(await api('/health')).sessionId;
  const ambiguous=await ask('ambiguous',INPUT.ambiguous);
  assert.match(ambiguous.text,/哪一个同名项目/);assert.equal(ambiguous.binding.focus,'clarify');assert.equal(ambiguous.routing.failure,null);assert.deepEqual((await api('/projects')).state,before.state);
  assert.equal((await api('/health')).sessionId,session);assert.equal((await api('/stream-snapshot',{id:'ambiguous'})).stream,null);
  const failures=[];
  for(const [id,text,code,status,attempts] of [
    ['route-network-failure',INPUT.routeNetwork,'connection_error',503,2],
    ['route-auth-failure',INPUT.routeAuth,'invalid_grant',400,1],
    ['route-protocol-failure',INPUT.routeInvalid,'invalid_route_response',undefined,1],
  ]){
    await api('/ask',{id,text,source:'text',expectedProject:{projectId:before.state.projectId,revision:before.state.revision}});
    const result=await waitFor(async()=>{const value=await api('/result',{id});return !['queued','running'].includes(value.status)&&value;});
    assert.equal(result.status,'failed',JSON.stringify(result));assert.equal(result.error,code);assert.equal(result.diagnostic.code,code);
    assert.equal(result.diagnostic.stage,'routing');assert.equal(result.diagnostic.status,status);assert.deepEqual(result.routing.failure,result.diagnostic);
    assert.equal(result.routing.diagnostics.attempts,attempts);assert.equal(result.routing.diagnostics.recovered,false);
    for(const field of ['binding','text','speechText','sessionId'])assert.equal(result[field],undefined);
    assert.ok(!JSON.stringify(result).includes('private-router-error'));
    assert.deepEqual((await api('/projects')).state,before.state);assert.equal((await api('/health')).sessionId,session);
    assert.equal((await api('/stream-snapshot',{id})).stream,null);failures.push([id,result.diagnostic]);
  }
  await stop();assert.equal((await start()).botId,identity);
  for(const [id,diagnostic] of failures){const saved=await api('/result',{id});assert.equal(saved.status,'failed');assert.deepEqual(saved.diagnostic,diagnostic);assert.equal(saved.text,undefined);}
  assert.deepEqual(JSON.parse((await ask('after-restart',INPUT.restart)).text),alpha);
  const details=await api('/project-detail',{id:a.id}),project=details.project??details;
  await api('/project-action',{action:'update',actionId:'move-alpha',projectId:a.id,revision:project.revision,directory:join(home,'alpha-moved')});
  const moved=JSON.parse((await ask('moved-alpha',INPUT.moved)).text);
  assert.notEqual(moved.sessionId,alpha.sessionId);assert.deepEqual({a:moved.a,b:moved.b,daily:moved.daily},{a:false,b:false,daily:false});
  const found=JSON.parse((await ask('history-alpha',INPUT.history)).text);assert.equal(found.a,true);assert.equal(found.b,false);assert.equal(found.daily,false);
  const remembered=JSON.parse((await ask('memory-save',INPUT.memorySave)).text);
  assert.equal(remembered.retiredVisible,true);assert.equal(remembered.currentMemoryCount,1);assert.equal(remembered.referenceCount,1);
  for(const [id,input] of [['memory-forget',INPUT.memoryForget],['memory-next',INPUT.memoryAfter],['memory-history',INPUT.memoryHistory]]){
    const memory=JSON.parse((await ask(id,input)).text);
    assert.deepEqual(memory,{retiredVisible:false,referenceCount:1,currentMemoryCount:0});
  }
  assert.equal(JSON.parse((await ask('personal-save',INPUT.personalSave)).text).personalFactVisible,true);
  for(const [id,input] of [['personal-other-project',INPUT.personalRead],['personal-daily',INPUT.personalDaily]])
    assert.deepEqual(JSON.parse((await ask(id,input)).text),{personalFactVisible:true,privateQuoteVisible:false});
  assert.deepEqual(JSON.parse((await ask('quote-is-data',INPUT.quoted)).text),daily);
  const unchanged=(await api('/projects')).state;
  await api('/ask',{id:'cancel-routing',text:INPUT.cancel,source:'text'});
  await waitFor(()=>existsSync(routeTracePath)&&readFileSync(routeTracePath,'utf8').includes(INPUT.cancel));
  await api('/cancel',{id:'cancel-routing'});
  assert.equal((await api('/result',{id:'cancel-routing'})).status,'cancelled');assert.deepEqual((await api('/projects')).state,unchanged);
  assert.equal((await api('/snapshot')).busy,false);
});
