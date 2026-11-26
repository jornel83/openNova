import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,realpathSync,rmSync,symlinkSync,utimesSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureCandidateEvidence} from '../team/candidate-evidence.mjs';

const json=(file,value)=>writeFileSync(file,JSON.stringify(value));
function fixture(t){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'nova-candidate-evidence-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const rule={version:1,kind:'text-only-start',source:join(root,'source'),command:join(root,'lab','accept'),
    receiptRoot:join(root,'receipts'),reproductions:[{command:'./start.command --no-voice',check:'coldStart',exitCode:1,outputIncludes:'unknown flag --no-voice'}],
    regressions:[{command:'node --test launcher.test.mjs',check:'launcher'}]};
  const task={id:'task',runId:'run',assignmentVersion:2,candidateReview:rule};
  const run={id:'run',jobId:'job',taskId:'task',assignmentVersion:2};
  const job={id:'job',taskId:'task',runId:'run',status:'completed',cleanupConfirmed:true};
  const workspace={source:rule.source,path:join(root,'worker'),sourceHead:'a'.repeat(40),snapshotTree:'b'.repeat(40)};
  const patch='a real patch\n', patchSha256=createHash('sha256').update(patch).digest('hex');
  const jobDir=join(root,'job'),attempt='5678',bundle=join(rule.receiptRoot,attempt);
  mkdirSync(join(jobDir,'steps'),{recursive:true});
  mkdirSync(bundle,{recursive:true});
  const snapshotFiles=new Map(), snapshot=(name,_path,bytes)=>{
    snapshotFiles.set(name,bytes);
    return {id:'id-'+name,status:'available'};
  };
  const stage=name=>({exitCode:0,calls:[],log:name+'.log'});
  const candidate=join(root,'candidate');
  const receipt={attempt,passed:true,base:workspace.sourceHead,snapshot:{source:workspace.source,worktree:workspace.path,candidate,workerSourceBytesVerified:true,
    baseTree:workspace.snapshotTree,workerTree:'c'.repeat(40),workerPatchSha256:patchSha256},
    build:stage('build'),doctor:{...stage('doctor'),ready:true},coldStart:{...stage('coldStart'),exitCode:null,stillRunning:true,terminatedAfterProbe:true},
    warmStart:{...stage('warmStart'),stillRunning:false,terminatedAfterProbe:false},ports:[49888,49889],runtimeId:'rt',healthWorkspace:candidate,
    audioState:{connected:false},chat:{id:'request',status:'completed',text:'NOVA-1234567890ABCDEF',expected:'NOVA-1234567890ABCDEF',webPageStatus:200},
    oldDefault:{log:'oldDefault.log',exitCode:72,calls:[{method:'spawn',entry:'run-continuous.command'}]},bothPortsClosed:true};
  const receiptPath=join(bundle,'receipt.json');
  const marker={passed:true,receipt:receiptPath,runtimeId:'rt',candidateReply:receipt.chat.text,patchSha256,bothPortsClosed:true};
  const epoch=Date.now()-100000;
  const add=(id,offset,command,exitCode,output,overrides={},resultOverrides={})=>{
    const createdAt=epoch+offset,finishedAt=createdAt+500,dir=join(jobDir,'commands',id);
    const status=exitCode===0?'completed':'failed';
    mkdirSync(dir,{recursive:true});
    const step={id,taskId:task.id,runId:run.id,createdAt,finishedAt,arguments:{command},tool:'task_command',status,exitCode,cleanupConfirmed:true,...overrides};
    json(join(jobDir,'steps',id+'.json'),step);
    json(join(dir,'result.json'),{jobId:id,runId:run.id,status,exitCode,bytes:Buffer.byteLength(output),finishedAt,cleanupConfirmed:true,...resultOverrides});
    writeFileSync(join(dir,'output.log'),output);
  };
  const saveReceipt=()=>{
    json(receiptPath,receipt);
    const when=(epoch+10200)/1000;
    utimesSync(receiptPath,when,when);
  };
  const gate=(overrides={},resultOverrides={},output=JSON.stringify(marker),command=rule.command)=>add('gate',10000,command,0,output,overrides,resultOverrides);
  const regression=(overrides={})=>add('regression',8000,rule.regressions[0].command,0,'33 tests passed',{candidatePatchSha256:patchSha256,...overrides});
  writeFileSync(join(bundle,'worker.patch'),patch);
  writeFileSync(join(bundle,'build.log'),'compiled');
  json(join(bundle,'doctor.log'),{build:{ready:true}});
  writeFileSync(join(bundle,'warmStart.log'),'Bot 已在运行：http://127.0.0.1:49888；复用现有会话。');
  saveReceipt();regression();gate();
  const args={task,run,job,jobDir,workspace,patchSha256,snapshot};
  return {capture:()=>captureCandidateEvidence(args),args,rule,receipt,receiptPath,saveReceipt,gate,regression,add,bundle,marker,snapshotFiles,epoch};
}

