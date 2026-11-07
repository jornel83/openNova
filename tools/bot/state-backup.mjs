#!/usr/bin/env node
/** Offline state snapshot. It is deliberately not an in-place migration tool. */
import {DatabaseSync,backup as sqliteBackup} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,existsSync,lstatSync,fstatSync,realpathSync,readdirSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,chmodSync,rmSync,unlinkSync,openSync,readSync,closeSync,readlinkSync,symlinkSync} from 'node:fs';
import {join,resolve,dirname,relative,isAbsolute,sep} from 'node:path';
import {hostname} from 'node:os';
import {createConnection} from 'node:net';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {ROOT,runtimeSources} from '../../services/runtime/sources.mjs';

export const RESTORE_MARKER='.opennova-restore.json';
const inside=(root,path)=>path===root||path.startsWith(root+sep);
const safeName=name=>typeof name==='string'&&name.length>0&&!isAbsolute(name)&&!name.includes('\\')&&!name.includes('\0')&&name.split('/').every(part=>part&&part!=='.'&&part!=='..');
const linkHash=value=>createHash('sha256').update(value).digest('hex');
const processLock=name=>name==='bot/state.lock'||name.endsWith('/session.lock')||name.split('/').includes('.git')&&name.endsWith('.lock');
function external(path,{existing=true,repository=ROOT}={}){
  const absolute=resolve(path),value=existing?realpathSync(absolute):join(realpathSync(dirname(absolute)),absolute.split(sep).at(-1));
  if(inside(realpathSync(repository),value)||existing&&lstatSync(absolute).isSymbolicLink())throw Error('state_path_must_be_external');
  if(existing&&!lstatSync(value).isDirectory())throw Error('state_directory_required');
  return value;
}
async function digest(path){
  const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');
}
function sqliteFile(path){
  const fd=openSync(path,'r'),head=Buffer.alloc(16);try{return readSync(fd,head,0,16,0)===16&&head.toString()==='SQLite format 3\0';}finally{closeSync(fd);}
}
function walk(root,{ownedLock=false,sessionLocks=false}={}){
  const entries=[];
  function visit(path,name){
    if(ownedLock&&name==='bot/state.lock')return;
    const stat=lstatSync(path);
    if(name&&!safeName(name))throw Error('unsafe_state_path');
    if(stat.isSymbolicLink()){
      if(processLock(name))throw Error('state_lock_present: '+name);
      entries.push({path:name,type:'symlink',target:readlinkSync(path)});return;
    }
    if(!stat.isDirectory()&&!stat.isFile()||stat.isFile()&&stat.nlink!==1)throw Error('unsupported_state_entry: '+name);
    if(stat.mode&0o7000)throw Error('unsupported_state_permissions: '+name);
    if(stat.isFile()&&!(stat.mode&0o400))throw Error('state_file_not_owner_readable: '+name);
    if(processLock(name)&&!(sessionLocks&&name.endsWith('/session.lock')))throw Error('state_lock_present: '+name);
    if(name){if(!safeName(name))throw Error('unsafe_state_path');entries.push({path:name,type:stat.isDirectory()?'directory':'file',size:stat.size,mode:stat.mode&0o777});}
    if(stat.isDirectory())for(const child of readdirSync(path).sort())visit(join(path,child),name?name+'/'+child:child);
  }
  visit(root,'');return entries;
}
async function portClosed(port){
  if(!Number.isInteger(port)||port<1025||port>65535)throw Error('invalid_host_port');
  await new Promise((resolve,reject)=>{
    const socket=createConnection({host:'127.0.0.1',port});
    socket.setTimeout(1500);socket.once('connect',()=>{socket.destroy();reject(Error('host_must_be_stopped'));});
    socket.once('timeout',()=>{socket.destroy();reject(Error('host_stop_unconfirmed'));});
    socket.once('error',error=>{socket.destroy();error.code==='ECONNREFUSED'?resolve():reject(Error('host_stop_unconfirmed'));});
  });
}
function guardJobs(db){
  if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='background_job'").get())return;
  for(const row of db.prepare('SELECT body FROM background_job').iterate()){
    const job=JSON.parse(row.body);
    if(job.cleanupConfirmed===false||['running','pausing','cancelling'].includes(job.status))throw Error('task_cleanup_unconfirmed');
  }
}
function checkedDb(path,{jobs=false}={}){
  const db=new DatabaseSync(path,{readOnly:true});
  try{if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('sqlite_integrity_failed');if(jobs)guardJobs(db);return db;}
  catch(error){db.close();throw error;}
}
async function sourceFingerprint(root,entries,databases){
  // SQLite may update its coordination SHM while reading; persistent DB/WAL data
  // and every other state file must remain unchanged during the offline copy.
  const result=[];for(const entry of entries){if(entry.type==='file'&&databases.has(entry.path.replace(/-(shm|wal)$/,''))&&(entry.path.endsWith('-shm')||entry.path.endsWith('-wal')&&entry.size===0))continue;result.push([entry.path,entry.type,entry.type==='file'?await digest(join(root,entry.path)):entry.type==='symlink'?entry.target:null]);}return JSON.stringify(result);
}
export function assertRestoreLocation(home){
  const path=join(home,RESTORE_MARKER);if(!existsSync(path))return;
  if(lstatSync(path).isSymbolicLink())throw Error('invalid_restore_marker');
  let marker;try{marker=JSON.parse(readFileSync(path,'utf8'));}catch{throw Error('invalid_restore_marker');}
  if(marker.version!==1||typeof marker.originalHome!=='string'||realpathSync(home)!==marker.originalHome)throw Error('restore_staging_not_launchable: restore the verified snapshot to its original home first');
}
export async function backupState({home,destination,port=18560,references=[],repository=ROOT}){
  home=external(home,{repository});destination=external(destination,{existing:false,repository});
  if(inside(home,destination)||inside(destination,home)||existsSync(destination))throw Error('backup_destination_must_be_new');
  if(!existsSync(join(home,'bridge.sqlite'))||!existsSync(join(home,'bot')))throw Error('not_opennova_state');
  await portClosed(port);
  const lock=join(home,'bot/state.lock'),token=randomUUID();
  // This is the same single-writer lock recognized by the bundled Bot runtime.
  try{writeFileSync(lock,JSON.stringify({pid:process.pid,host:hostname(),token,since:Date.now()}),{flag:'wx',mode:0o600});}catch(error){if(error.code==='EEXIST')throw Error('state_lock_present: bot/state.lock');throw error;}
  let created=false;const heldSessions=[];
  try{
    await portClosed(port);const entries=walk(home,{ownedLock:true,sessionLocks:true});
    const sessions=entries.filter(e=>e.path.endsWith('/session.lock'));
    if(sessions.length){
      const {tryLockExclusive}=await import(pathToFileURL(join(runtimeSources().harnessRoot,'native/system/packages/entry/lib/flock.js')));
      for(const entry of sessions){
        const path=join(home,entry.path),fd=openSync(path,'r+');heldSessions.push(fd);
        try{await tryLockExclusive(fd);}catch(error){if(['EAGAIN','EWOULDBLOCK'].includes(error.code))throw Error('session_lock_active: '+entry.path);throw error;}
        const held=fstatSync(fd),current=lstatSync(path);if(held.ino!==current.ino||held.dev!==current.dev||current.isSymbolicLink())throw Error('state_changed_during_backup');
      }
    }
    const databases=new Set(entries.filter(e=>e.type==='file'&&sqliteFile(join(home,e.path))).map(e=>e.path));
    const before=await sourceFingerprint(home,entries,databases);
    if(!databases.has('bridge.sqlite'))throw Error('invalid_bridge_database');
    const ref=[];for(const path of references){const absolute=realpathSync(path);if(lstatSync(path).isSymbolicLink()||!lstatSync(absolute).isFile())throw Error('invalid_configuration_reference');ref.push({path:absolute,sha256:await digest(absolute)});}
    mkdirSync(destination,{mode:0o700});created=true;const payload=join(destination,'payload');mkdirSync(payload,{mode:0o700});const files=[],omitted=[];
    for(const entry of entries){
      const target=join(payload,entry.path);
      if(entry.type==='directory'){mkdirSync(target,{mode:0o700});files.push({path:entry.path,type:'directory'});continue;}
      if(entry.type==='symlink'){symlinkSync(entry.target,target);files.push({...entry,sha256:linkHash(entry.target)});continue;}
      if(entry.path.endsWith('/session.lock')){omitted.push(entry.path);continue;}
      const base=entry.path.replace(/-(wal|shm|journal)$/,'');
      if(base!==entry.path&&databases.has(base)){omitted.push(entry.path);continue;}
      if(databases.has(entry.path)){
        const db=checkedDb(join(home,entry.path),{jobs:entry.path==='bridge.sqlite'});try{await sqliteBackup(db,target);}finally{db.close();}
        const copied=new DatabaseSync(target);try{copied.exec('PRAGMA journal_mode=DELETE');if(copied.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('sqlite_integrity_failed');}finally{copied.close();}
      }else copyFileSync(join(home,entry.path),target);
      // Retain owner read/write/execute bits without widening readonly snapshots.
      const mode=entry.mode&0o700;chmodSync(target,mode);
      files.push({path:entry.path,type:'file',sqlite:databases.has(entry.path),mode,size:lstatSync(target).size,sha256:await digest(target)});
    }
    await portClosed(port);
    if(before!==await sourceFingerprint(home,walk(home,{ownedLock:true,sessionLocks:true}),databases))throw Error('state_changed_during_backup');
    const git=spawnSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8',stdio:['ignore','pipe','ignore']});
    const manifest={version:1,createdAt:Date.now(),originalHome:home,codeRevision:git.status===0?git.stdout.trim():null,files,omitted,references:ref,
      authorization:'External SIWC storage and OS Keychain are not exported. Local connection credentials inside the state home remain in this private backup.'};
    writeFileSync(join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    return {destination,files:files.filter(e=>e.type==='file').length,symlinks:files.filter(e=>e.type==='symlink').length,databases:databases.size,codeRevision:manifest.codeRevision};
  }catch(error){if(created)rmSync(destination,{recursive:true,force:true});throw error;}
  finally{for(const fd of heldSessions)closeSync(fd);try{if(JSON.parse(readFileSync(lock,'utf8')).token===token)unlinkSync(lock);}catch{}}
}
export async function verifyBackup({directory,repository=ROOT}){
  directory=external(directory,{repository});
  if(lstatSync(join(directory,'manifest.json')).isSymbolicLink())throw Error('invalid_backup_manifest');
  const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
  if(manifest.version!==1||typeof manifest.originalHome!=='string'||!isAbsolute(manifest.originalHome)||!Array.isArray(manifest.files))throw Error('invalid_backup_manifest');
  const root=join(directory,'payload');if(lstatSync(root).isSymbolicLink())throw Error('unsupported_state_entry: payload');
  const actual=walk(root),byPath=new Map(actual.map(e=>[e.path,e])),seen=new Set(),types=new Map();
  for(const entry of manifest.files){
    if(!safeName(entry.path)||types.has(entry.path)||!['file','directory','symlink'].includes(entry.type))throw Error('unsafe_backup_manifest');types.set(entry.path,entry.type);
  }
  for(const entry of manifest.files){
    let parent=entry.path;while(parent.includes('/')){parent=parent.slice(0,parent.lastIndexOf('/'));if(types.get(parent)!=='directory')throw Error('unsafe_backup_parent');}
  }
  for(const entry of manifest.files){
    seen.add(entry.path);
    const found=byPath.get(entry.path);if(!found||found.type!==entry.type)throw Error('backup_entries_changed');
    if(entry.type==='symlink'&&(typeof entry.target!=='string'||!entry.target||entry.target.includes('\0')||entry.sha256!==linkHash(entry.target)||found.target!==entry.target))throw Error('backup_link_mismatch');
    if(entry.type==='file'){
      if(!/^[a-f0-9]{64}$/.test(entry.sha256)||!Number.isSafeInteger(entry.size)||entry.size<0||![0o400,0o500,0o600,0o700].includes(entry.mode))throw Error('invalid_backup_manifest');
      if(found.size!==entry.size||await digest(join(root,entry.path))!==entry.sha256)throw Error('backup_hash_mismatch: '+entry.path);
      if(entry.sqlite){const db=checkedDb(join(root,entry.path));db.close();}
    }
  }
  if(actual.length!==manifest.files.length||!seen.has('bridge.sqlite'))throw Error('backup_entries_changed');
  return manifest;
}
export async function restoreState({directory,destination,repository=ROOT}){
  const manifest=await verifyBackup({directory,repository});destination=external(destination,{existing:false,repository});
  if(existsSync(destination)||inside(realpathSync(directory),destination)||inside(destination,realpathSync(directory)))throw Error('restore_destination_must_be_new');
  mkdirSync(destination,{mode:0o700});
  try{
    for(const entry of [...manifest.files].sort((a,b)=>a.path.split('/').length-b.path.split('/').length)){
      const target=join(destination,entry.path);
      if(entry.type==='directory')mkdirSync(target,{mode:0o700});
      else if(entry.type==='symlink')symlinkSync(entry.target,target);
      else{copyFileSync(join(directory,'payload',entry.path),target);chmodSync(target,entry.mode);if(await digest(target)!==entry.sha256)throw Error('restore_hash_mismatch');}
    }
    writeFileSync(join(destination,RESTORE_MARKER),JSON.stringify({version:1,originalHome:manifest.originalHome,codeRevision:manifest.codeRevision,restoredAt:Date.now(),references:manifest.references??[]},null,2)+'\n',{mode:0o600});
    return {destination,originalHome:manifest.originalHome,files:manifest.files.filter(e=>e.type==='file').length,staging:true};
  }catch(error){rmSync(destination,{recursive:true,force:true});throw error;}
}
export async function main(argv=process.argv.slice(2)){
  const [command,...args]=argv;if(!command||command==='--help'){console.log('node tools/bot/state-backup.mjs backup --home DIR --destination NEW_DIR [--port 18560] [--reference FILE]\nnode tools/bot/state-backup.mjs verify --directory BACKUP\nnode tools/bot/state-backup.mjs restore --directory BACKUP --destination NEW_STAGING_DIR\nStop the host and finish cleanup before backup. All state destinations must be outside the repository. Restore never starts a host.');return;}
  const options={references:[]},allowed={backup:['home','destination','port','reference'],verify:['directory'],restore:['directory','destination']}[command];if(!allowed)throw Error('unknown_backup_command');
  for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2),value=args[i+1];if(!args[i]?.startsWith('--')||!allowed.includes(key)||!value||value.startsWith('--')||key!=='reference'&&Object.hasOwn(options,key))throw Error('invalid_backup_option');if(key==='reference')options.references.push(value);else options[key]=key==='port'?Number(value):value;}
  for(const key of command==='backup'?['home','destination']:command==='restore'?['directory','destination']:['directory'])if(!options[key])throw Error('missing_backup_option: '+key);
  const result=command==='backup'?await backupState(options):command==='restore'?await restoreState(options):await verifyBackup(options).then(m=>({verified:true,files:m.files.length,codeRevision:m.codeRevision}));console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]===import.meta.filename)main().catch(error=>{console.error(error.message);process.exitCode=1;});
