/** Real Bot and Harness in an isolated external directory, with offline providers. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {ROOT,requireBuiltHarness} from '../../../runtime/sources.mjs';
import {botSettings} from '../../settings.mjs';
import {runtimePatch} from '../../configuration.mjs';

export const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
export async function lifecycleHost(t,{provider='task-provider.mjs'}={}){
  const sources=requireBuiltHarness(),home=mkdtempSync(join(tmpdir(),'nova-team-lifecycle-')),port=await freePort();let webPort=await freePort();while(webPort===port)webPort=await freePort();
  const b={...botSettings({OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(port),OPENNOVA_BOT_WEB_PORT:String(webPort)}),workspace:join(home,'workspace')};
  mkdirSync(b.workspace);writeFileSync(join(b.workspace,'sample.txt'),'original\n');writeFileSync(b.tokenPath,'offline-fixture-token');
  const patch=runtimePatch({bot:b,agent:{harnessRoot:sources.harnessRoot},webAssets:join(ROOT,'output/bot/web'),desktop:true}),insert=patch.find(row=>row.insert).insert;
  insert.find(plugin=>plugin.id==='opennova-chatgpt').name=join(ROOT,'services/bot/tests/fixtures/lifecycle-provider.mjs');
  insert.find(plugin=>plugin.id==='opennova-bot').config.agentProviderModule=join(ROOT,'services/bot/tests/fixtures',provider);
  const patchPath=join(home,'fixture.patch.json');writeFileSync(patchPath,JSON.stringify(patch));let child,logs='',sequence=0;
  async function api(path,body={},status=200){
    const response=await fetch(b.url+path,{method:'POST',headers:{Authorization:'Bearer offline-fixture-token','Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;
  }
  async function until(fn,ms=30000){
    const deadline=Date.now()+ms;
    while(Date.now()<deadline){const result=await fn();if(result)return result;await delay(30);}
    throw Error('lifecycle timeout\n'+logs);
  }
  async function stop(signal='SIGTERM'){
    if(!child||child.exitCode!==null||child.signalCode!==null)return;
    const exit=once(child,'exit');child.kill(signal);const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
    try{await exit;}finally{clearTimeout(timer);}
  }
  async function start(){
    child=spawn(process.execPath,[join(sources.harnessRoot,'apps/cli/lib/bin.js'),'--profile','web','--patch',patchPath,'--host','127.0.0.1','--port',String(webPort),'--no-open'],{cwd:b.workspace,stdio:['ignore','pipe','pipe'],env:{...process.env,DSH_HOME:join(home,'harness'),OPENNOVA_BOT_PLUGIN:sources.botRoot,OPENNOVA_HARNESS_ROOT:sources.harnessRoot,NODE_OPTIONS:'--import='+JSON.stringify(join(ROOT,'services/bot/resolve.mjs')),PATH:dirname(process.execPath)+':'+process.env.PATH}});
    const collect=data=>{logs=(logs+data).slice(-20000);};child.stdout.on('data',collect);child.stderr.on('data',collect);
    return until(async()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error('fixture host stopped\n'+logs);try{const health=await api('/health');return health.ready&&health;}catch{return false;}});
  }
  async function employee(name='资料员'){
    const team=await api('/team-member',{action:'create',actionId:'create-employee-'+(++sequence),name,role:'资料整理员',instructions:'核对输入与用户答复，保留来源。',taskTypes:[]});
    return team.members.find(member=>member.name===name);
  }
  async function foreground(id,name,args){
    await api('/ask',{id,source:'voice',text:'lifecycle:'+JSON.stringify({name,arguments:args})});
    const result=await until(async()=>{const result=await api('/result',{id});return ['completed','failed','cancelled'].includes(result.status)&&result;});
    assert.equal(result.status,'completed',JSON.stringify(result));return result;
  }
  t.after(async()=>{await stop();rmSync(home,{recursive:true,force:true});});
  return {home,workspace:b.workspace,api,until,start,stop,employee,foreground};
}
