// Build from the assigned starting commit and the employee's actual patch. Only
// installed modules are reused. Generated outputs, private configuration and Git
// object stores never come from the running Nova instance.
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {accessSync,closeSync,constants,existsSync,fstatSync,lstatSync,mkdirSync,openSync,readdirSync,readFileSync,readlinkSync,realpathSync,writeFileSync} from 'node:fs';
import {cp} from 'node:fs/promises';
import {dirname,join,relative,resolve,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {candidatePatch,candidatePatchDigest} from '../../services/bot/team/candidate-patch.mjs';

const exec=promisify(execFile);
const installs=['engine/harness','engine/siwc','engine/bot/ds-bot','services/bot/desktop','.'];
const lockNames=['pnpm-lock.yaml','package-lock.json','pnpm-workspace.yaml','.npmrc'];
const dependencyKeys=['dependencies','devDependencies','peerDependencies','optionalDependencies','bundledDependencies','overrides','resolutions','packageManager','workspaces','pnpm'];
const noAudio=fileURLToPath(new URL('./no-audio.cjs',import.meta.url));
const below=(root,path)=>{const rel=relative(root,path);return rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel);};

async function git(cwd,args,signal){
  // Do not let ambient GIT_DIR, index, alternates or checkout filters redirect writes.
  const env={PATH:process.env.PATH,LC_ALL:'C',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
  const {stdout}=await exec('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd,env,signal,timeout:120000,maxBuffer:24*1024*1024});
  return stdout;
}

function checkLink(root,path){
  const target=readlinkSync(path);
  if(isAbsolute(target)||!below(root,resolve(dirname(path),target)))throw Error('candidate_external_link: '+relative(root,path));
}

function dependencyManifest(path){
  const pkg=JSON.parse(readFileSync(path,'utf8'));
  return JSON.stringify(Object.fromEntries(dependencyKeys.filter(k=>pkg[k]!==undefined).map(k=>[k,pkg[k]])));
}

function relocateShim(file,install){
  // pnpm's Unix launchers execute a relative binary but put the original store's
  // absolute location in NODE_PATH. Keep resolution in the candidate even if the
  // installed modules themselves had been moved between checkouts.
  if(lstatSync(file).size>128*1024)return;
  const original=readFileSync(file,'utf8');
  if(!original.startsWith('#!'))return;
  let changed=original;
  if(original.includes('export NODE_PATH=')){
    const line=original.match(/^\s*export NODE_PATH="([^"\n]*?)\/node_modules\/\.pnpm\//m);
    if(line&&isAbsolute(line[1])&&original.includes('basedir=')){
      const local='$basedir/'+(relative(dirname(file),install)||'.')+'/node_modules/';
      const source=line[1]+'/node_modules/';
      changed=changed.split('\n').map(line=>line.trimStart().startsWith('export NODE_PATH=')?line.replaceAll(source,()=>local):line).join('\n');
    }
  }
  if(/^# cmd-shim-target=\//m.test(changed)){
    const target=changed.match(/"\$basedir_abs\/([^"\n$]+)"\s+"\$@"/);
    if(!target||!below(install,resolve(dirname(file),target[1])))throw Error('candidate_invalid_package_shim: '+relative(install,file));
    changed=changed.replace(/^# cmd-shim-target=\/[^\n]*$/m,()=>'# cmd-shim-target='+resolve(dirname(file),target[1]));
  }
  if(changed!==original)writeFileSync(file,changed);
}

function inspectModules(path,candidate,install){
  for(const entry of readdirSync(path,{withFileTypes:true})){
    const file=join(path,entry.name);
    if(entry.isSymbolicLink())checkLink(candidate,file);
    else if(entry.isDirectory())inspectModules(file,candidate,install);
    else if(entry.isFile()&&path.endsWith(sep+'.bin'))relocateShim(file,install);
    else if(!entry.isFile())throw Error('candidate_invalid_module_entry: '+relative(candidate,file));
  }
}

async function seedModules(candidate,seed,names,signal){
  const packages=names.filter(n=>n==='package.json'||n.endsWith('/package.json'));
  for(const install of installs){
    const installed=join(seed,install),target=join(candidate,install);
    if(!existsSync(join(target,'package.json')))continue;
    for(const name of lockNames){
      const path=join(target,name),original=join(installed,name);
      if(existsSync(path)!==existsSync(original)||existsSync(path)&&!readFileSync(path).equals(readFileSync(original)))throw Error('candidate_dependency_lock_mismatch: '+join(install,name));
    }
    const dirs=packages.map(dirname).filter(d=>d===install||install!=='.'&&d.startsWith(install+'/'));
    for(const dir of dirs){
      signal?.throwIfAborted();
      const sourceModules=join(seed,dir,'node_modules'),targetModules=join(candidate,dir,'node_modules');
      if(!existsSync(sourceModules)){
        if(dir===install)throw Error('candidate_dependencies_missing: '+dir);
        continue;
      }
      if(realpathSync(sourceModules)!==sourceModules||!lstatSync(sourceModules).isDirectory()||realpathSync(dirname(targetModules))!==dirname(targetModules)||existsSync(targetModules))throw Error('candidate_invalid_module_root: '+dir);
      if(dependencyManifest(join(seed,dir,'package.json'))!==dependencyManifest(join(candidate,dir,'package.json')))throw Error('candidate_dependency_manifest_mismatch: '+dir);
      if(process.platform==='darwin'){
        await exec('/bin/cp',['-cRp',sourceModules,targetModules],{signal,timeout:180000});
      }else{
        await cp(sourceModules,targetModules,{recursive:true,verbatimSymlinks:true,mode:constants.COPYFILE_FICLONE,errorOnExist:true,force:false});
      }
      inspectModules(targetModules,candidate,target);
    }
  }
}

// Follow bootstrap.py's recorded source+binary digest contract. A fresh Swift
// build may require a new macOS Keychain authorization even for identical source.
function stageKeychainHelper(candidate,seed){
  const digest=data=>createHash('sha256').update(data).digest('hex');
  const bytes=(file,executable=false)=>{
    if(realpathSync(file)!==file)throw Error('not_regular');
    const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
      const stat=fstatSync(fd);
      if(!stat.isFile()||executable&&!(stat.mode&0o111))throw Error('not_regular');
      if(executable)accessSync(file,constants.X_OK);
      return readFileSync(fd);
    }finally{closeSync(fd);}
  };
  const source='services/agent/keychain.swift',bin='output/bin/siwc-keychain',record=bin+'.build.json';
  let binary,manifest,sourceSha256,binarySha256;
  try{
    manifest=bytes(join(seed,record));const saved=JSON.parse(manifest.toString('utf8'));
    sourceSha256=digest(bytes(join(candidate,source)));
    if(saved?.schemaVersion!==1||saved.sourceSha256!==sourceSha256||digest(bytes(join(seed,source)))!==sourceSha256)
      return {mode:'build-from-source',reason:'source_or_record_changed'};
    binary=bytes(join(seed,bin),true);binarySha256=digest(binary);
    if(saved.binarySha256!==binarySha256)return {mode:'build-from-source',reason:'binary_changed'};
  }catch{return {mode:'build-from-source',reason:'verified_helper_unavailable'};}
  for(const part of ['output','output/bin']){
    const target=join(candidate,part);
    try{mkdirSync(target,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
    if(realpathSync(target)!==target||!lstatSync(target).isDirectory())throw Error('candidate_helper_target_conflict');
  }
  writeFileSync(join(candidate,bin),binary,{flag:'wx',mode:0o700});
  writeFileSync(join(candidate,record),manifest,{flag:'wx',mode:0o600});
  return {mode:'verified-installed-copy',sourceSha256,binarySha256};
}

export async function prepareCandidate({workspace,candidate,attemptDir,dependencySource=workspace.source,signal}){
  const source=realpathSync(workspace.source),worktree=realpathSync(workspace.path),seed=realpathSync(dependencySource);
  const reserved=resolve(candidate),attempt=realpathSync(attemptDir);
  if(workspace.source!==source||workspace.path!==worktree||realpathSync(dirname(reserved))!==dirname(reserved)||
    [source,worktree,seed,attempt].some(root=>below(root,reserved)||below(reserved,root))||
    [source,worktree,seed].some(root=>below(root,attempt)||below(attempt,root)))throw Error('candidate_requires_isolated_directory');
  const {base,sourceHead,snapshotTree}=workspace,oid=id=>typeof id==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id);
  if(![base,sourceHead,snapshotTree].every(oid)||(await git(worktree,['rev-parse','--show-toplevel'],signal)).trim()!==worktree||
    (await git(worktree,['rev-parse',base+'^{tree}'],signal)).trim()!==snapshotTree||
    base!==sourceHead&&(await git(worktree,['rev-parse',base+'^'],signal)).trim()!==sourceHead)throw Error('candidate_assignment_base_mismatch');
  const patch=candidatePatch(workspace);
  if(!patch.bytes.length)throw Error('candidate_patch_empty');
  const path=join(attempt,'worker.patch');
  writeFileSync(path,patch.bytes,{flag:'wx',mode:0o600});
  mkdirSync(reserved,{mode:0o700});
  await git(reserved,['init','-q'],signal);
  await git(reserved,['-c','protocol.file.allow=always','fetch','-q','--depth=1','--no-tags',worktree,base],signal);
  await git(reserved,['checkout','-q','--detach',base],signal);
  await git(reserved,['apply','--index','--binary','--whitespace=nowarn',path],signal);
  const workerTree=(await git(reserved,['write-tree'],signal)).trim();
  const tracked=(await git(reserved,['ls-files','--stage','-z'],signal)).split('\0').filter(Boolean);
  const names=[];
  for(const entry of tracked){
    const name=entry.slice(entry.indexOf('\t')+1);
    if(entry.startsWith('160000 '))throw Error('candidate_unmaterialized_submodule: '+name);
    if(entry.startsWith('120000 '))checkLink(reserved,join(reserved,name));
    names.push(name);
  }
  if(workerTree===snapshotTree||candidatePatchDigest({path:reserved,base})!==patch.sha256)throw Error('candidate_patch_copy_mismatch');
  await seedModules(reserved,seed,names,signal);
  const keychainHelper=process.platform==='darwin'?stageKeychainHelper(reserved,seed):undefined;
  if(candidatePatchDigest(workspace)!==patch.sha256)throw Error('candidate_worker_changed_during_preparation');
  return {source,worktree,candidate:reserved,baseTree:snapshotTree,workerTree,workerPatchSha256:patch.sha256,workerSourceBytesVerified:true,...keychainHelper?{keychainHelper}:{}};
}

export async function buildCandidate({candidate,attemptDir,env,run,signal,receipt}){
  for(const name of ['build','doctor']){
    const log=name+'.log',logPath=join(attemptDir,log),callsPath=join(attemptDir,name+'-calls.jsonl');
    const stage=receipt[name]={log,exitCode:null,calls:[]};
    const options={command:process.execPath,args:['scripts/project.mjs',name],cwd:candidate,signal,logPath,timeoutMs:name==='build'?480000:60000,
      env:{...env,NODE_OPTIONS:'--require='+JSON.stringify(noAudio),OPENNOVA_PROBE_CALLS:callsPath,pnpm_config_verify_deps_before_run:'false'}};
    try{const result=await run(options);stage.exitCode=result.exitCode;if(result.signal)stage.signal=result.signal;}
    finally{if(existsSync(callsPath))stage.calls=readFileSync(callsPath,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));}
    if(stage.exitCode!==0||stage.signal||stage.calls.length)throw Error('candidate_'+name+'_failed');
    if(name==='doctor'){
      const report=JSON.parse(readFileSync(logPath,'utf8'));
      stage.ready=report.build?.ready===true;
      if(!stage.ready)throw Error('candidate_doctor_not_ready');
    }
  }
}