test('copies only fixed logs and receipt, binds each check, and covers only exact earlier matching failures',t=>{
  const f=fixture(t),r=f.rule.reproductions[0],cmd=f.rule.command;
  f.add('known',100,r.command,1,'shell: unknown flag --no-voice');
  f.add('similar',200,r.command+' ',1,r.outputIncludes);
  f.add('different-cause',300,r.command,1,'permission denied');
  f.add('different-exit',400,r.command,7,r.outputIncludes);
  f.add('foreign-run',500,r.command,1,r.outputIncludes,{runId:'other'});
  f.add('missing-cleanup',550,r.command,1,r.outputIncludes,{}, {cleanupConfirmed:false});
  f.add('first-gate',1000,cmd,1,'candidate warm start failed');
  f.add('incorrect-invocation',2000,'bash '+cmd,2,'interpreter error');
  f.add('previous-test',4000,f.rule.regressions[0].command,1,'1 failed');
  f.add('unrelated',5000,'other',1,r.outputIncludes);
  f.add('late',15000,r.command,1,r.outputIncludes);
  f.gate({}, {},'accept:\n'+JSON.stringify(f.marker)+"\n","bash -lc '"+cmd+"'");
  const result=f.capture();
  assert.equal(result.status,'passed',result.reason);assert.equal(result.stepId,'gate');
  assert.deepEqual(result.coveredStepIds,['known','first-gate','incorrect-invocation','previous-test']);
  assert.deepEqual([...f.snapshotFiles.keys()],['candidate/receipt.json','candidate/build.log','candidate/doctor.log','candidate/warmStart.log','candidate/regression-launcher.log']);
  assert.deepEqual(result.checks.map(c=>c.check),['build','doctor','coldStart','warmStart','chat','oldDefault','cleanup','launcher']);
  assert.equal(result.checks.at(-1).stepId,'regression');assert.ok(result.checks.every(c=>result.artifactIds.includes(c.artifactId)));
});

test('declines stale, denied, ambiguous and indirect gate evidence',t=>{
  const cases=[
    f=>f.gate({}, {},JSON.stringify(f.marker),'bash '+f.rule.command),
    f=>f.gate({}, {},JSON.stringify(f.marker),'echo '+f.rule.command),
    f=>f.gate({}, {},JSON.stringify(f.marker)+'\n'+JSON.stringify(f.marker)),
    f=>f.gate({}, {},JSON.stringify({...f.marker,receipt:join(f.bundle,'..','another','receipt.json')})),
    f=>f.gate({}, {},JSON.stringify({...f.marker,candidateReply:'NOVA-0000000000000000'})),
    f=>f.gate({}, {jobId:'other'}),
    f=>f.gate({}, {bytes:1}),
    f=>f.gate({arguments:{command:f.rule.command,workdir:'other'}}),
    f=>{utimesSync(f.receiptPath,1,1);},
    f=>{f.regression({candidatePatchSha256:'0'.repeat(64)});},
    f=>{f.add('late-regression',14000,f.rule.regressions[0].command,1,'failed');},
    f=>{f.add('late-gate',14000,f.rule.command,1,'failed');},
    f=>{f.rule.regressions.push({...f.rule.regressions[0]});},
    f=>{f.args.job.cleanupConfirmed=false;},
    f=>{f.args.task.sourceWorkspace=f.args.jobDir;},
    f=>f.gate({}, {},JSON.stringify(f.marker)+'\nother final result'),
    f=>{f.args.snapshot=()=>({status:'too_large'});},
  ];
  for(const [i,change] of cases.entries()){
    const f=fixture(t);change(f);
    const result=f.capture();
    assert.equal(result.status,'incomplete','case '+i);assert.deepEqual(result.coveredStepIds,[]);
  }
});

test('requires data for runtime, isolated snapshot, exact patch, stage outcomes, negative control and cleanup',t=>{
  for(const [i,change] of [
    r=>{r.snapshot.worktree=r.snapshot.source;},r=>{r.snapshot.workerSourceBytesVerified=false;},
    r=>{r.snapshot.baseTree='0'.repeat(40);},r=>{r.snapshot.workerPatchSha256='1'.repeat(64);},
    r=>{r.healthWorkspace=r.snapshot.source;},r=>{r.ports[1]=r.ports[0];},r=>{r.audioState.connected=true;},
    r=>{r.coldStart.calls=[{entry:'audio'}];},r=>{r.warmStart={...r.coldStart,log:'warmStart.log'};},
    r=>{r.chat.text='wrong';},r=>{r.oldDefault.calls=[];},r=>{r.bothPortsClosed=false;},
  ].entries()){
    const f=fixture(t);change(f.receipt);f.saveReceipt();
    assert.equal(f.capture().status,'incomplete','case '+i);
  }
});

