/** Compare the candidate worktree with its assigned base without modifying the project's index or objects. */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function withPrivateIndex(workspace,read){
  if(!workspace?.path||!(/^[a-f\d]{40}$|^[a-f\d]{64}$/i.test(workspace.base)))throw Error('candidate_base_unavailable');
  const directory=mkdtempSync(join(tmpdir(),'opennova-candidate-index-'));
  const env={...process.env,LC_ALL:'C',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'};
  for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_EXTERNAL_DIFF'])delete env[key];
  const git=args=>{
    const result=spawnSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.splitIndex=false','-c','core.fileMode=true',...args],{cwd:workspace.path,env,timeout:15000,maxBuffer:20*1024*1024});
    if(result.status!==0)throw Error('candidate_patch_unavailable');
    return result.stdout;
  };
  try{
    env.GIT_INDEX_FILE=join(directory,'index');
    return read({directory,env,git});
  }finally{rmSync(directory,{recursive:true,force:true});}
}

export function candidatePatch(workspace,{keepIndex=false}={}){
  return withPrivateIndex(workspace,({directory,env,git})=>{
    const objects=git(['rev-parse','--path-format=absolute','--git-path','objects']).toString('utf8').trimEnd();
    env.GIT_OBJECT_DIRECTORY=join(directory,'objects');
    env.GIT_ALTERNATE_OBJECT_DIRECTORIES=JSON.stringify(objects);
    mkdirSync(env.GIT_OBJECT_DIRECTORY);
    git(['read-tree',workspace.base]);
    git(['add','-A','--','.']);
    const diff=['diff','--cached','--no-renames','--no-ext-diff','--no-textconv'];
    const bytes=git([...diff,'--binary','--full-index',workspace.base,'--','.']);
    const names=git([...diff,'--name-only','-z',workspace.base,'--','.']).toString('utf8').split('\0').filter(Boolean);
    return {bytes,names,sha256:createHash('sha256').update(bytes).digest('hex'),...(keepIndex?{index:readFileSync(env.GIT_INDEX_FILE)}:{})};
  });
}

export const candidatePatchDigest=workspace=>candidatePatch(workspace).sha256;

// The report view can cheaply disprove changes against a private index from the last full capture.
// A possibly dirty stat entry simply requests another full capture. Signing always recomputes the digest.
export function candidateIndexClean(workspace,index){
  return withPrivateIndex(workspace,({env,git})=>{
    writeFileSync(env.GIT_INDEX_FILE,index,{mode:0o600});
    return git(['ls-files','--modified','--deleted','--others','--exclude-standard','-z','--','.']).length===0;
  });
}
