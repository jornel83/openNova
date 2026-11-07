import {mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

export const teamSoakLock=root=>join(root,'output','team-soak.lock');
const started=pid=>{
  if(!Number.isInteger(pid)||pid<1)throw Error('invalid_lock_owner_pid');
  const result=spawnSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8'});
  if(result.error||![0,1].includes(result.status))throw Error('lock_process_identity_unavailable');
  const identity=result.stdout?.trim();
  if(result.status===0&&!identity)throw Error('lock_process_identity_unavailable');
  return identity;
};
export function assertNoTeamSoak(root){
  if(existsSync(teamSoakLock(root)))throw Error('team_soak_owns_build: inspect output/team-soak.lock/owner.json; build or soak already owns the shared artifacts');
}
function acquire(root,owner){
  owner={...owner,processStarted:started(owner.pid)};
  const path=teamSoakLock(root);mkdirSync(join(root,'output'),{recursive:true});
  try{mkdirSync(path);}catch(error){if(error.code==='EEXIST')throw Error('team_soak_already_locked: build or soak owns output/team-soak.lock; inspect owner.json and use explicit recovery after cleanup');throw error;}
  try{writeFileSync(join(path,'owner.json'),JSON.stringify(owner,null,2),{mode:0o600,flag:'wx'});}catch(error){rmSync(path,{recursive:true,force:true});throw error;}
  const current=()=>{
    const stored=JSON.parse(readFileSync(join(path,'owner.json'),'utf8'));
    if(stored.runId!==owner.runId||stored.pid!==owner.pid)throw Error('team_soak_lock_owner_changed');
    return stored;
  };
  const release=()=>{
    current();
    rmSync(path,{recursive:true});
  };
  release.update=patch=>{
    const value={...current(),...patch},temporary=join(path,'owner.tmp');writeFileSync(temporary,JSON.stringify(value,null,2),{mode:0o600});renameSync(temporary,join(path,'owner.json'));
  };
  return release;
}
export const acquireTeamSoak=(root,owner)=>acquire(root,{...owner,purpose:'soak'});
export const acquireBuild=(root,owner)=>acquire(root,{...owner,purpose:'build',children:[],spawning:false});
export function buildGroupAlive(pid,{kill=process.kill,ps=spawnSync}={}){
  if(!Number.isInteger(pid)||pid<1)throw Error('invalid_build_pid');
  try{kill(process.platform==='win32'?pid:-pid,0);return true;}catch(error){
    if(error.code==='ESRCH')return false;
    if(error.code!=='EPERM')throw error;
    // EPERM is not proof of exit. macOS can briefly return it as a group
    // disappears; only a complete process table with no matching PGID is proof.
    if(process.platform==='win32')return true;
    const result=ps('ps',['-axo','pid=,pgid='],{encoding:'utf8',timeout:1000});
    if(result.error||result.status!==0||!result.stdout?.trim())return true;
    const rows=result.stdout.trim().split('\n').map(line=>line.trim().split(/\s+/));
    if(rows.some(row=>row.length!==2||row.some(value=>!/^\d+$/.test(value)||Number(value)<1)))return true;
    return rows.some(row=>Number(row[1])===pid);
  }
}

/** Explicit stale-lock repair requires the same completed run, never just a PID. */
export function recoverTeamSoakLock(root,runId){
  const path=teamSoakLock(root),owner=JSON.parse(readFileSync(join(path,'owner.json'),'utf8'));
  if(owner.purpose&&owner.purpose!=='soak')throw Error('team_soak_cleanup_not_proven');
  const result=JSON.parse(readFileSync(join(owner.home,'result.json'),'utf8'));
  if(!runId||owner.runId!==runId||result.runId!==runId||result.pid!==owner.pid||!result.finishedAt||result.cleanupConfirmed!==true)throw Error('team_soak_cleanup_not_proven');
  const current=started(owner.pid);
  if(current&&(!owner.processStarted||current===owner.processStarted))throw Error('team_soak_runner_still_alive');
  rmSync(path,{recursive:true});
}

/** Crash recovery is explicit and refuses an interrupted child-registration gap. */
export function recoverBuildLock(root,runId){
  const path=teamSoakLock(root),owner=JSON.parse(readFileSync(join(path,'owner.json'),'utf8'));
  if(owner.purpose!=='build'||!runId||owner.runId!==runId||owner.spawning||!Array.isArray(owner.children))throw Error('build_cleanup_not_proven');
  const identity=started(owner.pid);
  if(identity&&(!owner.processStarted||identity===owner.processStarted))throw Error('build_runner_still_alive');
  for(const child of owner.children)if(child.cleanupConfirmed!==true&&buildGroupAlive(child.pid))throw Error('build_children_still_alive');
  rmSync(path,{recursive:true});
}
