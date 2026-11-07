import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {executeBuild} from '../project.mjs';
import {acquireTeamSoak,buildGroupAlive,recoverBuildLock,teamSoakLock} from '../team-soak-lock.mjs';

const projectUrl=new URL('../project.mjs',import.meta.url).href,lockUrl=new URL('../team-soak-lock.mjs',import.meta.url).href;
function fixture(t){const root=mkdtempSync(join(tmpdir(),'nova-build-lock-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
async function until(check){const deadline=Date.now()+7000;while(!check()){if(Date.now()>deadline)throw Error('fixture_timeout');await delay(20);}}
function launch(t,root,source,args=[]){
  const child=spawn(process.execPath,['--input-type=module','-e',source,...args],{cwd:root,stdio:['ignore','pipe','pipe']});let logs='';
  child.stdout.on('data',chunk=>{logs+=chunk;});child.stderr.on('data',chunk=>{logs+=chunk;});const exited=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}});
  return {child,exited,logs:()=>logs};
}
function command(root,source){const path=join(root,'command.mjs');writeFileSync(path,source);return {command:process.execPath,args:[path],cwd:root};}
function buildSource(steps){return `import {executeBuild} from ${JSON.stringify(projectUrl)};await executeBuild(${JSON.stringify(steps)},{root:process.cwd(),record:()=>{}}).catch(error=>{console.error(error.message);process.exitCode=1;});`;}

test('EPERM needs independent process-group absence evidence; unavailable or partial tables remain live',()=>{
  if(process.platform==='win32')return;
  const denied=()=>{throw Object.assign(Error('fixture EPERM'),{code:'EPERM'});};
  const table=stdout=>()=>({status:0,stdout});
  assert.equal(buildGroupAlive(123,{kill:denied,ps:table('1 1\n456 123\n')}),true);
  assert.equal(buildGroupAlive(123,{kill:denied,ps:table('1 1\n456 456\n')}),false);
  for(const ps of [()=>({status:1,stdout:''}),()=>({error:Error('unavailable')}),table(''),table('1 1\nincomplete')])assert.equal(buildGroupAlive(123,{kill:denied,ps}),true);
  assert.equal(buildGroupAlive(123,{kill:()=>{throw Object.assign(Error('gone'),{code:'ESRCH'});},ps:()=>{throw Error('unnecessary ps');}}),false);
});

test('EPERM during a real group exit waits for disappearance and records a successful build',{timeout:15000},async t=>{
  if(process.platform==='win32')return;
  const root=fixture(t),ready=join(root,'descendant');let probes=0,terminations=0,recorded=false;
  const descendant=`require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>process.exit(0),700);`;
  const step=command(root,`import {spawn} from 'node:child_process';import {existsSync} from 'node:fs';spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setInterval(()=>{if(existsSync(${JSON.stringify(ready)}))process.exit(0);},10);`);
  const realKill=process.kill;
  const mock=t.mock.method(process,'kill',(pid,signal)=>{if(pid<0){if(signal===0)probes++;else terminations++;throw Object.assign(Error('fixture EPERM'),{code:'EPERM'});}return realKill(pid,signal);});
  try{await executeBuild([step],{root,record:()=>{recorded=true;}});}finally{mock.mock.restore();}
  assert.ok(probes>1);assert.ok(terminations>0,'the simulated permission race also reaches termination');assert.equal(recorded,true);assert.equal(existsSync(teamSoakLock(root)),false);
  assert.throws(()=>realKill(Number(readFileSync(ready,'utf8')),0),{code:'ESRCH'});
});

