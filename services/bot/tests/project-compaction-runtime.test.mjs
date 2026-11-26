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
import {INPUT} from './fixtures/project-compaction-provider.mjs';

async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

test('native long-context part rollover preserves A scope through other projects and host restart',{timeout:120000},async t=>{
  const action='switch';
  const sources=requireBuiltHarness(),home=realpathSync(mkdtempSync(join(tmpdir(),'nova-project-compaction-')));
  const port=await freePort();let webPort=await freePort();while(webPort===port)webPort=await freePort();
  const b={...botSettings({OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(port),OPENNOVA_BOT_WEB_PORT:String(webPort)}),workspace:join(home,'workspace')};
  for(const dir of ['workspace','alpha','beta'])mkdirSync(join(home,dir));
  await git(b.workspace,['init','-q']);await git(b.workspace,['config','user.name','Test']);await git(b.workspace,['config','user.email','test@localhost']);
  writeFileSync(join(b.workspace,'sample.txt'),'fixture');await git(b.workspace,['add','.']);await git(b.workspace,['commit','-qm','fixture']);
  writeFileSync(b.tokenPath,'offline-compaction-fixture');
  const tracePath=join(home,'model-trace.jsonl'),patch=runtimePatch({bot:b,agent:{harnessRoot:sources.harnessRoot},desktop:false});
  const provider=patch.find(row=>row.insert).insert.find(plugin=>plugin.id==='opennova-chatgpt');
  provider.name=join(ROOT,'services/bot/tests/fixtures/project-compaction-provider.mjs');Object.assign(provider.config,{tracePath});
  const patchPath=join(home,'test.patch.json');writeFileSync(patchPath,JSON.stringify(patch));
  let child,logs='';
  const traces=()=>existsSync(tracePath)?readFileSync(tracePath,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  const teamState=()=>JSON.parse(readFileSync(join(home,'bot/state.json'),'utf8'));
  async function stop(){
    if(!child||child.exitCode!==null||child.signalCode!==null)return;
    const exit=once(child,'exit');child.kill('SIGTERM');const kill=setTimeout(()=>child.kill('SIGKILL'),5000);
    try{await exit;}finally{clearTimeout(kill);}
  }
  t.after(async()=>{await stop();rmSync(home,{recursive:true,force:true});});
  async function api(path,body={}){
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{Authorization:'Bearer offline-compaction-fixture','Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    assert.equal(response.status,200,await response.clone().text());return response.json();
  }
  async function waitFor(fn){
    const end=Date.now()+30000;
    while(Date.now()<end){try{const result=await fn();if(result)return result;}catch(error){if(child.exitCode!==null)throw Error(logs+'\n'+error.message);if(error.code==='ERR_ASSERTION')throw error;}
      await delay(50);
    }
    throw Error('native compaction timed out\n'+JSON.stringify(traces())+'\n'+logs);
  }
  async function start(){
    child=spawn(process.execPath,[join(sources.harnessRoot,'apps/cli/lib/bin.js'),'--profile','web','--patch',patchPath,'--host','127.0.0.1','--port',String(webPort),'--no-open'],{
      cwd:b.workspace,stdio:['ignore','pipe','pipe'],env:{...process.env,DSH_HOME:join(home,'harness'),OPENNOVA_BOT_PLUGIN:sources.botRoot,OPENNOVA_HARNESS_ROOT:sources.harnessRoot,
        NODE_OPTIONS:'--import='+JSON.stringify(join(ROOT,'services/bot/resolve.mjs')),PATH:dirname(process.execPath)+':'+process.env.PATH}});
    const capture=data=>{logs=(logs+data).replace(/token=[^\s]+/g,'token=[redacted]').slice(-18000);};
    child.stdout.on('data',capture);child.stderr.on('data',capture);
    return waitFor(async()=>{const health=await api('/health');return health.ready&&health;});
  }
  async function ask(id,text){
    const {state}=await api('/projects');await api('/ask',{id,text,source:'text',expectedProject:{projectId:state.projectId,revision:state.revision}});
    return waitFor(async()=>{const result=await api('/result',{id});assert.ok(!['failed','cancelled'].includes(result.status),JSON.stringify({...result,text:result.text?.slice(0,200)})+'\n'+logs);return result.status==='completed'&&result;});
  }
  const initial=await start(),identity=initial.botId;
  const a=(await api('/project-action',{action:'create',actionId:'create-alpha',name:'甲项目',directory:join(home,'alpha')})).result;
  const beta=(await api('/project-action',{action:'create',actionId:'create-beta',name:'乙项目',directory:join(home,'beta')})).result;
  const first=await ask('a-inspect-first',INPUT.inspectA),originalSession=first.sessionId;
  assert.deepEqual(JSON.parse(first.text),{sessionId:originalSession,a:false,b:false,daily:false,checkpoint:false,handoff:false});
  for(let index=0;index<4&&!traces().some(row=>row.kind==='note');index++)await ask('a-grow-'+index,INPUT.long);
  await waitFor(()=>traces().some(row=>row.kind==='note'));
  const after=await ask('a-after-maintenance',INPUT.inspectA),seen=JSON.parse(after.text);
  assert.equal(seen.a,true);assert.equal(seen.b,false);assert.equal(seen.daily,false);
  const scope=teamState().opennovaProjectSessions[identity].scopes['project:'+a.id];
  assert.equal(scope.sessionId,after.sessionId);assert.equal(scope.cwd,join(home,'alpha'));
  assert.notEqual(after.sessionId,originalSession);assert.ok(scope.segments.some(segment=>segment.sessionId===originalSession));
  assert.equal(seen.handoff,true);assert.ok(scope.segments.some(segment=>segment.note?.includes('A_COMPACTION_ONLY')));
  assert.ok(scope.segments.find(segment=>segment.sessionId===originalSession).tokens>=Math.floor((32000-4096)*0.8),'native measured tokens exceeded the actual check line');
  const saved=structuredClone(scope);
  for(const [id,input,target] of [['b-after-a',INPUT.beta,beta.id],['daily-after-a',INPUT.daily,null]]){
    const reply=await ask(id,input),value=JSON.parse(reply.text);
    assert.equal(reply.projectId,target);assert.equal(value.a,false);assert.equal(value.b,target===beta.id);assert.equal(value.daily,target===null);
    assert.equal(value.handoff,false);assert.equal(value.checkpoint,false);
  }
  assert.deepEqual(teamState().opennovaProjectSessions[identity].scopes['project:'+a.id],saved);
  const returned=JSON.parse((await ask('a-return',INPUT.inspectA)).text);
  assert.equal(returned.sessionId,saved.sessionId);assert.equal(returned.a,true);assert.equal(returned.b,false);assert.equal(returned.daily,false);
  await stop();assert.equal((await start()).botId,identity);
  const restarted=JSON.parse((await ask('a-after-restart',INPUT.inspectA)).text);
  assert.deepEqual(restarted,returned);
  const restored=teamState().opennovaProjectSessions[identity].scopes['project:'+a.id];
  assert.equal(restored.sessionId,saved.sessionId);assert.deepEqual(restored.segments,saved.segments);
  const maintenance=traces().filter(row=>['steward','note','checkpoint'].includes(row.kind));
  assert.ok(maintenance.every(row=>row.a&&!row.b&&!row.daily));
  t.diagnostic(JSON.stringify({action,native:true,maintenance:maintenance.map(row=>row.kind),measuredTokens:saved.segments[0].tokens,checkLine:Math.floor((32000-4096)*0.8),newSession:originalSession!==saved.sessionId,oldParts:saved.segments.length,projectIsolation:true,restartPreserved:true}));
});
