import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {saveJson,readJson} from '../tasks/agent-files.mjs';

const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
async function until(fn){const deadline=Date.now()+15000;while(Date.now()<deadline){const value=fn();if(value)return value;await delay(25);}throw Error('runtime fixture timed out');}
function fixture(t,{maxSteps=0,tokenBudget=0,timeoutMs=0,goal='Read the supplied sample forty times.',provider='unlimited-provider.mjs'}={}){
  const home=mkdtempSync(join(tmpdir(),'nova-unlimited-')),source=join(home,'source'),agentHome=join(home,'agent'),runDir=join(home,'run');
  mkdirSync(source);mkdirSync(runDir);writeFileSync(join(source,'sample.txt'),'fixture input\n');
  const spec={policyVersion:2,permission:'full',mode:'edit',workspaceMode:'general',inputFiles:['sample.txt'],taskId:'task',runId:'run',sessionId:'session-unlimited',runNumber:1,source,agentHome,runDir,goal,maxSteps,tokenBudget,timeoutMs,
    providerModule:fileURLToPath(new URL('./fixtures/'+provider,import.meta.url))};
  const specPath=join(home,'spec.json');saveJson(specPath,spec);
  const child=spawn(process.execPath,[fileURLToPath(new URL('../tasks/worker.mjs',import.meta.url)),runDir],{cwd:source,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,NODE_OPTIONS:'',PATH:dirname(process.execPath)+':'+process.env.PATH}});
  const exit=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.send({type:'stop',reason:'cancelled'},()=>{});await exit;}rmSync(home,{recursive:true,force:true});});
  const command=[process.execPath,fileURLToPath(new URL('../tasks/agent-runner.mjs',import.meta.url)),specPath].map(quote).join(' ');
  child.send({type:'start',spec:{jobId:'job',runId:'run',command,cwd:source,timeoutMs,logLimit:8*1024*1024}},()=>{});
  return {home,agentHome,runDir,child,exit,log:()=>readFileSync(join(runDir,'output.log'),'utf8')};
}

test('zero budgets complete beyond former default limits through the real worker and Harness',{timeout:30000},async t=>{
  const f=fixture(t);await f.exit;
  const receipt=readJson(join(f.runDir,'result.json')),result=readJson(join(f.runDir,'agent-result.json')),progress=readJson(join(f.runDir,'progress.json'));
  assert.equal(receipt.status,'completed',f.log());assert.equal(receipt.cleanupConfirmed,true);assert.equal(result.status,'completed',f.log());
  assert.equal(progress.steps,41);assert.equal(progress.toolCalls,40);assert.ok(progress.totalTokens>200000);assert.equal(progress.estimatedTokens,false);
});

for(const [budget,value,error] of [['maxSteps',2,'task_step_budget_exhausted'],['tokenBudget',10000,'task_token_budget_exhausted']])test('explicit '+budget+' still stops an otherwise unlimited task',{timeout:30000},async t=>{
  const f=fixture(t,{[budget]:value});await f.exit;
  const result=readJson(join(f.runDir,'agent-result.json'));assert.equal(result.status,'failed',f.log());assert.equal(result.error,error);
  assert.equal(readJson(join(f.runDir,'result.json')).cleanupConfirmed,true);
});

test('unlimited work remains cancellable and cleans its nested command process',{timeout:30000},async t=>{
  const f=fixture(t,{goal:'FIXTURE_COMMAND',provider:'task-provider.mjs'});
  const started=join(f.agentHome,'workspace','started');await until(()=>existsSync(started));
  const pid=Number(readFileSync(started,'utf8'));assert.ok(pid>0);f.child.send({type:'stop',reason:'cancelled'},()=>{});await f.exit;
  const receipt=readJson(join(f.runDir,'result.json'));assert.equal(receipt.status,'cancelled',f.log());assert.equal(receipt.cleanupConfirmed,true);
  await until(()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
});

test('an explicit duration still expires while step and Token budgets are unlimited',{timeout:15000},async t=>{
  const f=fixture(t,{goal:'FIXTURE_SLOW',provider:'task-provider.mjs',timeoutMs:1500});await f.exit;
  const receipt=readJson(join(f.runDir,'result.json'));assert.equal(receipt.status,'failed',f.log());assert.equal(receipt.error,'task_timeout');assert.equal(receipt.cleanupConfirmed,true);
});