test('persistent EPERM with a living group preserves the failed build lock',{timeout:15000},async t=>{
  if(process.platform==='win32')return;
  const root=fixture(t),ready=join(root,'descendant');let recorded=false,group;
  const descendant=`require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`;
  const step=command(root,`import {spawn} from 'node:child_process';import {existsSync} from 'node:fs';spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setInterval(()=>{if(existsSync(${JSON.stringify(ready)}))process.exit(0);},10);`);
  const realKill=process.kill,mock=t.mock.method(process,'kill',(pid,signal)=>{if(pid<0){group=-pid;throw Object.assign(Error('fixture EPERM'),{code:'EPERM'});}return realKill(pid,signal);});
  try{
    await assert.rejects(executeBuild([step],{root,record:()=>{recorded=true;}}),/build_cleanup_unconfirmed/);
    const owner=JSON.parse(readFileSync(join(teamSoakLock(root),'owner.json')));assert.equal(owner.cleanupConfirmed,false);assert.equal(owner.status,'cleanup_unconfirmed');assert.equal(recorded,false);
  }finally{
    mock.mock.restore();if(group){try{realKill(-group,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}await until(()=>!buildGroupAlive(group));}
  }
});

test('a build and soak cannot enter concurrently in either acquisition order',{timeout:15000},async t=>{
  const root=fixture(t),ready=join(root,'ready'),finish=join(root,'finish');
  const step=command(root,`import {writeFileSync,existsSync} from 'node:fs';writeFileSync(${JSON.stringify(ready)},'ready');const timer=setInterval(()=>{if(existsSync(${JSON.stringify(finish)})){clearInterval(timer);}},20);`);
  const running=launch(t,root,buildSource([step]));await until(()=>existsSync(ready));
  const owner=JSON.parse(readFileSync(join(teamSoakLock(root),'owner.json')));assert.equal(owner.purpose,'build');assert.equal(owner.children.length,1);
  assert.throws(()=>acquireTeamSoak(root,{runId:'conflicting-soak',pid:process.pid}),/already_locked/);
  await assert.rejects(executeBuild([],{root,record:()=>{throw Error('must not run');}}),/already_locked/);
  writeFileSync(finish,'finish');assert.equal((await running.exited)[0],0,running.logs());assert.equal(existsSync(teamSoakLock(root)),false);
  const release=acquireTeamSoak(root,{runId:'soak-first',pid:process.pid});
  try{await assert.rejects(executeBuild([command(root,`throw Error('must not spawn')`)],{root,record:()=>{}}),/already_locked/);}finally{release();}
});

test('simultaneous independent build and soak processes have exactly one winner',{timeout:15000},async t=>{
  const root=fixture(t),gate=join(root,'gate'),finish=join(root,'finish'),step=command(root,`import {existsSync} from 'node:fs';const timer=setInterval(()=>{if(existsSync(${JSON.stringify(finish)}))clearInterval(timer);},20);`);
  const source=`import {writeFileSync,existsSync} from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';import {executeBuild} from ${JSON.stringify(projectUrl)};import {acquireTeamSoak} from ${JSON.stringify(lockUrl)};
    const mode=process.argv[1];writeFileSync(mode+'.ready','ready');while(!existsSync('gate'))await delay(10);
    try{if(mode==='build'){await executeBuild(${JSON.stringify([step])},{root:process.cwd(),record:()=>{}});}else{const release=acquireTeamSoak(process.cwd(),{runId:'race-soak',pid:process.pid});try{while(!existsSync('finish'))await delay(20);}finally{release();}}}catch(error){console.error(error.message);process.exitCode=2;}`;
  const build=launch(t,root,source,['build']),soak=launch(t,root,source,['soak']);await until(()=>existsSync(join(root,'build.ready'))&&existsSync(join(root,'soak.ready')));writeFileSync(gate,'go');
  await until(()=>build.child.exitCode===2||soak.child.exitCode===2);
  assert.equal([build,soak].filter(row=>row.child.exitCode===2).length,1);assert.match(build.logs()+soak.logs(),/already_locked/);
  assert.equal(existsSync(teamSoakLock(root)),true);writeFileSync(finish,'finish');
  assert.deepEqual((await Promise.all([build.exited,soak.exited])).map(row=>row[0]).sort(),[0,2]);assert.equal(existsSync(teamSoakLock(root)),false);
});

test('failed commands and failed build recording release only after subprocess cleanup',{timeout:15000},async t=>{
  const root=fixture(t);let recorded=false;
  await assert.rejects(executeBuild([command(root,'process.exit(7)')],{root,record:()=>{recorded=true;}}),/failed \(7\)/);
  assert.equal(recorded,false);assert.equal(existsSync(teamSoakLock(root)),false);
  await assert.rejects(executeBuild([command(root,'process.exit(0)')],{root,record:()=>{throw Error('record_fixture_failure');}}),/record_fixture_failure/);
  assert.equal(existsSync(teamSoakLock(root)),false);acquireTeamSoak(root,{runId:'after-failure',pid:process.pid})();
});

test('a failed build retains ownership until its descendant process exits',{timeout:15000},async t=>{
  const root=fixture(t),ready=join(root,'descendant');
  const descendant=`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),250));setInterval(()=>{},1000);`;
  const step=command(root,`import {spawn} from 'node:child_process';import {existsSync} from 'node:fs';spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});const timer=setInterval(()=>{if(existsSync(${JSON.stringify(ready)}))process.exit(7);},10);`);
  const result=assert.rejects(executeBuild([step],{root,record:()=>{throw Error('must not record');}}),/failed \(7\)/);
  await until(()=>existsSync(ready));const owner=JSON.parse(readFileSync(join(teamSoakLock(root),'owner.json'))),pid=Number(readFileSync(ready,'utf8'));
  assert.equal(buildGroupAlive(owner.children[0].pid),true);assert.throws(()=>acquireTeamSoak(root,{runId:'descendant-conflict',pid:process.pid}),/already_locked/);
  await result;assert.equal(buildGroupAlive(owner.children[0].pid),false);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.equal(existsSync(teamSoakLock(root)),false);
});

test('SIGTERM waits for a resistant build process, prevents later steps and releases after exit',{timeout:15000},async t=>{
  const root=fixture(t),ready=join(root,'ready'),later=join(root,'later');
  const first=command(root,`import {writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`);
  const next={command:process.execPath,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(later)},'wrong')`],cwd:root};
  const running=launch(t,root,buildSource([first,next]));await until(()=>existsSync(ready));const pid=Number(readFileSync(ready,'utf8'));
  running.child.kill('SIGTERM');await delay(100);assert.equal(existsSync(teamSoakLock(root)),true,'the lock stays while the resistant child lives');
  assert.equal((await running.exited)[0],1,running.logs());assert.equal(buildGroupAlive(pid),false);assert.equal(existsSync(later),false);assert.equal(existsSync(teamSoakLock(root)),false);
});

test('a killed build retains its lock and explicit recovery refuses live children or registration gaps',{timeout:15000},async t=>{
  const root=fixture(t),ready=join(root,'ready'),step=command(root,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`);
  const running=launch(t,root,buildSource([step]));await until(()=>existsSync(ready));const pid=Number(readFileSync(ready,'utf8'));
  t.after(()=>{try{process.kill(process.platform==='win32'?pid:-pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}});
  const path=join(teamSoakLock(root),'owner.json'),owner=JSON.parse(readFileSync(path));
  assert.throws(()=>recoverBuildLock(root,owner.runId),/runner_still_alive/);running.child.kill('SIGKILL');await running.exited;
  assert.equal(existsSync(teamSoakLock(root)),true);assert.throws(()=>recoverBuildLock(root,'wrong'),/cleanup_not_proven/);assert.throws(()=>recoverBuildLock(root,owner.runId),/children_still_alive/);
  process.kill(process.platform==='win32'?pid:-pid,'SIGTERM');await until(()=>!buildGroupAlive(pid));
  writeFileSync(path,JSON.stringify({...owner,spawning:true}));assert.throws(()=>recoverBuildLock(root,owner.runId),/cleanup_not_proven/);
  writeFileSync(path,JSON.stringify(owner));recoverBuildLock(root,owner.runId);assert.equal(existsSync(teamSoakLock(root)),false);
});
