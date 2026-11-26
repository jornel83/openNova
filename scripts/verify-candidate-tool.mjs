// Launch the packaged candidate verifier from a real isolated Bot's foreground
// dispatch and employee task_command. The running candidate uses its configured
// chat provider. Only the dispatch, repair actions and reviewer are scripted.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {basename,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {provisionCandidateVerifier} from './candidate/install.mjs';
import {verifierCommand} from '../services/bot/team/candidate-profile.mjs';
import {lifecycleHost} from '../services/bot/tests/fixtures/lifecycle-host.mjs';

const root=realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const baseline='279ed040042e70c5cbc5ad601700cbcf00297d41';
const patchHash='c9b176b5749f19c60df48530bc65ff1da11ce1cbbb64a04a87bb29c3b77a37ed';
const regression={check:'tests',command:'node --test scripts/tests/project.test.mjs tools/voice/tests/launcher.test.mjs services/bot/tests/start-options.test.mjs'};
const reproduction={check:'coldStart',command:'node tools/voice/start.mjs --no-voice --no-ui',exitCode:1,outputIncludes:'不支持的参数 --no-voice'};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(cwd,...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trimEnd();

function keepAttemptLogs(profile,destination){
  if(!profile||!existsSync(profile.receiptRoot))return;
  // Fixed log names only. Never export candidate instance HOME, tokens or configuration.
  for(const attempt of readdirSync(profile.receiptRoot,{withFileTypes:true})){
    if(!attempt.isDirectory()||!/^[a-zA-Z0-9_-]+$/.test(attempt.name))continue;
    const dir=join(destination,attempt.name);mkdirSync(dir,{recursive:true,mode:0o700});
    for(const name of ['receipt.json','build.log','doctor.log','warmStart.log','worker.patch']){
      const src=join(profile.receiptRoot,attempt.name,name);
      if(existsSync(src))writeFileSync(join(dir,name),readFileSync(src),{mode:0o600});
    }
  }
}

async function verify(patch,output,signal){
  const cleanup=[],h=await lifecycleHost({after:fn=>cleanup.push(fn)},{provider:'candidate-tool-provider.mjs'});
  let profile,taskId;
  try{
    const source=realpathSync(h.workspace),home=realpathSync(h.home);
    assert.equal(hash(readFileSync(patch)),patchHash,'use the original historical fix');
    // The lifecycle helper owns this fresh fixture directory and seeds one sample.
    assert.deepEqual(readdirSync(source),['sample.txt']);rmSync(join(source,'sample.txt'));
    git(home,'clone','--shared','--no-checkout',root,source);git(source,'checkout','--detach',baseline);
    profile=await provisionCandidateVerifier({home,source,dependencyRoot:root,regressions:[regression],reproductions:[reproduction]});
    const health=await h.start(),employee=await h.employee('候选验证员'),id=randomUUID();
    const run=(command,timeoutMs)=>['task_command',{command,...(timeoutMs?{timeoutMs}:{})}];
    const plan=[run(reproduction.command),run('git apply -- '+verifierCommand(patch)),run(regression.command),run(verifierCommand(profile.command),600000)];
    const args={title:'验证无音频设备下的文字启动',goal:'在独立工作树复现故障、应用已知修复并验证最终候选。\nFS_ACCESS_PLAN='+Buffer.from(JSON.stringify(plan)).toString('base64'),
      constraints:'仅测试独立候选实例。',assignedBotId:employee.id,candidateReview:true,workspaceMode:'code',permission:'full',maxReworks:0,timeoutMs:900000};
    await h.api('/ask',{id,source:'text',text:'lifecycle:'+JSON.stringify({name:'background_agent_start',arguments:args})});
    await h.until(async()=>{
      const result=await h.api('/result',{id});if(result.status==='failed')throw Error('foreground_dispatch_failed');
      return result.status==='completed';
    });
    const created=await h.until(async()=>(await h.api('/background-tasks')).tasks.find(task=>task.requestId===id));
    taskId=created.id;assert.equal(created.source,'assistant');assert.equal(created.assignedBotId,employee.id);assert.notEqual(employee.id,health.botId);
    console.log('Dispatched candidate verification to '+taskId);
    let detail;
    const deadline=Date.now()+16*60_000;
    for(;;){
      signal.throwIfAborted();
      detail=await h.api('/background-task',{id:taskId});
      if(['accepted','needs_user','budget_exhausted','failed','stale'].includes(detail.teamReview?.currentReview?.status)||['failed','cancelled','interrupted'].includes(detail.task.status))break;
      if(Date.now()>deadline)throw Error('candidate_review_timed_out');
      await delay(750,undefined,{signal});
    }
    const {task,teamReview}=detail,report=teamReview.current,review=teamReview.currentReview,gate=report?.evidence?.candidateReview,steps=detail.runs[0].jobs;
    const commandTrace=steps.map(s=>({id:s.id,tool:s.tool,status:s.status,exitCode:s.exitCode}));
    assert.equal(task.status,'completed',JSON.stringify(commandTrace));
    assert.equal(gate?.status,'passed',JSON.stringify({reason:gate?.reason,commandTrace}));
    assert.equal(review?.status,'accepted',review?.decision?.summary||'no independent decision');
    assert.equal(gate.patchSha256,patchHash);assert.equal(gate.taskId,taskId);assert.equal(gate.runId,task.runId);
    assert.deepEqual(steps.map(s=>s.arguments?.command),plan.map(([,args])=>args.command));
    assert.deepEqual(steps.map(s=>s.exitCode),[1,0,0,0]);assert.deepEqual(gate.coveredStepIds,[steps[0].id]);
    const dest=join(output,'evidence');mkdirSync(dest,{mode:0o700});
    for(const item of report.artifacts.filter(a=>[gate.patchArtifactId,...gate.artifactIds].includes(a.id))){
      const bytes=readFileSync(item.path);assert.equal(hash(bytes),item.sha256);
      writeFileSync(join(dest,basename(item.name)),bytes,{mode:0o600});
    }
    const receipt=JSON.parse(readFileSync(join(dest,'receipt.json')));
    assert.match(receipt.attempt,/^[a-zA-Z0-9_-]+$/);
    const archivedBytes={};
    for(const name of ['receipt.json','build.log','doctor.log','warmStart.log']){
      const saved=readFileSync(join(dest,name)),actual=readFileSync(join(profile.receiptRoot,receipt.attempt,name));
      assert.ok(saved.equals(actual),'candidate evidence changed or truncated: '+name);
      archivedBytes[name]=saved.length;
    }
    assert.match(readFileSync(join(dest,'regression-tests.log'),'utf8'),/pass 33\b/);
    assert.equal(receipt.chat.status,'completed');assert.equal(receipt.chat.text,receipt.chat.expected);
    assert.equal(receipt.snapshot.workerPatchSha256,patchHash);assert.equal(receipt.bothPortsClosed,true);
    assert.equal(receipt.oldDefault.entry,'start.command');assert.ok([1,72].includes(receipt.oldDefault.exitCode));
    assert.deepEqual(receipt.oldDefault.calls.map(call=>[call.entry,call.injectedExitCode]),[['run-continuous.command',72]]);
    const chief=await h.api('/background-task',{id:review.managementTaskId});
    assert.equal(chief.task.permission,'read-only');assert.equal(chief.task.assignedBotId,health.botId);
    const jobs=chief.runs[0].jobs;
    assert.ok(jobs.some(s=>s.tool==='review_decide'&&s.status==='completed'));
    assert.ok(jobs.some(s=>s.tool==='read'&&s.output?.includes(receipt.chat.expected)&&s.output?.includes('bothPortsClosed')));
    assert.equal(git(source,'rev-parse','HEAD'),baseline);assert.equal(git(source,'status','--porcelain'),'');
    return {passed:true,baseCommit:baseline,patchSha256:patchHash,requestId:id,taskId,runId:task.runId,reportId:report.id,reviewId:review.id,
      verifiedPatch:gate.patchSha256,requiredChecks:gate.requiredChecks,checks:gate.checks,reviewStatus:review.status,commandTrace,
      reviewerTools:jobs.map(s=>s.tool),regressionPass:33,archivedBytes,receipt:'evidence/receipt.json',
      provenance:{foreground:'Deterministic dispatch over the isolated Bot /ask endpoint.',employee:'Deterministic Harness plan re-applied the archived fix; all shell commands ran afresh.',
        reviewer:'Deterministic reviewer through real read-only Harness and supervisor.',candidate:'Fresh isolated build, startup and HTTP text request using the configured candidate provider.'}};
  }catch(error){
    if(taskId&&signal.aborted){
      try{
        const {task}=await h.api('/background-task',{id:taskId});
        if(['running','queued'].includes(task.status))await h.api('/background-task-cancel',{id:taskId,runId:task.runId});
      }catch{}
    }
    keepAttemptLogs(profile,join(output,'attempts'));
    if(taskId){
      try{
        const d=await h.api('/background-task',{id:taskId});
        const run=d.runs[0],diagnostic={status:d.task.status,review:d.teamReview?.currentReview?.status,
          candidate:d.teamReview?.current?.evidence?.candidateReview,steps:run.jobs.map(s=>({tool:s.tool,status:s.status,exitCode:s.exitCode,output:s.output?.slice(-1300)}))};
        const childId=d.teamReview?.currentReview?.managementTaskId;
        if(childId){
          const child=await h.api('/background-task',{id:childId});
          diagnostic.reviewer={status:child.task.status,error:child.task.error,tools:child.runs[0].jobs.map(s=>({tool:s.tool,status:s.status,error:s.error}))};
        }
        writeFileSync(join(output,'diagnostic.json'),JSON.stringify(diagnostic,null,2),{mode:0o600});
      }catch{}
    }
    throw error;
  }finally{for(const close of cleanup.reverse())await close();}
}

if(process.argv.length!==3)throw Error('Usage: node scripts/verify-candidate-tool.mjs <archived-chat-replay-directory>');
const patch=realpathSync(join(process.argv[2],'nova.patch'));
const output=join(root,'output','verification','candidate-tool',randomUUID());
mkdirSync(output,{recursive:true,mode:0o700});console.log('Verification output: '+output);
const abort=new AbortController(),stop=()=>abort.abort();
process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{
  const result=await verify(patch,output,abort.signal);writeFileSync(join(output,'report.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({passed:true,report:join(output,'report.json')}));
}catch(error){console.error(error.message);process.exitCode=1;}
finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
