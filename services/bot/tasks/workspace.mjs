import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdirSync,readFileSync,rmSync,existsSync,realpathSync,lstatSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {readJson,saveJson} from './agent-files.mjs';
const exec=promisify(execFile);
export const digest=value=>createHash('sha256').update(value).digest('hex');
export async function git(cwd,args,extra={}){
  const {stdout}=await exec('git',['-c','core.hooksPath=/dev/null',...args],{cwd,maxBuffer:16*1024*1024,timeout:120000,...extra,env:{...process.env,GIT_TERMINAL_PROMPT:'0',...extra.env}});
  return stdout;
}
export function inside(root,path){const rel=relative(root,path);return rel!== '..'&&!rel.startsWith('../')&&!isAbsolute(rel);}
/** Snapshot tracked and nonignored work without changing the user's index. */
export async function prepareWorkspace({source,home,taskId,mode}){
  const saved=readJson(join(home,'workspace.json'));
  if(saved){if(saved.source!==realpathSync(source)||!existsSync(saved.path))throw Error('task_workspace_missing');return saved;}
  mkdirSync(home,{recursive:true,mode:0o700});home=realpathSync(home);
  source=realpathSync(source);
  const root=(await git(source,['rev-parse','--show-toplevel'])).trim();
  if(realpathSync(root)!==source)throw Error('agent_workspace_requires_repository_root');
  const intent=readJson(join(home,'workspace-intent.json'));
  if(intent){
    if(intent.source!==source||!existsSync(intent.path)||(await git(intent.path,['rev-parse','HEAD'])).trim()!==intent.base||(await git(intent.path,['symbolic-ref','--short','HEAD'])).trim()!==intent.branch||(await git(intent.path,['status','--porcelain'])).trim())throw Error('workspace_preparation_interrupted');
    saveJson(join(home,'workspace.json'),intent);return intent;
  }
  const head=(await git(source,['rev-parse','HEAD'])).trim(),index=join(home,'snapshot-index');
  const env={...process.env,GIT_INDEX_FILE:index,GIT_AUTHOR_NAME:'OpenNova',GIT_AUTHOR_EMAIL:'opennova@localhost',GIT_COMMITTER_NAME:'OpenNova',GIT_COMMITTER_EMAIL:'opennova@localhost'};
  let tree;
  try{
    await git(source,['read-tree',head],{env});await git(source,['add','-A','--','.'],{env});
    tree=(await git(source,['write-tree'],{env})).trim();
    await git(source,['add','-A','--','.'],{env});
    if(tree!==(await git(source,['write-tree'],{env})).trim()||head!==(await git(source,['rev-parse','HEAD'])).trim())throw Error('workspace_changed_during_snapshot');
    const base=(await git(source,['commit-tree',tree,'-p',head,'-m','OpenNova task starting snapshot'],{env})).trim();
    const path=join(home,'workspace'),branch='codex/task-'+digest(taskId).slice(0,20);
    // Save launch intent so interrupted worktree creation is inspected, never replaced.
    const intentPath=join(home,'workspace-intent.json');
    if(readJson(intentPath))throw Error('workspace_preparation_interrupted');
    const result={source,path,branch,base,sourceHead:head,snapshotTree:tree,mode,createdAt:Date.now()};
    saveJson(intentPath,result);
    await git(source,['worktree','add','-b',branch,path,base]);
    saveJson(join(home,'workspace.json'),result);return result;
  }finally{rmSync(index,{force:true});}
}
export async function workspaceDiff(home){
  const workspace=readJson(join(home,'workspace.json'));if(!workspace)throw Error('task_workspace_not_ready');
  await git(workspace.path,['add','-A','--','.']);
  const applied=Object.values(readJson(join(home,'applications.json'),{})).filter(r=>r.status==='applied');
  const base=applied.at(-1)?.tree??workspace.base;
  const tree=(await git(workspace.path,['write-tree'])).trim();
  const patch=await git(workspace.path,['diff','--cached','--binary','--no-renames','--no-ext-diff',base,'--','.']);
  const names=(await git(workspace.path,['diff','--cached','--no-renames','--name-only','-z',base])).split('\0').filter(Boolean);
  return {workspace,base,tree,patch,revision:digest(base+'\0'+tree+'\0'+patch),files:names,empty:!patch};
}
/** Apply exactly the reviewed patch; keep a receipt for interrupted dispatches. */
export async function applyWorkspace(home,{revision,actionId}){
  const path=join(home,'applications.json'),applications=readJson(path,{}),old=applications[actionId];
  if(old){if(old.revision!==revision)throw Error('task_id_conflict');return old;}
  const diff=await workspaceDiff(home);
  if(diff.revision!==revision)throw Error('task_diff_changed');
  if(diff.empty)throw Error('task_diff_empty');
  if(Object.values(applications).some(r=>r.status==='applying'||r.status==='unknown'))throw Error('task_apply_unknown');
  if(Object.values(applications).some(r=>r.status==='applied'&&r.revision===revision))return Object.values(applications).find(r=>r.status==='applied'&&r.revision===revision);
  const patchPath=join(home,'apply-'+randomUUID()+'.patch');
  const {writeFileSync}=await import('node:fs');writeFileSync(patchPath,diff.patch,{mode:0o600});
  const record={actionId,revision,tree:diff.tree,status:'applying',createdAt:Date.now()};
  try{
    // Reject changed base files, even when git could apply using nearby context.
    for(const name of diff.files){
      const target=resolve(diff.workspace.source,name);if(!inside(diff.workspace.source,target))throw Error('task_apply_conflict');
      const entry=(await git(diff.workspace.path,['ls-tree','-z',diff.base,'--',name])).split('\0')[0];
      const mode=entry?.split(' ')[0];
      if(mode&&mode!=='100644'&&mode!=='100755')throw Error('task_apply_unsupported_file');
      const base=entry?await git(diff.workspace.path,['show',diff.base+':'+name],{encoding:'buffer'}):null;
      let ancestor=dirname(target);while(!existsSync(ancestor))ancestor=dirname(ancestor);
      if(!inside(diff.workspace.source,realpathSync(ancestor)))throw Error('task_apply_conflict');
      let current=null,stat;try{stat=lstatSync(target);if(!stat.isFile())throw Error('task_apply_unsupported_file');current=readFileSync(target);}catch(error){if(error.code!=='ENOENT')throw error;}
      if(base===null?current!==null:current===null||!Buffer.from(base).equals(current)||(mode==='100755')!==!!(stat.mode&0o111))throw Error('task_apply_conflict');
      const nextEntry=(await git(diff.workspace.path,['ls-tree','-z',diff.tree,'--',name])).split('\0')[0];
      if(nextEntry&&!['100644','100755'].includes(nextEntry.split(' ')[0]))throw Error('task_apply_unsupported_file');
    }
    await git(diff.workspace.source,['apply','--check','--binary',patchPath]);
    applications[actionId]=record;saveJson(path,applications);
    await git(diff.workspace.source,['apply','--binary',patchPath]);
    applications[actionId]={...record,status:'applied',finishedAt:Date.now()};saveJson(path,applications);return applications[actionId];
  }catch(error){
    if(applications[actionId]){applications[actionId]={...record,status:'unknown'};saveJson(path,applications);}
    throw error;
  }finally{rmSync(patchPath,{force:true});}
}
