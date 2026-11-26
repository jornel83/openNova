import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,realpathSync,writeFileSync} from 'node:fs';
import {createConnection} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {probeTextStart,redactProbeLog} from '../candidate/text-start.mjs';

const host=fileURLToPath(new URL('./fixtures/candidate-probe-host.mjs',import.meta.url));
test('only the registered Keychain helper sees account HOME during the candidate probe',t=>{
  const f=fixture(t,'foreground'),helper=join(f.runtimeDir,'account-helper'),other=join(f.runtimeDir,'other');
  for(const path of [helper,other])writeFileSync(path,'#!/bin/sh\nprintf "%s" "$HOME"\n',{mode:0o700});
  const guard=fileURLToPath(new URL('../candidate/no-audio.cjs',import.meta.url));
  const code="const {execFile}=require('node:child_process');const {promisify}=require('node:util');Promise.all(process.argv.slice(1).map(f=>promisify(execFile)(f))).then(results=>console.log(JSON.stringify([process.env.HOME,...results.map(r=>r.stdout)])));";
  const output=execFileSync(process.execPath,['--require',guard,'-e',code,helper,other],{encoding:'utf8',env:{HOME:f.runtimeDir,PATH:process.env.PATH,
    OPENNOVA_PROBE_CONTAIN_CHILDREN:'1',OPENNOVA_PROBE_ACCOUNT_HOME:f.attemptDir,OPENNOVA_PROBE_ACCOUNT_HELPER:helper}});
  assert.deepEqual(JSON.parse(output),[f.runtimeDir,f.attemptDir,f.runtimeDir]);
});
test('published logs remove web bootstrap and pairing credentials and preserve warm-reuse proof',()=>{
  const text='http://127.0.0.1:41001/?token=ephemeral#access_token=second\n一次性配对码 1234-abcd（60 秒有效）。\nBearer value-here\nsecret-body\n复用 Bot：http://127.0.0.1:41001/';
  const saved=redactProbeLog(text,['secret-body']);
  assert.doesNotMatch(saved,/ephemeral|second|1234-abcd|value-here|secret-body/);
  assert.match(saved,/复用 Bot：http:\/\/127.0.0.1:41001\//);
});
function fixture(t,mode){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'nova probe tests-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const candidate=join(root,'candidate'),attemptDir=join(root,'receipt'),runtimeDir=join(root,'private');
  for(const path of [candidate,attemptDir,runtimeDir,join(candidate,'tools/voice')])mkdirSync(path,{recursive:true});
  writeFileSync(join(candidate,'index.html'),'<html><body>Nova</body></html>');
  writeFileSync(join(candidate,'start.command'),'#!/bin/sh\nexec "$OPENNOVA_NODE" "$PROBE_TEST_HOST" "$@"\n',{mode:0o700});
  return {candidate,attemptDir,runtimeDir,receipt:{},env:{PATH:process.env.PATH,PROBE_TEST_MODE:mode,PROBE_TEST_HOST:host}};
}
for(const mode of ['foreground','standby','detached'])test('candidate probe observes real HTTP echo and '+mode+' restart semantics',async t=>{
  const options=fixture(t,mode),{receipt}=options;
  if(mode==='detached')options.env.PROBE_TEST_STALE_LOCK='1';
  await probeTextStart(options);
  assert.equal(receipt.bothPortsClosed,true);
  assert.equal(receipt.chat.text,receipt.chat.expected);
  if(mode==='detached'){
    assert.equal(receipt.launchMode,'detached-text');
    for(const stage of [receipt.coldStart,receipt.warmStart]){
      assert.equal(stage.exitCode,0);assert.equal(stage.signal,null);assert.equal(stage.runtimeId,receipt.runtimeId);
      assert.equal(stage.terminatedAfterProbe,false);assert.equal(stage.stillRunning,false);
    }
    assert.deepEqual(receipt.audioState,{connected:false});assert.deepEqual(receipt.warmStart.audioState,{connected:false});
  }else{
    assert.equal(receipt.coldStart.exitCode,null);assert.equal(receipt.coldStart.terminatedAfterProbe,true);
  }
  assert.equal(receipt.oldDefault.entry,'start.command');assert.equal(receipt.oldDefault.exitCode,72);
  assert.deepEqual(receipt.oldDefault.calls,[{method:'spawn',entry:'run-continuous.command',injectedExitCode:72}]);
  if(mode==='standby'){
    assert.equal(receipt.audioState.audioEnabled,false);
    assert.equal(receipt.warmStart.previousVoiceInstanceId,receipt.audioState.voiceInstanceId);
    assert.notEqual(receipt.warmStart.voiceInstanceId,receipt.audioState.voiceInstanceId);
    assert.equal(receipt.warmStart.runtimeId,receipt.runtimeId);
  }else assert.equal(receipt.warmStart.exitCode,0);
});
test('foreground text may hold a launcher lock and keep audio disconnected',async t=>{
  const options=fixture(t,'foreground');
  options.env.PROBE_TEST_FOREGROUND_LOCK='1';
  await probeTextStart(options);
  assert.equal(options.receipt.launchMode,undefined);assert.equal(options.receipt.coldStart.terminatedAfterProbe,true);
  assert.deepEqual(options.receipt.audioState,{connected:false});assert.equal(options.receipt.bothPortsClosed,true);
});
test('standby first published at the end of the reply still needs a new warm standby lease',async t=>{
  const options=fixture(t,'standby');
  options.env.PROBE_TEST_LATE_STANDBY='1';
  await probeTextStart(options);
  assert.equal(options.receipt.launchMode,'voice-standby');
  assert.equal(options.receipt.warmStart.previousVoiceInstanceId,options.receipt.coldStart.voiceInstanceId);
  assert.notEqual(options.receipt.warmStart.voiceInstanceId,options.receipt.coldStart.voiceInstanceId);
});
for(const state of [{connected:true},{connected:false,capture:'listening'},{connected:true,audioEnabled:true}])
  test('text reply cannot hide an unsafe or incomplete voice state '+JSON.stringify(state),async t=>{
    const options=fixture(t,'foreground');
    options.env.PROBE_TEST_AUDIO_AFTER_REPLY=JSON.stringify(state);
    await assert.rejects(probeTextStart(options),/audio_not_off/);
    assert.equal(options.receipt.warmStart,undefined);assert.equal(options.receipt.bothPortsClosed,true);
  });
for(const [option,error] of [
  ['PROBE_TEST_SILENT_REUSE',/warm_identity_mismatch/],
  ['PROBE_TEST_WARM_AUDIO',/warm_audio_not_off/],
  ['PROBE_TEST_SWITCH_RUNTIME',/snapshot_instance_changed/],
  ['PROBE_TEST_COLD_FAILURE',/unexpected_coldStart_exit/],
])test('detached text handoff rejects '+option,async t=>{
  const options=fixture(t,'detached');
  options.env[option]='1';
  await assert.rejects(probeTextStart(options),error);
  assert.equal(options.receipt.launchMode,undefined);assert.equal(options.receipt.bothPortsClosed,true);
});
test('an exited launcher without a serving host cannot complete the probe',async t=>{
  const options=fixture(t,'detached');
  options.env.PROBE_TEST_NO_SERVER='1';
  await assert.rejects(probeTextStart({...options,signal:AbortSignal.timeout(800)}),error=>error.name==='TimeoutError'||error.cause?.name==='TimeoutError');
  assert.equal(options.receipt.chat,undefined);assert.equal(options.receipt.bothPortsClosed,true);
});
test('a top-level launcher that always starts in text mode fails the default voice control',async t=>{
  const options=fixture(t,'foreground');options.env.PROBE_TEST_ALWAYS_TEXT='1';
  await assert.rejects(probeTextStart(options),/default_voice_missing/);
  assert.equal(options.receipt.oldDefault.entry,'start.command');assert.equal(options.receipt.oldDefault.exitCode,0);
  assert.deepEqual(options.receipt.oldDefault.calls,[]);assert.equal(options.receipt.bothPortsClosed,true);
});
test('mismatched web reply fails and closes both candidate ports',async t=>{
  const options=fixture(t,'standby');options.env.PROBE_TEST_BAD_REPLY='1';
  await assert.rejects(probeTextStart(options),/chat_echo_mismatch/);
  assert.equal(options.receipt.chat.mismatch.length,5);assert.equal(options.receipt.chat.mismatch.containsExpected,false);
  assert.equal(options.receipt.bothPortsClosed,true);assert.equal(options.receipt.warmStart,undefined);
});
test('aborted probe retains partial evidence and closes its own ports',async t=>{
  const options=fixture(t,'standby'),controller=new AbortController();
  const timer=setInterval(()=>{if(options.receipt.runtimeId)controller.abort(Error('probe_test_aborted'));},10);
  try{await assert.rejects(probeTextStart({...options,signal:controller.signal}),error=>error===controller.signal.reason||error.cause===controller.signal.reason);}
  finally{clearInterval(timer);}
  assert.equal(options.receipt.bothPortsClosed,true);
});
test('when the verifier is killed its guardian reaps the detached candidate host',async t=>{
  const options=fixture(t,'standby'),marker=join(options.runtimeDir,'listeners');
  options.env.PROBE_TEST_STALL=marker;
  const module=new URL('../candidate/text-start.mjs',import.meta.url);
  const child=spawn(process.execPath,['--input-type=module','-e','import {probeTextStart} from '+JSON.stringify(module.href)+'; await probeTextStart(JSON.parse(process.argv[1]))',JSON.stringify(options)],{stdio:'ignore'});
  const done=once(child,'exit');t.after(()=>child.kill('SIGKILL'));
  const deadline=Date.now()+10000;
  while(!existsSync(marker)&&child.exitCode===null&&Date.now()<deadline)await delay(50);
  assert.ok(existsSync(marker),'the verified host served a real web request');
  const ports=JSON.parse(readFileSync(marker,'utf8'));
  const open=port=>new Promise(resolve=>{const socket=createConnection(port,'127.0.0.1');socket.on('connect',()=>{socket.destroy();resolve(true);});socket.on('error',()=>resolve(false));});
  assert.deepEqual(await Promise.all(ports.map(open)),[true,true]);
  child.kill('SIGKILL');await done;
  const cleanup=Date.now()+8000;
  while((await Promise.all(ports.map(open))).some(Boolean)&&Date.now()<cleanup)await delay(80);
  assert.deepEqual(await Promise.all(ports.map(open)),[false,false]);
});
