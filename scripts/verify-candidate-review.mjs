/** Replay the recorded chat/text-only candidate through the current host's formal review.
 * Usage: node scripts/verify-candidate-review.mjs <path-to-archived-chat-replay>
 * The historical candidate service and model are not started by this verifier.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Operations} from '../services/bot/operations.mjs';
import {TaskManager} from '../services/bot/tasks/manager.mjs';
import {prepareWorkspace} from '../services/bot/tasks/workspace.mjs';
import {readJson,saveJson} from '../services/bot/tasks/agent-files.mjs';
import {TeamSupervisor} from '../services/bot/team/supervisor.mjs';
import {TeamOutbox} from '../services/bot/team/outbox.mjs';
import {ManagementDelivery} from '../services/bot/team/delivery.mjs';
import {normalizeReviewDecision,prepareReviewEvidence,prepareReviewWorkspace,reviewEvidenceIds} from '../services/bot/team/review.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const provider=fileURLToPath(new URL('../services/bot/tests/fixtures/filesystem-provider.mjs',import.meta.url));
const baseCommit='279ed040042e70c5cbc5ad601700cbcf00297d41';
const patchSha256='c9b176b5749f19c60df48530bc65ff1da11ce1cbbb64a04a87bb29c3b77a37ed';
const tests=['scripts/tests/project.test.mjs','tools/voice/tests/launcher.test.mjs','services/bot/tests/start-options.test.mjs'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const bytes=path=>readFileSync(path);
const repro=[
  {command:'./start.command --no-voice --no-ui',argv:['./start.command','--no-voice','--no-ui'],check:'build',exitCode:1,outputIncludes:'build_missing_or_stale'},
  {command:'node tools/voice/start.mjs --no-voice --no-ui',argv:[process.execPath,'tools/voice/start.mjs','--no-voice','--no-ui'],check:'coldStart',exitCode:1,outputIncludes:'不支持的参数 --no-voice'},
];
const regression={check:'tests',command:['node','--test',...tests].join(' ')};
function execute(cwd,command,args,env={},expected=0) {
  const r=spawnSync(command,args,{cwd,env:{...process.env,...env},encoding:'utf8',timeout:120_000,maxBuffer:16*1024*1024});
  const output=(r.stdout??'')+(r.stderr??'');
  assert.equal(r.status,expected,`${command} ${args.join(' ')}: ${r.error??output.slice(-2500)}`);
  return output;
}
const git=(cwd,...args)=>execute(cwd,'git',['-c','core.hooksPath=/dev/null',...args]);
function archived(directory) {
  const load=name=>JSON.parse(bytes(join(directory,name)));
  const dispatch=load('dispatch.json'),receipt=load('candidate-receipt.json'),first=load('first-candidate.json'),request=load('request.json'),previousReview=load('review.json');
  const [run]=dispatch.runs;
  const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
  assert.match(run.runId,uuid);assert.match(run.jobId,uuid);assert.match(dispatch.taskId,/^[0-9a-f]{64}$/);
  assert.match(receipt.attempt,/^[0-9a-f]{32}$/);assert.equal(dispatch.passed,true);
  assert.equal(dispatch.requestId,request.id);
  assert.equal(dispatch.requestTextSha256,hash(request.text));
  assert.equal(dispatch.baseCommit,baseCommit);
  assert.equal(receipt.base,baseCommit);
  assert.equal(receipt.snapshot.worktree,dispatch.workerWorkspace);
  assert.equal(dispatch.patchSha256,patchSha256);
  assert.equal(receipt.snapshot.workerPatchSha256,patchSha256);
  assert.equal(hash(bytes(join(directory,'nova.patch'))),patchSha256);
  assert.equal(receipt.chat.text,receipt.chat.expected);
  assert.equal(first.passed,false);
  assert.match(first.error,/warmStart exited 1/);
  assert.equal(previousReview.status,'needs_user');
  const calls=dispatch.candidateGateCalls;
  assert.equal(calls.length,3);
  for(const c of calls){
    assert.match(c.stepId,uuid);
    assert.equal(c.runId,run.runId);
    assert.equal(c.cleanupConfirmed,true);
    assert.equal(c.exitCode,c.toolExitCode);
    assert.match(c.outputSha256,/^[a-f0-9]{64}$/);
  }
  const final=calls.find(c=>c.exitCode===0);
  assert.equal(final.status,'completed');
  assert.equal(final.testedPatchSha256,patchSha256);
  assert.equal(final.candidateRuntimeId,receipt.runtimeId);
  assert.equal(final.candidateReplyVerified,true);
  assert.equal(final.candidateReceipt,'accept/'+receipt.attempt+'/receipt.json');
  assert.deepEqual(calls.map(c=>c.exitCode).sort(),[0,1,2]);
  assert.ok(calls.filter(c=>c.exitCode!==0).every(c=>c.status==='failed'));
  assert.match(bytes(join(directory,'regression.log')).toString(),/pass 33/);
  return {directory,dispatch,receipt,first,request,previousReview,run,calls,final};
}
function step(directory,taskId,runId,{id=randomUUID(),command,output,exitCode=0,createdAt,candidatePatchSha256}){
  const status=exitCode===0?'completed':'failed',data=Buffer.from(output),finishedAt=createdAt+5;
  const where=join(directory,'commands',id),result={jobId:id,runId,status,exitCode,cleanupConfirmed:true,bytes:data.length,finishedAt,truncated:false};
  saveJson(join(where,'intent.json'),{jobId:id,runId});
  writeFileSync(join(where,'output.log'),data);
  saveJson(join(where,'result.json'),result);
  saveJson(join(directory,'steps',id+'.json'),{id,taskId,runId,tool:'task_command',status,exitCode,cleanupConfirmed:true,arguments:{command,workdir:'.'},output:data.toString().slice(0,16000),createdAt,finishedAt,...candidatePatchSha256?{candidatePatchSha256}:{}});
  return id;
}
function cited(report){
  const evidence=report.evidence.candidateReview;
  return [...new Set([evidence?.stepId,evidence?.patchArtifactId,...(evidence?.artifactIds??[])].filter(Boolean))];
}
function reviewDecision(report){
  const available=new Set(reviewEvidenceIds(report)),ids=cited(report).filter(id=>available.has(id));
  return {action:'accept',summary:'只读回放中核对候选回执、补丁和阶段日志。',evidenceIds:ids.length?ids:[report.artifacts[0]?.id??'report:summary']};
}

// Reserve the historical throwaway name only when it is absent. Keeping the same
// physical paths lets macOS replay the original receipt byte-for-byte.
function scratchRoot(receipt){
  const requested=dirname(receipt.snapshot.source);
  if(process.platform==='darwin'&&dirname(requested)===realpathSync('/tmp')&&/^nova-chat-replay-[a-z0-9]{8}$/.test(basename(requested))){
    try{mkdirSync(requested,{mode:0o700});return requested;}
    catch(error){if(error.code!=='EEXIST')throw error;}
  }
  return realpathSync(mkdtempSync(join(tmpdir(),'opennova-candidate-review-')));
}
async function verify(directory){
  const a=archived(directory),home=scratchRoot(a.receipt);
  const source=join(home,'source'),host=join(home,'host'),receiptRoot=join(home,'evidence','accept'),command=join(home,'lab','accept');
  let tasks,ops;
  try{
    git(home,'clone','--shared','--no-checkout',root,source);
    git(source,'checkout','--detach',baseCommit);
    assert.equal(git(source,'rev-parse','HEAD^{tree}').trim(),a.receipt.snapshot.baseTree);
    mkdirSync(dirname(command),{recursive:true});
    writeFileSync(command,'#!/bin/sh\nexit 86\n',{mode:0o700}); // Replay never executes an archived path or starts a candidate.
    const config={version:1,kind:'text-only-start',source,command,receiptRoot,
      reproductions:repro.map(({argv,...observation})=>observation),regressions:[regression]};
    ops=new Operations({home:host,workspace:source});
    tasks=new TaskManager({ops,home:host,workspace:source,agentProviderModule:provider});
    tasks.team={chiefId:a.dispatch.chiefId,assignment:input=>({assignedBotId:input.assignedBotId??a.dispatch.chiefId,supervisorBotId:a.dispatch.chiefId,reportTo:a.dispatch.chiefId,assignmentVersion:1}),
      snapshot:task=>({botId:task.assignedBotId,name:task.assignedBotId,role:task.assignedBotId===a.dispatch.chiefId?'总管':'研发验证员'}),owner:task=>({ownerName:task.assignedBotId})};
    const workspace=await prepareWorkspace({source,home:tasks.agentHome({id:a.dispatch.taskId,assignmentVersion:1}),taskId:a.dispatch.taskId,mode:'edit'});
    const isolatedEnv={OPENNOVA_BOT_HOME:join(home,'probe-bot'),OPENNOVA_NODE:process.execPath,OPENNOVA_CONFIG:join(home,'probe-config.json'),OPENNOVA_SECRETS_FILE:join(home,'probe-secrets.json')};
    const oldLogs=repro.map(r=>execute(workspace.path,r.argv[0],r.argv.slice(1),isolatedEnv,r.exitCode));
    oldLogs.forEach((log,i)=>assert.ok(log.includes(repro[i].outputIncludes)));
    git(workspace.path,'apply',join(directory,'nova.patch'));
    const diff=git(workspace.path,'diff','--binary','--full-index','--no-renames','--no-ext-diff',workspace.base,'--','.');
    assert.equal(hash(diff),patchSha256);
    const indexEnv={GIT_INDEX_FILE:join(home,'verify-tree.index')};
    const indexGit=(...args)=>execute(workspace.path,'git',['-c','core.hooksPath=/dev/null',...args],indexEnv);
    indexGit('read-tree',workspace.base);indexGit('add','-A','--','.');
    assert.equal(indexGit('write-tree').trim(),a.receipt.snapshot.workerTree);
    assert.deepEqual(git(workspace.path,'diff','--name-only',workspace.base).trim().split('\n').sort(),a.dispatch.changedFiles.toSorted());
    assert.deepEqual(Object.keys(a.receipt.snapshot.files).sort(),a.dispatch.changedFiles.toSorted());
    for(const [file,digest] of Object.entries(a.receipt.snapshot.files))assert.equal(hash(bytes(join(workspace.path,file))),digest,file);
    const regressionOutput=execute(workspace.path,process.execPath,['--test',...tests],isolatedEnv);
    assert.match(regressionOutput,/pass 33/);
    const samePaths=source===a.receipt.snapshot.source&&workspace.path===a.receipt.snapshot.worktree&&join(home,'candidate')===a.receipt.snapshot.candidate;
    let runNumber=0;const cases=[],metadata={};
    mkdirSync(receiptRoot,{recursive:true});
    saveJson(join(host,'candidate-review.json'),config);
    tasks.create({id:a.dispatch.taskId,kind:'agent',title:'仅文字启动验收回放',goal:a.request.text,assignedBotId:a.dispatch.assignedEmployeeId,
      workspaceMode:'code',permission:'full',managementEnabled:true,candidateReview:true,timeoutMs:60000},{requestId:a.request.id,source:'assistant'});
    const baseTask=tasks.row('task',a.dispatch.taskId);
    assert.equal(baseTask.candidateReview.command,command);
    // Replace the empty queued run with the historical worker's ID and persisted observations.
    const emptyRun=tasks.row('run',baseTask.runId);
    ops.db.prepare('DELETE FROM background_job WHERE id=?').run(emptyRun.jobId);
    ops.db.prepare('DELETE FROM background_run WHERE id=?').run(emptyRun.id);

    function reportFor(scenario){
      const index=++runNumber,id=index===1?a.run.runId:randomUUID(),jobId=index===1?a.run.jobId:randomUUID();
      const task={...baseTask,runId:id,status:'running'},run={id,number:index,taskId:task.id,jobId,assignmentVersion:1,employee:{botId:task.assignedBotId},status:'running',createdAt:Date.now(),startedAt:Date.now()};
      const job={id:jobId,runId:id,taskId:task.id,kind:'agent',status:'running'},jobDir=tasks.directory(job);
      tasks.put('task',task);tasks.put('run',run);tasks.put('job',job);
      const receipt=structuredClone(a.receipt),attemptDir=join(receiptRoot,receipt.attempt);
      receipt.snapshot.source=source;receipt.snapshot.worktree=workspace.path;
      receipt.snapshot.candidate=join(home,'candidate');receipt.healthWorkspace=receipt.snapshot.candidate;
      if(scenario==='missingStage')delete receipt.warmStart;
      mkdirSync(attemptDir,{recursive:true});
      const receiptFile=join(attemptDir,'receipt.json');
      for(const [archivedName,name] of [['build.log','build.log'],['doctor.log','doctor.log'],['warm-start.log','warmStart.log'],['nova.patch','worker.patch']])
        copyFileSync(join(directory,archivedName),join(attemptDir,name));
      if(samePaths&&scenario!=='missingStage')writeFileSync(receiptFile,bytes(join(directory,'candidate-receipt.json')));
      else writeFileSync(receiptFile,JSON.stringify(receipt,null,2)+'\n');
      const now=Math.floor(statSync(receiptFile).mtimeMs);
      for(const [i,r] of repro.entries())step(jobDir,task.id,id,{command:r.command,output:oldLogs[i],exitCode:r.exitCode,createdAt:now-70+i*10});
      for(const [i,code] of [2,1].entries()){
        const historical=a.calls.find(c=>c.exitCode===code);
        step(jobDir,task.id,id,{id:historical.stepId,command:code===2?'bash '+command:command,exitCode:code,output:code===1?a.first.error+'\n':'Archived gate failed with exit 2. Original output was not retained.\n',createdAt:now-50+i*10});
      }
      step(jobDir,task.id,id,{command:regression.command,output:regressionOutput,candidatePatchSha256:patchSha256,createdAt:now-20});
      const marker={passed:true,receipt:receiptFile,runtimeId:receipt.runtimeId,candidateReply:receipt.chat.text,patchSha256,bothPortsClosed:true};
      const gateId=step(jobDir,task.id,id,{id:a.final.stepId,command,output:JSON.stringify(marker)+'\n',createdAt:now-1});
      if(scenario==='lastGateFailed')step(jobDir,task.id,id,{command,exitCode:1,output:'Replay negative control: final gate failed.\n',createdAt:now+10});
      if(scenario==='unrelatedFailure')step(jobDir,task.id,id,{command:'node unrelated-check.mjs',exitCode:1,output:'Replay negative control: independent check failed.\n',createdAt:now+10});
      saveJson(join(jobDir,'agent-result.json'),{taskId:task.id,runId:id,status:'completed',text:'已归档候选回放。'});
      tasks.finish(task,run,job,{status:'completed',exitCode:0,cleanupConfirmed:true,finishedAt:Date.now()+25});
      const report=tasks.reports.current(task);
      assert.ok(report);
      return {task:tasks.row('task',task.id),report,gateId,receiptFile,jobDir};
    }

    const first=reportFor('complete'),report=first.report,proof=report.evidence.candidateReview;
    assert.equal(proof?.status,'passed',JSON.stringify(proof??{error:'candidate_review_missing'}));
    assert.equal(proof.stepId,first.gateId);
    assert.equal(proof.patchSha256,patchSha256);
    assert.equal(proof.coveredStepIds.length,4,'two old probes and both failed gate attempts');
    const fileDigests=['build.log','doctor.log','warm-start.log','nova.patch'].map(name=>[name,hash(bytes(join(directory,name)))]);
    fileDigests.push(['receipt.json',hash(bytes(first.receiptFile))]);
    if(samePaths)assert.equal(hash(bytes(first.receiptFile)),hash(bytes(join(directory,'candidate-receipt.json'))));
    const delivery=new ManagementDelivery({home:host,chiefId:a.dispatch.chiefId});
    tasks.outbox=new TeamOutbox({db:ops.db,delivery});
    const supervisor=new TeamSupervisor({tasks,reports:tasks.reports,createManagementTask:({id,budgets,managementReview})=>{
      const payload=readJson(join(managementReview.evidenceDirectory,'report.json')),decision=reviewDecision(payload);
      const actions=[['read',{file_path:'report.json'}],...payload.artifacts.filter(file=>decision.evidenceIds.includes(file.id)).map(file=>['read',{file_path:file.path,...file.name==='candidate/build.log'?{limit:20}:{}}]),['review_decide',decision]];
      const goal='FS_ACCESS_PLAN='+Buffer.from(JSON.stringify(actions)).toString('base64');
      tasks.create({id,kind:'agent',title:'独立只读验收',goal,workspaceMode:'general',assignedBotId:a.dispatch.chiefId,permission:'read-only',managementEnabled:false,...budgets},
        {source:'supervisor',managementReview});
    }});
    tasks.supervisor=supervisor;
    await tasks.outbox.tick();supervisor.tick();
    let review;
    const deadline=Date.now()+90000;
    while(Date.now()<deadline){
      review=supervisor.history(first.task.id).find(r=>['accepted','needs_user','failed','stale','budget_exhausted'].includes(r.status));
      if(review)break;
      await delay(100);
    }
    const child=review?.managementTaskId&&tasks.detail(review.managementTaskId);
    assert.equal(review?.status,'accepted',JSON.stringify({review,error:tasks.lastError,child:child?.runs[0]?.jobs?.map(s=>[s.tool,s.error,s.status,s.status==='failed'?s.output:undefined]),log:child&&tasks.log({id:child.task.id}).text.slice(-1800)}));
    assert.equal(review.source,'supervisor');assert.equal(supervisor.isAccepted(report),true);
    assert.equal(child.task.permission,'read-only');
    const jobs=child.runs[0].jobs;
    assert.ok(jobs.every(s=>s.status==='completed'));
    assert.ok(jobs.some(s=>s.tool==='review_decide'));
    const managementHome=tasks.agentHome(child.task);
    const reviewWorkspace=prepareReviewWorkspace({home:managementHome,managementReview:review.managementReview});
    const payload=readJson(join(reviewWorkspace.path,'report.json')),manifest=readJson(join(review.managementReview.evidenceDirectory,'review-input.json'));
    for(const [name,digest] of fileDigests){
      const file=manifest.files.find(file=>file.sha256===digest);
      assert.ok(file,'missing full bytes in frozen review: '+name);
      assert.equal(hash(bytes(join(reviewWorkspace.path,file.path))),digest);
      metadata[name]={sha256:digest,bytes:bytes(join(reviewWorkspace.path,file.path)).length};
    }
    const receiptArtifact=payload.artifacts.find(file=>file.name==='candidate/receipt.json');
    const readReceipt=jobs.find(s=>s.tool==='read'&&s.arguments.file_path===receiptArtifact.path);
    assert.ok(readReceipt.output.includes(a.receipt.chat.expected)&&readReceipt.output.includes('bothPortsClosed'),'actual read tool must expose echo and cleanup from complete receipt');
    normalizeReviewDecision(reviewDecision(payload),payload);
    cases.push({name:'complete',reviewStatus:review.status,source:review.source,toolTrace:jobs.map(s=>s.tool),reportId:report.id,reviewId:review.id,coveredStepIds:proof.coveredStepIds});
    tasks.supervisor=undefined; // The following forced negative decisions are checked synchronously against new reports.
    const extraFile=join(workspace.path,'candidate-review-unverified.txt');
    writeFileSync(extraFile,'Previously untracked after the successful review.\n');
    try{
      assert.throws(()=>tasks.reports.assertCurrent(first.task,report.id),/changed|stale|patch|candidate/);
      assert.equal(supervisor.isAccepted(report),false);
      cases.push({name:'newFileAfterReport',status:'blocked'});
    }finally{rmSync(extraFile);}
    for(const scenario of ['missingStage','lastGateFailed','candidateChanged','unrelatedFailure']){
      if(scenario==='candidateChanged')writeFileSync(extraFile,'Unverified content before report capture.\n');
      try{
        const {task,report:bad}=reportFor(scenario),where=join(home,'negative',scenario);
        let blocked;
        try{
          prepareReviewEvidence({report:bad,task,directory:where});
          const binding={reviewId:'negative-'+scenario,reportId:bad.id,targetTaskId:task.id,targetRunId:task.runId,assignmentVersion:1,evidenceDirectory:where};
          const dest=prepareReviewWorkspace({home:join(home,'negative-review',scenario),managementReview:binding});
          const input=readJson(join(dest.path,'report.json')),attempt=reviewDecision(input);
          normalizeReviewDecision(attempt,input);
          supervisor.apply({id:binding.reviewId,reportId:bad.id,taskId:task.id,runId:task.runId,assignmentVersion:1,source:'supervisor'},attempt);
        }catch(error){blocked=error.message;}
        assert.ok(blocked&&/candidate|verification|report_not_ready|artifact_changed/.test(blocked),'unexpected decision for '+scenario+': '+blocked);
        const expected={missingStage:'candidate_launch_incomplete',lastGateFailed:'candidate_final_command_failed',candidateChanged:'candidate_patch_mismatch',unrelatedFailure:'review_verification_incomplete'}[scenario];
        assert.equal(scenario==='unrelatedFailure'?blocked:bad.evidence.candidateReview.reason,expected);
        assert.equal(supervisor.isAccepted(bad),false);
        cases.push({name:scenario,status:'blocked',reason:blocked,candidateStatus:bad.evidence.candidateReview?.status,candidateReason:bad.evidence.candidateReview?.reason});
      }finally{if(scenario==='candidateChanged')rmSync(extraFile);}
    }
    return {schema:1,passed:true,archived:{taskId:a.dispatch.taskId,runId:a.run.runId,previousReview:a.previousReview.status,baseCommit,patchSha256,workerTree:a.receipt.snapshot.workerTree,
      originalReceiptSha256:hash(bytes(join(directory,'candidate-receipt.json'))),candidateRuntimeId:a.receipt.runtimeId,chatEcho:a.receipt.chat.text,
      gateObservations:a.calls.map(c=>({stepId:c.stepId,exitCode:c.exitCode,cleanupConfirmed:c.cleanupConfirmed,archivedOutputSha256:c.outputSha256}))},
      replay:{originalReceiptByteIdentical:samePaths,oldProbeExitCodes:repro.map(r=>r.exitCode),regressionPass:33,readonlyFiles:metadata,cases,
        provenance:['Archived dispatch, candidate receipt, intermediate failure, original binary patch and stage logs were read from supplied archive.',
          'Historical Git baseline checked out and real old probes and 33 patched regression tests rerun in an isolated clone.',
          samePaths?'The historical temporary path was reserved exclusively. The original successful receipt and all archived stage logs and patch bytes used in review remained identical.':'Successful receipt relocated only snapshot.source, snapshot.worktree, snapshot.candidate and healthWorkspace. Build, doctor, warm-start and patch files retained byte-for-byte.',
          'The archive retains historical gate step IDs, exit codes, cleanup status and stdout hashes, not the full original job directory or gate stdout. Task/run/command files, timestamps and gate stdout were reconstructed. Their reconstructed stdout is not represented as the archived hash preimage.',
          'Actual TaskManager completion, outbox delivery, report capture, read-only Harness tools and supervisor persistence ran locally. The reviewer used the deterministic filesystem test provider. Build, service startup and model echo are archived observations; this verifier did not launch a new candidate.']}};
  }finally{try{await tasks?.close();}finally{ops?.close();rmSync(home,{recursive:true,force:true});}}
}
if(process.argv.length!==3)throw Error('Usage: node scripts/verify-candidate-review.mjs <archived-chat-replay-directory>');
const result=await verify(realpathSync(resolve(process.argv[2])));
const output=join(root,'output','verification','candidate-review',randomUUID(),'report.json');
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({passed:true,report:output,cases:result.replay.cases.map(c=>c.name)}));
