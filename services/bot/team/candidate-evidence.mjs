import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync,readdirSync,realpathSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {builtinChecks as stages} from './candidate-profile.mjs';

const KiB=1024, logLimit=2*1024*KiB;
const sha256=/^[a-f0-9]{64}$/, gitObject=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const logs=['build','doctor','warmStart'];
const validId=id=>typeof id==='string'&&/^[\w-]{1,200}$/.test(id);
const validPath=path=>typeof path==='string'&&isAbsolute(path)&&resolve(path)===path;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function requireThat(ok,reason){if(!ok)throw Error('candidate_'+reason);}
function sameFile(a,b){
  return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
}

// Ignore all paths supplied inside receipts. Only read fixed files below a host-configured root.
function readBound(root,segments,limit){
  requireThat(lstatSync(root).isDirectory(),'evidence_root_invalid');
  const actualRoot=realpathSync(root), path=join(actualRoot,...segments);
  const confined=()=>realpathSync(path)===path&&realpathSync(root)===actualRoot;
  requireThat(confined(),'evidence_link');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const stat=fstatSync(fd);
    requireThat(stat.isFile()&&stat.nlink===1&&stat.size<=limit,'evidence_file_invalid');
    const bytes=Buffer.alloc(stat.size);
    for(let offset=0;offset<bytes.length;){
      const n=readSync(fd,bytes,offset,bytes.length-offset,null);
      requireThat(n>0,'evidence_changed');
      offset+=n;
    }
    requireThat(sameFile(stat,fstatSync(fd))&&sameFile(stat,lstatSync(path))&&confined(),'evidence_changed');
    return {bytes,mtimeMs:stat.mtimeMs};
  }finally{closeSync(fd);}
}
function parse(bytes){
  try{return JSON.parse(bytes.toString('utf8'));}catch{throw Error('candidate_evidence_json_invalid');}
}
function jobSteps(jobDir){
  const names=readdirSync(join(jobDir,'steps')).filter(name=>/^[\w-]+\.json$/.test(name));
  return names.map(name=>{
    const step=parse(readBound(jobDir,['steps',name],256*KiB).bytes);
    requireThat(validId(step.id)&&name===step.id+'.json','step_binding');
    return step;
  }).sort((a,b)=>a.createdAt-b.createdAt);
}
function commandRecord(jobDir,task,run,workspace,step){
  requireThat(step.tool==='task_command'&&step.taskId===task.id&&step.runId===run.id&&
    resolve(workspace.path,step.arguments.workdir??'.')===workspace.path&&!step.reusedRunId,'step_binding');
  const path=['commands',step.id];
  const result=parse(readBound(jobDir,[...path,'result.json'],32*KiB).bytes);
  requireThat(Number.isSafeInteger(step.createdAt)&&Number.isSafeInteger(step.finishedAt)&&step.createdAt<=step.finishedAt&&
    result.jobId===step.id&&result.runId===run.id&&result.status===step.status&&result.exitCode===step.exitCode&&
    step.cleanupConfirmed===true&&result.cleanupConfirmed===true&&!result.error&&!result.signal&&!result.truncated&&
    (result.finishedAt===undefined||result.finishedAt>=step.createdAt&&result.finishedAt<=step.finishedAt),'command_result_invalid');
  const output=readBound(jobDir,[...path,'output.log'],logLimit).bytes;
  requireThat(result.bytes===undefined||output.length===result.bytes,'command_output_incomplete');
  return output;
}

