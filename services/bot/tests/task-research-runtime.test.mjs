import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer,request} from 'node:http';
import {connect} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {saveJson,readJson,readSteps} from '../tasks/agent-files.mjs';
import {TaskManager} from '../tasks/manager.mjs';

for(const scenario of ['success','failed','cancelled','http-error'])test('real Harness employee research: '+scenario, {timeout:45000},async t=>{
  const home=mkdtempSync(join(tmpdir(),'nova-task-web-runtime-')),source=join(home,'source'),agentHome=join(home,'agent'),runDir=join(home,'run');
  mkdirSync(source);writeFileSync(join(source,'sample.txt'),'Source input stays unchanged.');
  const requests=[],sockets=new Set();
  const target=createServer((req,res)=>{requests.push({url:req.url,method:req.method,auth:req.headers.authorization});res.writeHead(scenario==='http-error'?503:200,{'Content-Type':'text/html'});res.end(scenario==='http-error'?'Service unavailable':'<h1>Verified employee web fixture</h1><p>Task-owned evidence.</p>');});
  await new Promise(r=>target.listen(0,'127.0.0.1',r));
  const proxy=createServer((req,res)=>{
    if(req.url!=='http://task-fixture.invalid/source'||req.method!=='GET'){res.writeHead(403);res.end();return;}
    const upstream=request({host:'127.0.0.1',port:target.address().port,path:'/source',method:'GET',headers:req.headers},response=>{
      res.writeHead(response.statusCode,response.headers);response.pipe(res);
    });upstream.on('error',()=>res.destroy());req.pipe(upstream);
  });
  proxy.on('connect',(req,socket,head)=>{
    // Fixture-only proxy: there is no public network or DNS request.
    if(req.url!=='task-fixture.invalid:80'){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
    const upstream=connect(target.address().port,'127.0.0.1');sockets.add(upstream);
    upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
    upstream.once('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
    upstream.once('close',()=>sockets.delete(upstream));
  });
  for(const server of [target,proxy])server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  let child;
  t.after(async()=>{
    if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'exit');}
    for(const socket of sockets)socket.destroy();
    await Promise.all([target,proxy].map(server=>new Promise(r=>server.close(r))));rmSync(home,{recursive:true,force:true});
  });
  const spec={policyVersion:2,permission:'read-only',mode:'analysis',workspaceMode:'documents',inputFiles:['sample.txt'],
    taskId:'web-task',runId:'web-run',sessionId:'session-web-fixture',runNumber:1,source,agentHome,runDir,goal:'读取公开页面并回查来源。'+(scenario==='failed'?'FIXTURE_FAIL_AFTER_FETCH':scenario==='cancelled'?'FIXTURE_CANCEL_AFTER_FETCH':''),constraints:'只读，不写成果文件。',
    timeoutMs:30000,maxSteps:8,tokenBudget:200000,providerModule:fileURLToPath(new URL('./fixtures/task-web-provider.mjs',import.meta.url)),
    researchConfig:{enabled:true,httpAvailable:true,available:false}};
  const specPath=join(home,'spec.json');saveJson(specPath,spec);
  const proxyUrl='http://127.0.0.1:'+proxy.address().port;
  const env={...process.env,HTTP_PROXY:proxyUrl,HTTPS_PROXY:proxyUrl,http_proxy:proxyUrl,https_proxy:proxyUrl,NO_PROXY:'localhost,127.0.0.1',no_proxy:'localhost,127.0.0.1',ALL_PROXY:'',all_proxy:'',NODE_OPTIONS:'',PATH:dirname(process.execPath)+':'+process.env.PATH};
  child=spawn(process.execPath,[fileURLToPath(new URL('../tasks/agent-runner.mjs',import.meta.url)),specPath],{env,cwd:source,stdio:['ignore','pipe','pipe']});
  let logs='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{logs=(logs+chunk).slice(-12000);});
  const exit=once(child,'exit');
  if(scenario==='cancelled'){
    const deadline=Date.now()+10000;
    while(Date.now()<deadline&&!readJson(join(runDir,'research.json'))?.sources?.length){assert.equal(child.exitCode,null,logs);await delay(25);}
    assert.equal(readJson(join(runDir,'research.json'))?.sources?.length,1,logs);child.kill('SIGTERM');
  }
  const [code]=await exit;
  assert.equal(code,scenario==='failed'?1:scenario==='cancelled'?130:0,logs);
  const result=readJson(join(runDir,'agent-result.json'));
  if(scenario==='success'){
    assert.equal(result.status,'completed',logs);assert.match(result.text,/native-body=true; source-journal=true/,JSON.stringify(readSteps(runDir)));
  }else if(scenario==='failed')assert.equal(result.status,'failed',logs);
  assert.equal(requests.length,1);assert.deepEqual(requests[0],{url:'/source',method:'GET',auth:undefined});
  const evidence=readJson(join(runDir,'research.json'));assert.equal(evidence.runId,spec.runId);assert.equal(evidence.taskId,spec.taskId);
  assert.equal(evidence.sources.length,scenario==='http-error'?0:1);
  if(scenario==='http-error'){
    assert.equal(readSteps(runDir).find(step=>step.tool==='web_fetch').status,'failed');
    assert.equal(evidence.research.outcome,'partial');return;
  }
  assert.equal(evidence.sources[0].url,'http://task-fixture.invalid/source');assert.equal(evidence.sources[0].requestId,spec.runId);
  assert.equal(evidence.research.usage.fetchCalls,1);assert.equal(evidence.research.observationFailed,false);
  if(scenario!=='cancelled'){assert.equal(result.sources.length,1);assert.equal(result.sources[0].requestId,spec.runId);}
  if(['failed','cancelled'].includes(scenario)){
    // Exercise the real terminal projection even if a killed worker never
    // managed to write agent-result.json. No running scheduler is necessary.
    const records=new Map(),task={id:spec.taskId,kind:'agent',runId:spec.runId,status:'running'},run={id:spec.runId,taskId:spec.taskId,jobId:'job'},job={id:'job',runId:spec.runId,taskId:spec.taskId,kind:'agent'};
    const receiver={row:()=>task,directory:()=>runDir,all:()=>[],atomic:fn=>fn(),put:(kind,record)=>records.set(kind,record),artifacts:()=>[],changed(){},automation:{recordCompletion(){}},reports:{capture(){}}};
    TaskManager.prototype.finish.call(receiver,task,run,job,{status:scenario,cleanupConfirmed:true});
    assert.equal(records.get('job').agentResult.sources.length,1);assert.equal(records.get('job').agentResult.sources[0].requestId,spec.runId);
    saveJson(join(runDir,'research.json'),{...evidence,runId:'foreign-run'});
    // An otherwise missing agent result may not adopt another Run's journal.
    rmSync(join(runDir,'agent-result.json'),{force:true});
    TaskManager.prototype.finish.call(receiver,task,run,job,{status:scenario,cleanupConfirmed:true});
    assert.equal(records.get('job').agentResult?.sources,undefined);
  }
});
