// Executed by the host-pinned wrapper in an actual employee assignment worktree.
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,isAbsolute} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {candidatePatchDigest} from '../../services/bot/team/candidate-patch.mjs';
import {prepareCandidate,buildCandidate} from './workspace.mjs';
import {probeTextStart} from './text-start.mjs';
import {runLogged} from './process.mjs';

export function assignedWorkspace(settings,cwd){
  const worktree=realpathSync(cwd),assignment=dirname(worktree);
  if(basename(worktree)!=='workspace'||dirname(assignment)!==join(settings.home,'tasks','agents')||!/^[a-f0-9]{64}$/.test(basename(assignment)))throw Error('candidate_assignment_required');
  const path=join(assignment,'workspace.json');
  if(realpathSync(path)!==path||!lstatSync(path).isFile())throw Error('candidate_workspace_binding_invalid');
  const workspace=JSON.parse(readFileSync(path,'utf8'));
  if(workspace.path!==worktree||workspace.source!==settings.source||workspace.mode!=='edit')throw Error('candidate_workspace_binding_invalid');
  return workspace;
}

function buildEnvironment(scratch){
  const home=join(scratch,'home'),temp=join(scratch,'tmp');
  for(const path of [home,temp])mkdirSync(path,{mode:0o700});
  return {PATH:[dirname(process.execPath),...(process.env.PATH||'').split(':').filter(isAbsolute)].join(':'),
    HOME:home,TMPDIR:temp,LANG:process.env.LANG||'en_US.UTF-8',CI:'1',
    COREPACK_HOME:process.env.COREPACK_HOME||join(homedir(),'.cache/node/corepack'),COREPACK_ENABLE_DOWNLOAD_PROMPT:'0',
    pnpm_config_verify_deps_before_run:'false',OPENNOVA_NODE:process.execPath,
    OPENNOVA_PYTHON:process.env.OPENNOVA_PYTHON||'python3.11',
    OPENNOVA_BOT_HOME:join(home,'build-bot'),OPENNOVA_CONFIG:join(home,'voice.local.json'),OPENNOVA_SECRETS_FILE:join(home,'secrets.local.json')};
}

export async function verifyCandidate(settings,{cwd=process.cwd(),signal}={}){
  if(realpathSync(settings.receiptRoot)!==settings.receiptRoot)throw Error('candidate_receipt_root_invalid');
  const workspace=assignedWorkspace(settings,cwd),attempt=randomUUID(),attemptDir=join(settings.receiptRoot,attempt);
  mkdirSync(attemptDir,{mode:0o700});
  const receiptPath=join(attemptDir,'receipt.json'),receipt={attempt,base:workspace.sourceHead,passed:false};
  let scratch,stage='prepare';
  try{
    signal?.throwIfAborted();
    // tsx and the SDK use Unix domain sockets under TMPDIR. Darwin's per-user
    // temporary path can already consume most of sockaddr_un.sun_path.
    const tempRoot=realpathSync(process.platform==='darwin'?'/tmp':tmpdir());
    scratch=realpathSync(mkdtempSync(join(tempRoot,'nova-cand-')));
    const candidate=join(scratch,'candidate'),runtimeDir=join(scratch,'runtime'),env=buildEnvironment(scratch);
    mkdirSync(runtimeDir,{mode:0o700});
    receipt.snapshot=await prepareCandidate({workspace,candidate,attemptDir,dependencySource:settings.dependencyRoot,signal});
    stage='build';
    await buildCandidate({candidate,attemptDir,env,signal,receipt,run:runLogged});
    const expected=receipt.snapshot.workerPatchSha256;
    if(candidatePatchDigest({path:candidate,base:workspace.base})!==expected)throw Error('candidate_changed_during_build');
    stage='text-start';
    // The build receives no account configuration. Only the isolated conversation
    // uses the host's existing SIWC session via the normal OpenNova provider.
    const probeEnv={...env,OPENNOVA_SIWC_STORAGE:settings.accountStorage};
    if(receipt.snapshot.keychainHelper?.mode==='verified-installed-copy'){
      const helper=join(candidate,'output/bin/siwc-keychain');
      if(realpathSync(helper)!==helper||!lstatSync(helper).isFile()||
        createHash('sha256').update(readFileSync(helper)).digest('hex')!==receipt.snapshot.keychainHelper.binarySha256)throw Error('candidate_account_helper_changed_during_build');
      probeEnv.OPENNOVA_PROBE_ACCOUNT_HELPER=helper;
      probeEnv.OPENNOVA_PROBE_ACCOUNT_HOME=homedir();
    }
    await probeTextStart({candidate,attemptDir,runtimeDir,env:probeEnv,signal,receipt});
    signal?.throwIfAborted();
    stage='finalize';
    if(receipt.bothPortsClosed!==true||!receipt.chat?.expected||receipt.chat.text!==receipt.chat.expected)throw Error('candidate_verification_incomplete');
    if(candidatePatchDigest(workspace)!==expected||candidatePatchDigest({path:candidate,base:workspace.base})!==expected)throw Error('candidate_patch_changed_during_verification');
    receipt.passed=true;
  }catch(error){
    receipt.failure={stage:stage==='build'&&receipt.doctor?'doctor':stage,reason:String(error.message||error).slice(0,500)};
  }finally{
    // Retain the private runtime only if cleanup requires examination.
    if(scratch){
      try{
        if(receipt.bothPortsClosed===false||receipt.failure?.reason.includes('cleanup_unconfirmed'))receipt.recoveryDirectory=scratch;
        else rmSync(scratch,{recursive:true,force:true,maxRetries:3,retryDelay:100});
      }catch{receipt.passed=false;receipt.failure={stage:'cleanup',reason:'candidate_scratch_cleanup_failed'};receipt.recoveryDirectory=scratch;}
    }
    if(signal?.aborted){receipt.passed=false;receipt.failure??={stage,reason:'candidate_interrupted'};}
    writeFileSync(receiptPath+'.tmp',JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});
    renameSync(receiptPath+'.tmp',receiptPath);
  }
  return {passed:receipt.passed,receipt:receiptPath,runtimeId:receipt.runtimeId,candidateReply:receipt.chat?.text,patchSha256:receipt.snapshot?.workerPatchSha256,bothPortsClosed:receipt.bothPortsClosed,...(receipt.failure?{failure:receipt.failure}:{})};
}

if(process.argv[1]===import.meta.filename){
  const controller=new AbortController(),stop=()=>controller.abort();
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try{
    if(process.argv.length!==2)throw Error('candidate_verifier_takes_no_arguments');
    const settingsPath=new URL('../../settings.json',import.meta.url);
    if(!existsSync(settingsPath))throw Error('candidate_verifier_requires_host_installation');
    const marker=await verifyCandidate(JSON.parse(readFileSync(settingsPath,'utf8')),{signal:controller.signal});
    console.log(JSON.stringify(marker));if(!marker.passed)process.exitCode=1;
  }catch(error){console.error(error.message);process.exitCode=1;}
  finally{process.off('SIGTERM',stop);process.off('SIGINT',stop);}
}