function commandsFor(path){
  requireThat(validPath(path)&&!/[\x00-\x1f\x7f]/.test(path),'command_invalid');
  const quote=text=>"'"+text.replaceAll("'","'\\''")+"'";
  const quoted=text=>{const forms=[quote(text)];if(!/["$`\\!]/.test(text))forms.push('"'+text+'"');return forms;};
  const direct=new Set(quoted(path));
  if(/^[\p{L}\p{N}\p{M}/._+=,@%-]+$/u.test(path))direct.add(path);
  const genuine=new Set([...direct,...[...direct].flatMap(command=>quoted(command).map(word=>'bash -lc '+word))]);
  return {genuine,wrongInterpreter:new Set([...direct].map(command=>'bash '+command))};
}
function markerFrom(bytes){
  const lines=bytes.toString('utf8').trimEnd().split(/\r?\n/),markers=[];
  for(const [index,line] of lines.entries()){
    if(!line.trimStart().startsWith('{'))continue;
    let obj;try{obj=JSON.parse(line);}catch{continue;}
    if(obj&&('receipt' in obj||'passed' in obj&&'patchSha256' in obj))markers.push({index,obj});
  }
  requireThat(markers.length===1&&markers[0].index===lines.length-1&&markers[0].obj.passed===true,'receipt_marker_invalid');
  return markers[0].obj;
}
function verifyPolicy(rule,workspace){
  requireThat(rule?.version===1&&rule.kind==='text-only-start'&&validPath(rule.source)&&rule.source===workspace?.source&&
    validPath(workspace.path)&&workspace.path!==rule.source&&validPath(rule.receiptRoot),'policy_invalid');
  const allowed=commandsFor(rule.command);
  const regressions=rule.regressions??[],reproductions=rule.reproductions??[];
  requireThat(Array.isArray(regressions)&&regressions.length<=16&&Array.isArray(reproductions)&&reproductions.length<=32,'policy_invalid');
  const checks=new Set(stages),commands=new Set([...allowed.genuine,...allowed.wrongInterpreter]);
  for(const row of regressions){
    requireThat(validId(row?.check)&&!checks.has(row.check)&&typeof row.command==='string'&&row.command.trim()&&!commands.has(row.command),'regression_policy_invalid');
    checks.add(row.check);commands.add(row.command);
  }
  for(const row of reproductions){
    requireThat(checks.has(row?.check)&&Number.isInteger(row.exitCode)&&row.exitCode>0&&row.exitCode<=255&&
      typeof row.outputIncludes==='string'&&row.outputIncludes.trim()&&typeof row.command==='string'&&row.command.trim()&&!commands.has(row.command),'reproduction_policy_invalid');
    commands.add(row.command);
  }
  return {regressions,reproductions,allowed};
}
function launched(stage,name,foreground){
  return stage?.log===name+'.log'&&Array.isArray(stage.calls)&&stage.calls.length===0&&
    stage.exitCode===(foreground?null:0)&&stage.stillRunning===foreground&&stage.terminatedAfterProbe===foreground;
}
function independentPaths(a,b){
  const below=(parent,child)=>{const rel=relative(parent,child);return rel!== '..'&&!rel.startsWith('../')&&!isAbsolute(rel);};
  return !below(a,b)&&!below(b,a);
}
function verifyReceipt(rule,workspace,gate,marker,patchSha256){
  requireThat(validPath(marker.receipt)&&basename(marker.receipt)==='receipt.json','receipt_path_invalid');
  const attempt=basename(dirname(marker.receipt));
  requireThat(validId(attempt)&&marker.receipt===join(rule.receiptRoot,attempt,'receipt.json'),'receipt_path_invalid');
  const load=(file,limit)=>readBound(rule.receiptRoot,[attempt,file],limit);
  const {bytes,mtimeMs}=load('receipt.json',256*KiB),receipt=parse(bytes);
  requireThat(mtimeMs>=gate.createdAt-2&&mtimeMs<=gate.finishedAt+2,'receipt_not_from_command');
  requireThat(receipt?.attempt===attempt&&receipt.passed===true,'receipt_failed');
  const s=receipt.snapshot;
  requireThat(s?.source===workspace.source&&s.worktree===workspace.path&&s.workerSourceBytesVerified===true&&
    gitObject.test(receipt.base)&&receipt.base===workspace.sourceHead&&gitObject.test(s.baseTree)&&s.baseTree===workspace.snapshotTree&&
    gitObject.test(s.workerTree)&&s.workerTree!==s.baseTree&&validPath(s.candidate)&&independentPaths(s.source,s.candidate)&&
    independentPaths(s.worktree,s.candidate)&&receipt.healthWorkspace===s.candidate,'workspace_mismatch');
  requireThat(sha256.test(patchSha256)&&s.workerPatchSha256===patchSha256&&marker.patchSha256===patchSha256,'patch_mismatch');
  const patch=load('worker.patch',8*1024*KiB).bytes;
  requireThat(patch.length>0&&hash(patch)===patchSha256,'patch_mismatch');
  for(const name of ['build','doctor']){
    const stage=receipt[name];
    requireThat(stage?.exitCode===0&&stage.log===name+'.log'&&Array.isArray(stage.calls)&&!stage.calls.length,name+'_failed');
  }
  const standby=receipt.launchMode==='voice-standby',detached=receipt.launchMode==='detached-text';
  const cold=receipt.coldStart,warm=receipt.warmStart;
  requireThat((receipt.launchMode===undefined||standby||detached)&&receipt.doctor.ready===true&&
    launched(cold,'coldStart',!detached)&&launched(warm,'warmStart',standby),'launch_incomplete');
  const audio=receipt.audioState;
  if(standby){
    requireThat(audio?.connected===true&&audio.audioEnabled===false&&audio.phase==='standby'&&audio.capture==='off'&&
      audio.playback==='idle'&&audio.recognition==='idle'&&validId(audio.voiceInstanceId)&&cold.voiceInstanceId===audio.voiceInstanceId&&
      warm.previousVoiceInstanceId===cold.voiceInstanceId&&validId(warm.voiceInstanceId)&&warm.voiceInstanceId!==cold.voiceInstanceId&&
      warm.runtimeId===receipt.runtimeId,'standby_reuse_unconfirmed');
  }else{
    requireThat(audio?.connected===false,'health_incomplete');
    if(detached)requireThat(cold.signal===null&&warm.signal===null&&cold.runtimeId===receipt.runtimeId&&
      warm.runtimeId===receipt.runtimeId&&warm.audioState?.connected===false,'detached_reuse_unconfirmed');
  }
  requireThat(Array.isArray(receipt.ports)&&receipt.ports.length===2&&new Set(receipt.ports).size===2&&
    receipt.ports.every(port=>Number.isInteger(port)&&port>0&&port<65536)&&validId(receipt.runtimeId)&&marker.runtimeId===receipt.runtimeId,'health_incomplete');
  const chat=receipt.chat;
  requireThat(validId(chat?.id)&&chat.status==='completed'&&chat.webPageStatus===200&&/^NOVA-[0-9A-F]{16}$/.test(chat.expected)&&
    chat.text===chat.expected&&marker.candidateReply===chat.text,'chat_failed');
  const control=receipt.oldDefault;
  // Historical receipts invoked the voice entry directly. The user-facing
  // launcher may map the child's injected 72 to its own nonzero exit code.
  const controlExit=control?.entry==='start.command'
    ?[1,72].includes(control.exitCode)&&control.calls?.[0]?.injectedExitCode===72
    :control?.entry===undefined&&control?.exitCode===72;
  requireThat(control?.log==='oldDefault.log'&&controlExit&&Array.isArray(control.calls)&&
    control.calls.length===1&&control.calls[0]?.method==='spawn'&&control.calls[0].entry==='run-continuous.command','control_failed');
  requireThat(receipt.bothPortsClosed===true&&marker.bothPortsClosed===true,'cleanup_unconfirmed');
  const files=new Map([['receipt',bytes]]);
  for(const name of logs){
    const data=load(name+'.log',logLimit).bytes;
    requireThat(data.length>0,'stage_log_empty');
    if(name==='doctor')requireThat(parse(data)?.build?.ready===true,'doctor_log_invalid');
    if(name==='warmStart'){
      const text=data.toString('utf8');
      const url='http://127.0.0.1:'+receipt.ports[0];
      const voiceLauncher='复用 Bot：'+url+'/',botLauncher=url+'；复用现有会话。';
      const reused=detached
        ?text.split(/\r?\n/).some(line=>line.trim()===voiceLauncher||line.trim()==='Bot 已在运行：'+botLauncher)
        :text.includes(standby?voiceLauncher:botLauncher);
      requireThat(reused,'warm_reuse_unconfirmed');
    }
    files.set(name,data);
  }
  return files;
}

/** A pass binds this run's real command output, candidate receipt and tested bytes to its report. */
export function captureCandidateEvidence({task,run,job,jobDir,workspace,patchSha256,snapshot}){
  const evidence={status:'incomplete',taskId:task.id,runId:run.id,assignmentVersion:task.assignmentVersion??1,
    patchSha256,stepId:null,artifactIds:[],coveredStepIds:[],checks:[]};
  try{
    requireThat(task.runId===run.id&&run.taskId===task.id&&job.taskId===task.id&&job.runId===run.id&&
      (run.jobId===undefined||run.jobId===job.id)&&(run.assignmentVersion??1)===evidence.assignmentVersion&&
      job.status==='completed'&&job.cleanupConfirmed===true,'job_binding');
    const rule=task.candidateReview;
    const {allowed,regressions,reproductions}=verifyPolicy(rule,workspace);
    for(const path of [task.cwd,task.sourceWorkspace,run.sourceWorkspace].filter(Boolean))
      requireThat(path===rule.source||validPath(path)&&realpathSync(path)===rule.source,'project_mismatch');
    const steps=jobSteps(jobDir).filter(step=>step.tool==='task_command');
    const cmd=step=>step.arguments?.command;
    const attempts=steps.filter(step=>allowed.genuine.has(cmd(step))||allowed.wrongInterpreter.has(cmd(step)));
    const gate=attempts.at(-1);
    requireThat(gate,'command_missing');
    evidence.stepId=gate.id;
    requireThat(allowed.genuine.has(cmd(gate))&&gate.status==='completed'&&gate.exitCode===0,'final_command_failed');
    const record=step=>commandRecord(jobDir,task,run,workspace,step);
    const files=verifyReceipt(rule,workspace,gate,markerFrom(record(gate)),patchSha256);
    const store=(name,bytes)=>{
      const artifact=snapshot('candidate/'+name,undefined,bytes);
      requireThat(artifact?.status==='available'&&artifact.id&&!evidence.artifactIds.includes(artifact.id),'snapshot_failed');
      evidence.artifactIds.push(artifact.id);
      return artifact.id;
    };
    const ids=new Map();
    for(const [name,bytes] of files)ids.set(name,store(name==='receipt'?'receipt.json':name+'.log',bytes));
    const later=new Map();
    for(const check of stages){
      later.set(check,gate);
      evidence.checks.push({check,status:'passed',stepId:gate.id,artifactId:ids.get(check)??ids.get('receipt')});
    }
    for(const {check,command} of regressions){
      const latest=steps.filter(step=>cmd(step)===command).at(-1);
      requireThat(latest?.status==='completed'&&latest.exitCode===0&&latest.candidatePatchSha256===patchSha256,'regression_missing_or_stale');
      const artifactId=store('regression-'+check+'.log',record(latest));
      later.set(check,latest);
      evidence.checks.push({check,status:'passed',stepId:latest.id,artifactId});
    }
    const covered=[];
    for(const step of steps.filter(s=>s.status==='failed'&&Number.isInteger(s.exitCode)&&s.exitCode>0)){
      const reproduction=reproductions.find(row=>row.command===cmd(step)&&row.exitCode===step.exitCode);
      const regression=regressions.find(row=>row.command===cmd(step));
      const previousGate=allowed.genuine.has(cmd(step))&&step.exitCode===1||allowed.wrongInterpreter.has(cmd(step))&&step.exitCode===2;
      const next=previousGate?gate:later.get(reproduction?.check??regression?.check);
      if(!next||step.finishedAt>next.createdAt||reproduction&&step.finishedAt>gate.createdAt)continue;
      // Missing evidence leaves this specific failure outstanding in the normal review path.
      let output;try{output=record(step);}catch{continue;}
      if(!reproduction||output.includes(Buffer.from(reproduction.outputIncludes)))covered.push(step.id);
    }
    evidence.coveredStepIds=covered;
    evidence.status='passed';
  }catch(error){
    evidence.reason=error.message?.startsWith('candidate_')?error.message:'candidate_evidence_unavailable';
  }
  return evidence;
}