test('rejects tampered bytes, oversized logs, file or directory symlinks, and missing corroborating logs',t=>{
  for(const [i,change] of [
    f=>writeFileSync(join(f.bundle,'worker.patch'),'changed'),
    f=>writeFileSync(join(f.bundle,'build.log'),Buffer.alloc(2*1024*1024+1)),
    f=>writeFileSync(join(f.bundle,'doctor.log'),'{"build":{"ready":false}}'),
    f=>writeFileSync(join(f.bundle,'warmStart.log'),'reused unknown service'),
    f=>{const path=join(f.bundle,'build.log');rmSync(path);symlinkSync(join(f.bundle,'doctor.log'),path);},
    f=>{rmSync(f.bundle,{recursive:true});symlinkSync(f.args.jobDir,f.bundle);},
  ].entries()){
    const f=fixture(t);change(f);assert.equal(f.capture().status,'incomplete','case '+i);
    assert.equal(f.snapshotFiles.size,0);
  }
});

test('standby mode proves audio is off and reuses the same bot with a fresh voice lease',t=>{
  const f=fixture(t),r=f.receipt;
  r.launchMode='voice-standby';
  r.audioState={connected:true,audioEnabled:false,phase:'standby',capture:'off',playback:'idle',recognition:'idle',voiceInstanceId:'cold'};
  r.coldStart.voiceInstanceId='cold';
  r.warmStart={...r.coldStart,log:'warmStart.log',voiceInstanceId:'warm',previousVoiceInstanceId:'cold',runtimeId:r.runtimeId};
  writeFileSync(join(f.bundle,'warmStart.log'),'复用 Bot：http://127.0.0.1:'+r.ports[0]+'/');
  f.saveReceipt();assert.equal(f.capture().status,'passed');
  for(const [obj,field,bad] of [[r.audioState,'audioEnabled',true],[r.audioState,'capture','recording'],[r.warmStart,'voiceInstanceId','cold'],
    [r.warmStart,'previousVoiceInstanceId','unknown'],[r.warmStart,'runtimeId','other'],[r,'launchMode','unknown']]){
    const original=obj[field];obj[field]=bad;f.saveReceipt();assert.equal(f.capture().status,'incomplete');obj[field]=original;
  }
});

test('a detached text launcher hands off to the same reachable, audio-disconnected bot',t=>{
  const f=fixture(t),r=f.receipt;
  r.launchMode='detached-text';
  r.coldStart={...r.warmStart,log:'coldStart.log',runtimeId:r.runtimeId,signal:null};
  Object.assign(r.warmStart,{runtimeId:r.runtimeId,signal:null,audioState:{connected:false}});
  f.saveReceipt();
  assert.equal(f.capture().status,'passed','Bot launcher reuse log');
  const log=join(f.bundle,'warmStart.log'),url='http://127.0.0.1:'+r.ports[0];
  writeFileSync(log,'检查 Bot 服务……\n复用 Bot：'+url+'/\n仅文字服务已就绪。\n');
  assert.equal(f.capture().status,'passed','voice launcher reuse log');
  for(const [obj,key,bad] of [
    [r.coldStart,'runtimeId',undefined],[r.warmStart,'runtimeId','other-bot'],
    [r.coldStart,'signal',undefined],[r.warmStart,'signal','SIGTERM'],
    [r.coldStart,'exitCode',1],[r.warmStart,'exitCode',null],[r.coldStart,'stillRunning',true],
    [r.warmStart,'terminatedAfterProbe',true],[r.coldStart,'calls',[{entry:'audio'}]],
    [r.warmStart,'calls',[{entry:'ssh'}]],[r.audioState,'connected',true],
    [r.warmStart,'audioState',undefined],[r.warmStart.audioState,'connected',true],
    [r.chat,'status','failed'],[r,'bothPortsClosed',false],
  ]){
    const previous=obj[key];obj[key]=bad;f.saveReceipt();
    assert.equal(f.capture().status,'incomplete',key+'='+JSON.stringify(bad));obj[key]=previous;
  }
  f.saveReceipt();
  for(const output of ['复用 Bot：http://127.0.0.1:'+r.ports[1]+'/', '复用 Bot：'+url+'/other']){
    writeFileSync(log,output);
    assert.equal(f.capture().reason,'candidate_warm_reuse_unconfirmed');
  }
});

test('the default launcher must actually attempt the device entry even when it maps the child exit',t=>{
  const f=fixture(t),s=f.receipt.oldDefault;
  Object.assign(s,{entry:'start.command',exitCode:1});
  f.saveReceipt();assert.equal(f.capture().status,'incomplete');
  s.calls[0].injectedExitCode=72;f.saveReceipt();assert.equal(f.capture().status,'passed');
  s.exitCode=0;f.saveReceipt();assert.equal(f.capture().status,'incomplete');
});
