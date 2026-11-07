import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {once} from 'node:events';
import {WebSocket} from '../desktop/node_modules/ws/wrapper.mjs';
import {ROOT,requireBuiltHarness} from '../../runtime/sources.mjs';
import {botSettings} from '../settings.mjs';
import {runtimePatch} from '../configuration.mjs';

async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
test('real task Harness uses scoped HTTP and authenticated extension receipts to deliver a browser report',{timeout:60000},async t=>{
  const sources=requireBuiltHarness(),home=mkdtempSync(join(tmpdir(),'nova-browser-runtime-'));
  const port=await freePort();let webPort=await freePort();while(webPort===port)webPort=await freePort();
  const b={...botSettings({OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(port),OPENNOVA_BOT_WEB_PORT:String(webPort)}),workspace:join(home,'project')};
  mkdirSync(b.workspace);writeFileSync(b.tokenPath,'browser-fixture-root-token');
  const patch=runtimePatch({bot:b,agent:{harnessRoot:sources.harnessRoot},desktop:true});
  const plugins=patch.find(row=>row.insert).insert;
  plugins.find(plugin=>plugin.id==='opennova-chatgpt').name=join(ROOT,'services/bot/tests/fixtures/mock-provider.mjs');
  plugins.find(plugin=>plugin.id==='opennova-bot').config.agentProviderModule=join(ROOT,'services/bot/tests/fixtures/task-browser-provider.mjs');
  const patchPath=join(home,'fixture.patch.json');writeFileSync(patchPath,JSON.stringify(patch));
  let logs='',socket;
  const child=spawn(process.execPath,[join(sources.harnessRoot,'apps/cli/lib/bin.js'),'--profile','web','--patch',patchPath,'--host','127.0.0.1','--port',String(webPort),'--no-open'],{
    cwd:b.workspace,stdio:['ignore','pipe','pipe'],env:{...process.env,DSH_HOME:join(home,'harness'),OPENNOVA_BOT_PLUGIN:sources.botRoot,OPENNOVA_HARNESS_ROOT:sources.harnessRoot,
      NODE_OPTIONS:'--import='+JSON.stringify(join(ROOT,'services/bot/resolve.mjs')),PATH:dirname(process.execPath)+':'+process.env.PATH}});
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{logs=(logs+chunk).slice(-16000);});
  t.after(async()=>{socket?.terminate();if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{await exited;}finally{clearTimeout(timer);}}rmSync(home,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${port}`;
  async function api(path,body={}){const response=await fetch(url+path,{method:'POST',headers:{Authorization:'Bearer browser-fixture-root-token','Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(3000)});assert.equal(response.status,200,await response.clone().text());return response.json();}
  async function waitFor(fn){const end=Date.now()+25000;while(Date.now()<end){let value;try{value=await fn();}catch(error){if(child.exitCode!==null)throw Error('host exited: '+error.message+'\n'+logs);if(error.message?.startsWith('task failed:'))throw error;}if(value)return value;await delay(50);}throw Error('fixture timeout\n'+logs);}
  await waitFor(async()=>(await api('/health')).ready);
  const pairing=await api('/desktop/pair'),origin='chrome-extension://'+'b'.repeat(32);
  const paired=await fetch(url+'/browser/pair',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({code:pairing.code})});assert.equal(paired.status,200);
  const {token}=await paired.json();socket=new WebSocket(url.replace('http','ws')+'/browser/bridge',{origin});await once(socket,'open');
  const ready=once(socket,'message');socket.send(JSON.stringify({type:'auth',token}));assert.equal(JSON.parse((await ready)[0]).type,'ready');
  const page={bindingId:'task-binding',tabId:7,documentId:'task-document',revision:0,url:'https://browser-fixture.invalid/report',title:'Browser fixture',readable:true};
  const sourceText='Verified fixture source: 7 samples, all processed.',commands=[];
  socket.on('message',raw=>{
    const packet=JSON.parse(raw);if(packet.type==='ping'){socket.send(JSON.stringify({type:'pong'}));return;}if(packet.type!=='command')return;
    const command=packet.command;commands.push(command);
    socket.send(JSON.stringify({type:'context',context:{page,selection:null},activate:command.method==='open'}));
    const result={id:command.id,status:'completed',page,...(command.method==='read'?{snapshot:{page,text:sourceText,targets:[],truncated:false}}:{navigation:'dispatched'})};
    socket.send(JSON.stringify({type:'result',result}));
  });
  const team=await api('/team-member',{action:'create',actionId:'browser-member',name:'研究员',role:'研究与交付',instructions:'读取实际网页，保留来源。',taskTypes:['documents']});
  const employee=team.members.find(member=>!member.chief);
  await api('/background-task-start',{id:'browser-task',kind:'agent',assignedBotId:employee.id,title:'浏览器报告',goal:'BROWSER_REPORT',permission:'full',timeoutMs:30000});
  const done=await waitFor(async()=>{const detail=await api('/background-task',{id:'browser-task'});if(detail.task.status==='failed')throw Error('task failed: '+JSON.stringify(detail));return detail.task.status==='completed'&&detail;});
  assert.equal(done.task.workspaceMode,'general');assert.equal(done.task.assignedBotId,employee.id);
  assert.deepEqual(commands.map(command=>command.method),['open','read']);assert.deepEqual(commands[1].page,page);
  assert.deepEqual(done.runs[0].jobs.map(job=>[job.tool,job.status]),[['browser_open','completed'],['browser_read','completed'],['write','completed']]);
  const report=readFileSync(join(done.workspace.path,'report.md'),'utf8');assert.ok(report.includes(sourceText));assert.ok(report.includes(page.url));
  assert.equal(done.runs[0].job.artifacts.find(file=>file.name==='report.md')?.status,'available');assert.equal(existsSync(join(b.workspace,'report.md')),false);
  const spec=JSON.parse(readFileSync(join(home,'tasks',done.runs[0].job.id,'agent-spec.json'),'utf8'));assert.equal(spec.bridge.scoped,true);assert.notEqual(spec.bridge.tokenPath,b.tokenPath);
  const runtimeToken=readFileSync(spec.bridge.tokenPath,'utf8').trim();assert.equal((await fetch(url+'/shutdown',{method:'POST',headers:{Authorization:'Bearer '+runtimeToken},body:'{}'})).status,403);
  await api('/background-task-start',{id:'readonly-browser',kind:'agent',assignedBotId:employee.id,title:'只读能力检查',goal:'READONLY_BROWSER_CATALOG',permission:'read-only',timeoutMs:30000});
  const readonly=await waitFor(async()=>{const detail=await api('/background-task',{id:'readonly-browser'});if(detail.task.status==='failed')throw Error('task failed: '+JSON.stringify(detail));return detail.task.status==='completed'&&detail;});
  assert.match(readonly.runs[0].result.text,/readonly catalog verified/);assert.equal(readonly.runs[0].jobs.length,0);assert.equal(commands.length,2);
  // A model that nevertheless emits an unavailable browser call is rejected
  // before the host/extension can perform any action.
  await api('/background-task-start',{id:'readonly-denied',kind:'agent',assignedBotId:employee.id,title:'拒绝越权浏览器调用',goal:'FORCE_FORBIDDEN_BROWSER',permission:'read-only',timeoutMs:30000});
  const denied=await waitFor(async()=>{const detail=await api('/background-task',{id:'readonly-denied'});if(detail.task.status==='completed')throw Error('task failed: readonly tool call unexpectedly accepted');return detail.task.status==='failed'&&detail;});
  assert.equal(denied.runs[0].jobs.length,0);assert.equal(commands.length,2);assert.equal(existsSync(join(denied.workspace.path,'report.md')),false);
});
