#!/usr/bin/env node
/** Wall-clock endurance lane: real Bot/Harness and local processes, offline models only. */
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,appendFileSync,existsSync,realpathSync} from 'node:fs';
import {join,dirname,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {ROOT,requireBuiltHarness} from '../services/runtime/sources.mjs';
import {botSettings} from '../services/bot/settings.mjs';
import {runtimePatch} from '../services/bot/configuration.mjs';
import {saveJson} from '../services/bot/tasks/agent-files.mjs';
import {sourceDigest,checkBuild} from './build-record.mjs';
import {acquireTeamSoak} from './team-soak-lock.mjs';

export const EIGHT_HOURS=8*60*60*1000;
export function parseSoakArgs(args){
  const options={durationMs:EIGHT_HOURS,intervalMs:60000,restartEvery:60,sampleMs:5000,rssLimitMb:2048};
  const numbers={'--duration-ms':'durationMs','--interval-ms':'intervalMs','--restart-every':'restartEvery','--sample-ms':'sampleMs','--rss-limit-mb':'rssLimitMb'};
  for(let i=0;i<args.length;i++){
    const flag=args[i],value=args[++i];
    if(flag==='--home')options.home=value;
    else if(numbers[flag])options[numbers[flag]]=Number(value);
    else throw Error('unknown_soak_option: '+flag);
  }
  if(typeof options.home!=='string'||!options.home||!isAbsolute(options.home))throw Error('soak_home_must_be_an_absolute_new_external_directory');
  if(!Number.isSafeInteger(options.durationMs)||options.durationMs<1000||options.durationMs>7*86400000)throw Error('invalid_soak_duration');
  if(!Number.isSafeInteger(options.intervalMs)||options.intervalMs<0||options.intervalMs>3600000)throw Error('invalid_soak_interval');
  if(!Number.isSafeInteger(options.restartEvery)||options.restartEvery<0)throw Error('invalid_soak_restart_every');
  if(!Number.isSafeInteger(options.sampleMs)||options.sampleMs<500||options.sampleMs>30000)throw Error('invalid_soak_sample_interval');
  if(!Number.isSafeInteger(options.rssLimitMb)||options.rssLimitMb<256)throw Error('invalid_soak_rss_limit');
  return options;
}
export function observationGap(previousAt,now,sampleMs){return previousAt&&now-previousAt>Math.max(30000,sampleMs*4)?now-previousAt:0;}
function externalNewHome(home){
  const path=resolve(home);if(existsSync(path))throw Error('soak_home_already_exists');
  let ancestor=dirname(path);while(!existsSync(ancestor))ancestor=dirname(ancestor);
  const actual=resolve(realpathSync(ancestor),relative(ancestor,path)),inside=relative(realpathSync(ROOT),actual);
  if(!inside||inside!=='..'&&!inside.startsWith('../')&&!isAbsolute(inside))throw Error('soak_data_must_stay_outside_repository');
  return path;
}
async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
function processes(){
  const result=spawnSync('ps',['-axo','pid=,ppid=,rss=,%cpu='],{encoding:'utf8'});if(result.status!==0)throw Error('soak_process_sampling_failed');
  return result.stdout.trim().split('\n').map(line=>{const [pid,ppid,rssKb,cpuPercent]=line.trim().split(/\s+/).map(Number);return {pid,ppid,rssKb,cpuPercent};});
}
function descendants(rows,pid){
  const ids=new Set(pid?[pid]:[]);let changed=true;
  while(changed){changed=false;for(const row of rows)if(ids.has(row.ppid)&&!ids.has(row.pid)){ids.add(row.pid);changed=true;}}
  return rows.filter(row=>ids.has(row.pid));
}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
function counts(home){
  const db=new DatabaseSync(join(home,'bridge.sqlite'),{readOnly:true});
  try{
    const count=table=>db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    return {tasks:count('background_task'),runs:count('background_run'),reports:count('team_report'),artifacts:db.prepare("SELECT COALESCE(SUM(json_array_length(body,'$.artifacts')),0) AS n FROM team_report").get().n,events:count('team_event'),
      delivered:db.prepare("SELECT COUNT(*) AS n FROM team_outbox WHERE json_extract(body,'$.status')='delivered'").get().n,
      pendingDelivery:db.prepare("SELECT COUNT(*) AS n FROM team_outbox WHERE json_extract(body,'$.status')!='delivered'").get().n,
      managementTasks:db.prepare("SELECT COUNT(*) AS n FROM background_task WHERE json_extract(body,'$.managementReview') IS NOT NULL").get().n};
  }finally{db.close();}
}

export async function runTeamSoak(options){
  const sources=requireBuiltHarness(),home=externalNewHome(options.home),runId=randomUUID(),startedAt=Date.now(),initialDigest=sourceDigest();
  if(options.durationMs>=EIGHT_HOURS&&!checkBuild().ready)throw Error('soak_requires_fresh_build: finish pnpm build before the endurance run');
  const unlock=acquireTeamSoak(ROOT,{runId,pid:process.pid,home,startedAt,requestedDurationMs:options.durationMs});
  const abort=new AbortController(),interrupt=()=>abort.abort(Error('soak_interrupted'));
  process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  let child,ownsHome=false,dbReady=false,lastSampleAt=0,timer,chiefId,employeeId,stdoutBytes=0,sourceChanged=null,stoppingHost=false,unexpectedHostExit=false;
  const state={schemaVersion:1,runId,pid:process.pid,home,status:'starting',startedAt,requestedDurationMs:options.durationMs,elapsedMs:0,mode:options.durationMs>=EIGHT_HOURS?'endurance':'smoke',eightHourComplete:false,
    model:'offline-fixtures',sourceDigest:initialDigest,cycles:0,restarts:0,reconnections:0,foregroundReplies:0,cancellations:0,commandExecutions:0,duplicateExecutions:0,
    observationGaps:[],resource:{samples:0,peakTreeRssKb:0,peakProcessCount:0,peakCpuPercent:0},failures:[],buildLock:'output/team-soak.lock'};
  let b;
  const childLive=()=>!!child?.pid&&child.exitCode===null&&child.signalCode===null;
  function publish(){state.elapsedMs=Date.now()-startedAt;state.hostPid=childLive()?child.pid:null;state.updatedAt=Date.now();saveJson(join(home,'status.json'),state);}
  function sample(){
    const now=Date.now(),gap=observationGap(lastSampleAt,now,options.sampleMs);if(gap)state.observationGaps.push({after:lastSampleAt,at:now,gapMs:gap});lastSampleAt=now;
    const rows=processes(),tree=descendants(rows,childLive()?child.pid:null),runner=rows.find(row=>row.pid===process.pid),rssKb=tree.reduce((sum,row)=>sum+row.rssKb,0),cpu=tree.reduce((sum,row)=>sum+row.cpuPercent,0);
    state.resource.samples++;state.resource.peakTreeRssKb=Math.max(state.resource.peakTreeRssKb,rssKb);state.resource.peakProcessCount=Math.max(state.resource.peakProcessCount,tree.length);state.resource.peakCpuPercent=Math.max(state.resource.peakCpuPercent,cpu);
    appendFileSync(join(home,'samples.jsonl'),JSON.stringify({at:now,elapsedMs:now-startedAt,hostPid:child?.pid,tree,runner,gapMs:gap})+'\n');
    if(rssKb>options.rssLimitMb*1024)throw Error('soak_rss_limit_exceeded');publish();
  }
  function tickSample(){try{sample();}catch(error){state.failures.push(error.message);abort.abort(error);}}
  async function api(path,body={}){
    const response=await fetch(b.url+path,{method:'POST',headers:{Authorization:'Bearer offline-soak-token','Content-Type':'application/json',...(path==='/snapshot'?{Connection:'close'}:{})},body:JSON.stringify(body),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(15000)])});
    if(!response.ok)throw Error('soak_api_'+path+': '+(await response.text()).slice(0,300));return response.json();
  }
  async function waitFor(fn,timeoutMs=60000){const end=Date.now()+timeoutMs;while(Date.now()<end){abort.signal.throwIfAborted();const result=await fn();if(result)return result;await delay(100,undefined,{signal:abort.signal});}throw Error('soak_condition_timeout');}
  async function stop(){
    if(unexpectedHostExit)throw Error('soak_host_exit_cleanup_unconfirmed: inspect isolated run processes before recovering the build lock');
    if(!childLive())return;
    stoppingHost=true;
    const owned=descendants(processes(),child.pid).map(row=>row.pid),exit=once(child,'exit');child.kill('SIGTERM');const kill=setTimeout(()=>child.kill('SIGKILL'),10000);
    try{await exit;}finally{clearTimeout(kill);}
    for(let i=0;i<30&&owned.some(alive);i++)await delay(100);
    const remaining=owned.filter(alive);if(remaining.length)throw Error('soak_children_not_cleaned: '+remaining.join(','));stoppingHost=false;
  }
  async function start(){
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(TOKEN|SECRET|PASSWORD|API_KEY)/i.test(key)&&!['DSH_HOME','NODE_OPTIONS'].includes(key)));
    child=spawn(process.execPath,[join(sources.harnessRoot,'apps/cli/lib/bin.js'),'--profile','web','--patch',join(home,'patch.json'),'--host','127.0.0.1','--port',String(b.webPort),'--no-open'],{
      cwd:b.workspace,stdio:['ignore','pipe','pipe'],env:{...env,DSH_HOME:join(home,'harness'),OPENNOVA_BOT_HOME:home,OPENNOVA_CONFIG:join(home,'offline-config.json'),OPENNOVA_SECRETS_FILE:join(home,'unused-secrets.json'),OPENNOVA_SIWC_STORAGE:join(home,'unused-auth'),OPENNOVA_BOT_PLUGIN:sources.botRoot,OPENNOVA_HARNESS_ROOT:sources.harnessRoot,NODE_OPTIONS:'--import='+JSON.stringify(join(ROOT,'services/bot/resolve.mjs')),PATH:dirname(process.execPath)+':'+process.env.PATH}});
    child.once('error',error=>abort.abort(error));
    child.once('exit',()=>{if(!stoppingHost){unexpectedHostExit=true;abort.abort(Error('soak_host_exited'));}});
    const log=data=>{if(stdoutBytes<4*1024*1024){const chunk=data.subarray(0,4*1024*1024-stdoutBytes);appendFileSync(join(home,'host.log'),chunk);stdoutBytes+=chunk.length;}};
    child.stdout.on('data',log);child.stderr.on('data',log);
    await waitFor(async()=>{if(!childLive())throw Error('soak_host_exited');try{return (await api('/health')).ready;}catch(error){if(abort.signal.aborted)throw error;return false;}});
    dbReady=true;
  }
  async function settled(id){return waitFor(async()=>{const d=await api('/background-task',{id});return !['queued','running','pausing','cancelling','blocked'].includes(d.task.status)&&d.task.cleanupConfirmed&&d;});}
  async function cycle(number){
    const requestId='hello-'+number;await api('/ask',{id:requestId,text:'hello',source:'voice'});
    await waitFor(async()=>{const r=await api('/result',{id:requestId});if(r.status==='failed')throw Error('soak_foreground_failed');return r.status==='completed';});state.foregroundReplies++;
    const commandId='command-'+number,command={id:commandId,title:'Soak command '+number,command:`printf '%s\n' '${commandId}' >> execution-ledger.txt`,timeoutMs:5000};
    const first=await api('/background-task-start',command),retry=await api('/background-task-start',command);assert.equal(first.task.runId,retry.task.runId);
    const result=await settled(commandId);assert.equal(result.task.status,'completed');assert.equal(result.runs.length,1);assert.equal(result.task.exitCode,0);
    const executions=readFileSync(join(b.workspace,'execution-ledger.txt'),'utf8').trim().split('\n'),unique=new Set(executions);state.commandExecutions=executions.length;state.duplicateExecutions=executions.length-unique.size;assert.equal(state.duplicateExecutions,0);
    const agentId='employee-'+number;await api('/background-task-start',{id:agentId,kind:'agent',title:'Soak delivery '+number,goal:'生成 report.md，完整说明结论。',assignedBotId:employeeId});
    await waitFor(async()=>['running','completed'].includes((await api('/background-task',{id:agentId})).task.status));
    const overlapId='overlap-'+number;await api('/ask',{id:overlapId,text:'hello',source:'voice'});
    await waitFor(async()=>(await api('/result',{id:overlapId})).status==='completed');state.foregroundReplies++;
    const accepted=await waitFor(async()=>{const d=await api('/background-task',{id:agentId});if(['failed','needs_user','budget_exhausted'].includes(d.task.reviewStatus)||d.task.status==='failed')throw Error('soak_review_failed: '+JSON.stringify({status:d.task.status,review:d.task.reviewStatus}));return d.task.reviewStatus==='accepted'&&d;});
    assert.equal(accepted.runs.length,2);assert.equal(accepted.task.management.usedReworks,1);assert.equal(accepted.task.tokenBudget,0);assert.equal(accepted.task.timeoutMs,0);assert.equal(accepted.task.maxSteps,0);
    assert.match(readFileSync(join(accepted.workspace.path,'report.md'),'utf8'),/COMPLETE_MARKER/);
    const learned=await waitFor(async()=>{const detail=await api('/background-task',{id:agentId}),candidate=detail.skillCandidates?.find(c=>c.source.runId===detail.task.runId);if(candidate?.status==='failed')throw Error('soak_skill_learning_failed');return candidate?.status==='ready'&&detail;});
    assert.equal(learned.skills.length,1);assert.equal(learned.skills[0].name,'soak-report');
    state.skillExtractions=(state.skillExtractions??0)+1;
    const cancelId='cancel-'+number,pidFile='cancel-'+number+'.pid';
    await api('/background-task-start',{id:cancelId,title:'Soak cancellation '+number,command:`node -e "require('node:fs').writeFileSync('${pidFile}',String(process.pid));setInterval(()=>{},1000)"`,timeoutMs:60000});
    await waitFor(()=>existsSync(join(b.workspace,pidFile)));const pid=Number(readFileSync(join(b.workspace,pidFile),'utf8'));assert.ok(alive(pid));
    const running=await api('/background-task',{id:cancelId});await api('/background-task-cancel',{id:cancelId,runId:running.task.runId});const cancelled=await settled(cancelId);assert.equal(cancelled.task.status,'cancelled');assert.equal(alive(pid),false);state.cancellations++;
    const snapshot=await api('/snapshot');assert.equal(snapshot.team.chiefBotId,chiefId);assert.equal(snapshot.tasks.activeCount,0);assert.equal(snapshot.team.members.length,2);state.reconnections++;
    await waitFor(()=>counts(home).pendingDelivery===0);state.database=counts(home);
    state.duplicateExecutions=Math.max(state.duplicateExecutions,state.database.runs-number*7,0);
    assert.equal(state.database.tasks,number*6);assert.equal(state.database.runs,number*7);assert.equal(state.database.managementTasks,number*3);assert.equal(state.database.reports,number*4);assert.equal(state.database.events,state.database.delivered);
    if(options.restartEvery&&number%options.restartEvery===0){await stop();await start();state.restarts++;const restored=await api('/background-task',{id:agentId});assert.equal(restored.task.runId,accepted.task.runId);assert.equal(restored.task.reviewStatus,'accepted');assert.equal(restored.runs.length,2);assert.equal((await api('/team')).chiefBotId,chiefId);}
  }
  try{
    mkdirSync(dirname(home),{recursive:true,mode:0o700});mkdirSync(home,{mode:0o700});ownsHome=true;
    mkdirSync(join(home,'workspace'));writeFileSync(join(home,'client.token'),'offline-soak-token',{mode:0o600});saveJson(join(home,'offline-config.json'),{});publish();
    const port=await freePort();let webPort=await freePort();while(webPort===port)webPort=await freePort();
    b={...botSettings({OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(port),OPENNOVA_BOT_WEB_PORT:String(webPort)}),workspace:join(home,'workspace'),githubTokenPath:join(home,'unused-github.token')};
    const patch=runtimePatch({bot:b,agent:{harnessRoot:sources.harnessRoot},webAssets:join(ROOT,'output/bot/web'),desktop:false});
    const plugins=patch.find(row=>row.insert).insert;plugins.find(row=>row.id==='opennova-chatgpt').name=join(ROOT,'services/bot/tests/fixtures/mock-provider.mjs');plugins.find(row=>row.id==='opennova-bot').config.agentProviderModule=join(ROOT,'services/bot/tests/fixtures/management-provider.mjs');
    saveJson(join(home,'patch.json'),patch);state.url=b.url;sample();timer=setInterval(tickSample,options.sampleMs);await start();
    const team=await api('/team-member',{action:'create',actionId:'soak-employee',name:'Soak employee',role:'验证报告交付',instructions:'按任务要求完成工作。',taskTypes:[]});chiefId=team.chiefBotId;employeeId=team.members.find(member=>!member.chief).id;await api('/skill-action',{action:'save',actionId:'soak-save-skill',name:'soak-report',description:'整理并核验报告的完整结论。',content:'# 报告\n读取本次输入，生成报告并检查所需结论，缺少时补齐。'});
    const binding=(await api('/skills',{botId:employeeId})).assignment;
    await api('/skill-action',{action:'assign',actionId:'soak-assign-skill',botId:employeeId,names:['soak-report'],revision:binding.revision});
    state.status='running';publish();
    do{const cycleAt=Date.now();await cycle(state.cycles+1);state.cycles++;publish();console.log(JSON.stringify({cycles:state.cycles,elapsedMs:state.elapsedMs,requestedDurationMs:options.durationMs,home}));
      const wait=Math.min(options.intervalMs-(Date.now()-cycleAt),options.durationMs-(Date.now()-startedAt));if(wait>0)await delay(wait,undefined,{signal:abort.signal});
    }while(Date.now()-startedAt<options.durationMs);
    // The duration wait can expire before the sampling timer after system sleep.
    // Always observe the tail before judging coverage or clearing that timer.
    sample();
    sourceChanged=sourceDigest()!==initialDigest;if(sourceChanged)throw Error('soak_source_changed_during_run');
    if(options.durationMs>=EIGHT_HOURS&&!checkBuild().ready)throw Error('soak_build_changed_during_run');
    if(state.observationGaps.length)throw Error('soak_observation_gaps_detected');
    state.status='passed';
  }catch(error){state.status=abort.signal.aborted&&['SIGINT','SIGTERM','soak_interrupted'].some(value=>String(abort.signal.reason).includes(value))?'interrupted':'failed';state.failures.push(String(error.message).slice(0,500));}
  finally{
    clearInterval(timer);try{await stop();state.cleanupConfirmed=true;}catch(error){state.cleanupConfirmed=false;state.status='failed';state.failures.push(error.message);}
    if(ownsHome){
      if(dbReady)try{state.database=counts(home);}catch(error){state.failures.push(error.message);state.status='failed';}
      state.sourceChanged=sourceChanged;state.finishedAt=Date.now();state.elapsedMs=state.finishedAt-startedAt;state.eightHourComplete=state.status==='passed'&&options.durationMs>=EIGHT_HOURS&&state.elapsedMs>=EIGHT_HOURS;publish();saveJson(join(home,'result.json'),state);
    }
    process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);if(state.cleanupConfirmed)unlock();
  }
  return state;
}
if(process.argv[1]===import.meta.filename){
  if(process.argv.includes('--help'))console.log('node scripts/team-soak.mjs --home /absolute/new/external/path [--duration-ms 28800000] [--interval-ms 60000] [--restart-every 60] [--sample-ms 5000] [--rss-limit-mb 2048]\nUse caffeinate -i on macOS. Stop with SIGTERM to the pid in status.json. Do not build while output/team-soak.lock exists.');
  else try{const result=await runTeamSoak(parseSoakArgs(process.argv.slice(2)));console.log(JSON.stringify({status:result.status,cycles:result.cycles,elapsedMs:result.elapsedMs,eightHourComplete:result.eightHourComplete,home:result.home,failures:result.failures}));if(result.status!=='passed')process.exitCode=1;}
  catch(error){console.error(error.message);process.exitCode=1;}
}
