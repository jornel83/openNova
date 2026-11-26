import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,realpathSync,existsSync,rmSync,chmodSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {provisionCandidateVerifier,taskCandidateProfile} from '../candidate/install.mjs';
import {assignedWorkspace} from '../candidate/verify.mjs';
import {ROOT} from '../../services/runtime/sources.mjs';

function fixture(t){
  const temp=realpathSync(mkdtempSync(join(tmpdir(),'nova installer '))),source=join(temp,'project'),home=join(temp,'host home');
  mkdirSync(source);t.after(()=>rmSync(temp,{recursive:true,force:true}));return {source,home};
}

test('the host installs a reusable pinned command in a path with spaces and preserves an existing profile',t=>{
  const opt=fixture(t),a=provisionCandidateVerifier(opt),b=provisionCandidateVerifier(opt);
  assert.deepEqual(a,b);assert.deepEqual(taskCandidateProfile(opt.home,opt.source),a);
  assert.throws(()=>execFileSync(a.command,[],{cwd:opt.source,stdio:'pipe'}),error=>error.status===1&&error.stderr.toString().includes('candidate_assignment_required'));
  assert.throws(()=>provisionCandidateVerifier({...opt,regressions:[{command:'true',check:'other'}]}),/already_configured/);
  assert.deepEqual(taskCandidateProfile(opt.home,opt.source),a);
  const script=join(dirname(a.command),'scripts/candidate/verify.mjs');chmodSync(script,0o600);writeFileSync(script,'changed');
  assert.throws(()=>provisionCandidateVerifier(opt),/candidate_tool_changed/);
});

test('automatic provisioning is limited to the host project and leaves custom registration available',t=>{
  const {source,home}=fixture(t);
  assert.throws(()=>taskCandidateProfile(home,source),/not_configured/);
  const p=taskCandidateProfile(home,ROOT);
  assert.equal(p.source,realpathSync(ROOT));assert.equal(existsSync(join(home,'candidate-review.json')),false);
  assert.throws(()=>provisionCandidateVerifier({home:join(source,'state'),source}),/must_be_outside/);
  assert.equal(existsSync(join(source,'state')),false);
});

test('only a bound native assignment can invoke its installed verifier',t=>{
  const {source,home}=fixture(t),p=provisionCandidateVerifier({source,home});
  const assignment=join(home,'tasks','agents','f'.repeat(64)),worktree=join(assignment,'workspace');
  mkdirSync(worktree,{recursive:true});
  const settings=JSON.parse(readFileSync(join(dirname(p.command),'settings.json'),'utf8'));
  for(const record of [{mode:'analysis',path:worktree,source},{mode:'edit',path:source,source},{mode:'edit',path:worktree,source:home}]){
    writeFileSync(join(assignment,'workspace.json'),JSON.stringify(record));
    assert.throws(()=>assignedWorkspace(settings,worktree),/binding_invalid/);
  }
});

test('a managed stage reports its own exit code and interruption waits for group cleanup',async t=>{
  const {source}=fixture(t);
  const {runLogged}=await import('../candidate/process.mjs');
  const {setTimeout:delay}=await import('node:timers/promises');
  const env={PATH:dirname(process.execPath)},cwd=source;
  const failed=await runLogged({command:process.execPath,args:['-e',"console.log('stage-output');process.exit(7)"],cwd,env,timeoutMs:5000,logPath:join(source,'fail.log')});
  assert.equal(failed.exitCode,7);assert.equal(readFileSync(join(source,'fail.log'),'utf8').trim(),'stage-output');
  const controller=new AbortController(),pidPath=join(source,'pid');
  const pending=runLogged({command:process.execPath,args:['-e',"require('node:fs').writeFileSync('pid',String(process.pid));setInterval(()=>{},10000)"],cwd,env,timeoutMs:10000,logPath:join(source,'cancel.log'),signal:controller.signal});
  const rejected=assert.rejects(pending,/candidate_interrupted/);
  for(let i=0;i<100&&!existsSync(pidPath);i++)await delay(30);
  controller.abort();await rejected;
  const pid=Number(readFileSync(pidPath,'utf8'));
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
