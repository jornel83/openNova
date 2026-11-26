import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {ROOT} from '../../services/runtime/sources.mjs';
import {EIGHT_HOURS,parseSoakArgs,observationGap,runTeamSoak} from '../team-soak.mjs';
import {acquireTeamSoak,assertNoTeamSoak,recoverTeamSoakLock,teamSoakLock} from '../team-soak-lock.mjs';

function fixture(t){const root=mkdtempSync(join(tmpdir(),'nova-soak-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
test('endurance CLI defaults to eight actual hours and validates explicit short checks',()=>{
  const options=parseSoakArgs(['--home','/tmp/new-soak']);assert.equal(options.durationMs,EIGHT_HOURS);assert.equal(options.intervalMs,60000);assert.equal(options.restartEvery,60);
  assert.equal(parseSoakArgs(['--home','/tmp/new-soak','--duration-ms','1000']).durationMs,1000);
  for(const args of [[],['--home','relative'],['--home','/tmp/new','--duration-ms','0'],['--home','/tmp/new','--interval-ms','-1'],['--home','/tmp/new','--sample-ms','1'],['--home','/tmp/new','--unknown','1']])assert.throws(()=>parseSoakArgs(args));
  assert.equal(observationGap(1000,6000,5000),0);assert.equal(observationGap(1000,32000,5000),31000,'sleep or unobserved gaps cannot count as continuous coverage');
});
test('build ownership excludes duplicate runners and release checks run identity',t=>{
  const root=fixture(t),owner={runId:'a',pid:process.pid,home:root},release=acquireTeamSoak(root,owner);
  assert.throws(()=>acquireTeamSoak(root,{...owner,runId:'b'}),/already_locked/);assert.throws(()=>assertNoTeamSoak(root),/owns_build/);
  const path=join(teamSoakLock(root),'owner.json');writeFileSync(path,JSON.stringify({...owner,runId:'changed'}));assert.throws(release,/owner_changed/);
  writeFileSync(path,JSON.stringify(owner));release();assert.doesNotThrow(()=>assertNoTeamSoak(root));
});
test('a run refuses existing state or a directory inside the project before reserving it',async t=>{
  const root=fixture(t);writeFileSync(join(root,'preserve.txt'),'original');
  await assert.rejects(runTeamSoak(parseSoakArgs(['--home',root,'--duration-ms','1000'])),/home_already_exists/);
  await assert.rejects(runTeamSoak(parseSoakArgs(['--home',join(ROOT,'output','forbidden-soak-'+Date.now()),'--duration-ms','1000'])),/outside_repository/);
  assert.equal(readFileSync(join(root,'preserve.txt'),'utf8'),'original');assert.equal(existsSync(join(root,'status.json')),false);
});
test('stale-lock recovery requires a matching completed cleanup proof and rejects a live owner',t=>{
  const root=fixture(t),home=join(root,'state');mkdirSync(home);
  acquireTeamSoak(root,{runId:'a',pid:process.pid,home});const proof={runId:'a',pid:process.pid,finishedAt:Date.now(),cleanupConfirmed:true};writeFileSync(join(home,'result.json'),JSON.stringify(proof));
  assert.throws(()=>recoverTeamSoakLock(root,'wrong'),/cleanup_not_proven/);assert.throws(()=>recoverTeamSoakLock(root,'a'),/still_alive/);
  const path=join(teamSoakLock(root),'owner.json'),owner=JSON.parse(readFileSync(path));owner.processStarted='old PID incarnation';writeFileSync(path,JSON.stringify(owner));
  recoverTeamSoakLock(root,'a');assert.equal(existsSync(teamSoakLock(root)),false,'PID reuse is distinguished by process start identity and completed run proof');
});
test('short real Bot/Harness exercise measures work, deduplication, cancellation, restart and cleanup',{timeout:90000},async t=>{
  const root=fixture(t),home=join(root,'run'),child=spawn(process.execPath,[join(ROOT,'scripts/team-soak.mjs'),'--home',home,'--duration-ms','1000','--interval-ms','0','--restart-every','1','--sample-ms','1000'],{cwd:ROOT,env:process.env,stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',chunk=>{logs+=chunk;});child.stderr.on('data',chunk=>{logs+=chunk;});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGTERM');await exit;}});
  const [code]=await once(child,'exit');assert.equal(code,0,logs);
  const result=JSON.parse(readFileSync(join(home,'result.json'),'utf8'));
  assert.equal(result.status,'passed');assert.equal(result.eightHourComplete,false);assert.equal(result.mode,'smoke');assert.ok(result.elapsedMs>=1000);
  assert.equal(result.cycles,1);assert.equal(result.restarts,1);assert.equal(result.foregroundReplies,2);assert.equal(result.cancellations,1);assert.equal(result.commandExecutions,1);assert.equal(result.duplicateExecutions,0);
  assert.equal(result.skillExtractions,1);assert.equal(result.chiefCommandReviews,1);assert.equal(result.database.tasks,7);assert.equal(result.database.runs,8);assert.equal(result.database.managementTasks,4);assert.equal(result.database.reports,4);assert.equal(result.database.pendingDelivery,0);assert.equal(result.database.events,result.database.delivered);
  assert.ok(result.resource.samples>0);assert.ok(result.resource.peakTreeRssKb>0);assert.equal(result.cleanupConfirmed,true);assert.deepEqual(result.observationGaps,[]);
  const cycles=logs.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line)).filter(line=>line.requestedDurationMs);
  const samples=readFileSync(join(home,'samples.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(samples.at(-1).elapsedMs>=cycles.at(-1).elapsedMs,'coverage includes the tail after the final work cycle, even when the next sampling timer has not fired');
  assert.equal(existsSync(teamSoakLock(ROOT)),false);
});

test('SIGTERM stops an in-progress observation, proves cleanup, and never claims eight hours',{timeout:45000},async t=>{
  const root=fixture(t),home=join(root,'interrupted'),child=spawn(process.execPath,[join(ROOT,'scripts/team-soak.mjs'),'--home',home,'--duration-ms','60000','--interval-ms','60000','--sample-ms','1000'],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',chunk=>{logs+=chunk;});child.stderr.on('data',chunk=>{logs+=chunk;});const exited=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exited;}});
  const deadline=Date.now()+30000;let status;
  while(Date.now()<deadline){
    if(existsSync(join(home,'status.json')))status=JSON.parse(readFileSync(join(home,'status.json'),'utf8'));
    if(status?.cycles>=1)break;
    if(child.exitCode!==null)throw Error(logs);await delay(100);
  }
  assert.equal(status?.cycles,1,logs);child.kill('SIGTERM');const [code]=await exited;assert.equal(code,1,logs);
  const result=JSON.parse(readFileSync(join(home,'result.json'),'utf8'));assert.equal(result.status,'interrupted');assert.equal(result.eightHourComplete,false);assert.equal(result.cleanupConfirmed,true);assert.equal(result.hostPid,null);assert.ok(result.elapsedMs<60000);assert.equal(existsSync(teamSoakLock(ROOT)),false);
});
