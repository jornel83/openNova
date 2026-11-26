import {spawn} from 'node:child_process';
import {accessSync,constants,realpathSync,statSync} from 'node:fs';
import {basename,isAbsolute,join} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {nativeFileMime} from './file-types.mjs';

const helper=fileURLToPath(new URL('../../../tools/desktop/active-document.swift',import.meta.url));
const unavailable=reason=>({status:'unavailable',reason});
const failureStates=new Set(['ambiguous','unavailable','permission_required','unsupported']);

// Validate the helper's kernel identity again on the Node side. Native reads later compare
// these exact Node stat fields, including timestamps; the path alone is never a version.
function observedDocument(record){
  if(failureStates.has(record.status)){
    const reason=/^[a-z_]{1,80}$/.test(record.reason??'')?record.reason:'desktop_document_unavailable';
    return {status:record.status,reason};
  }
  if(record.status!=='available'||typeof record.path!=='string'||!isAbsolute(record.path)||typeof record.app!=='string'){
    return unavailable('invalid_desktop_observation');
  }
  if(!nativeFileMime(record.path))return {status:'unsupported',reason:'unsupported_document_type'};
  try{
    const path=realpathSync(record.path),stat=statSync(path);
    if(path!==record.path||!stat.isFile()||String(stat.ino)!==record.inode||String(stat.dev)!==record.device){
      return unavailable('document_window_changed');
    }
    const {ino,size,mtimeMs,ctimeMs}=stat;
    return {status:'available',app:record.app,file:{path,name:basename(path),ino,size,mtimeMs,ctimeMs}};
  }catch{return unavailable('document_file_missing');}
}

function launch(){
  if(process.env.OPENNOVA_PACKAGED==='1'){
    if(!process.env.OPENNOVA_BIN_DIR)throw Error('desktop_observer_runtime_missing');
    const binary=join(process.env.OPENNOVA_BIN_DIR,'opennova-active-document');
    accessSync(binary,constants.X_OK);
    return spawn(binary,[],{stdio:['pipe','pipe','ignore'],
      env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8',HOME:process.env.HOME,TMPDIR:process.env.TMPDIR}});
  }
  return spawn('/usr/bin/swift',[helper],{stdio:['pipe','pipe','ignore'],
    env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8',HOME:process.env.HOME,TMPDIR:process.env.TMPDIR}});
}

export function createActiveDocumentTracker({port,platform=process.platform,startHelper=launch,timeoutMs=2000}={}){
  let child,sequence=0,closed=false,ready=false;
  const pending=new Map();
  function finish(id,result){
    const entry=pending.get(id);
    if(!entry)return;
    clearTimeout(entry.timer);pending.delete(id);entry.resolve(result);
  }
  function lost(process){
    if(process!==child)return;
    child=undefined;ready=false;
    for(const id of pending.keys())finish(id,unavailable('desktop_observer_stopped'));
  }
  function start(){
    if(closed||child||platform!=='darwin')return;
    let process;
    try{process=startHelper();}catch{return;}
    child=process;
    const lines=createInterface({input:process.stdout});
    lines.on('line',line=>{
      if(process!==child)return;
      let reply;
      try{reply=JSON.parse(line);}catch{return;}
      if(reply?.ready===true){ready=true;return;}
      if(reply&&pending.has(reply.id))finish(reply.id,observedDocument(reply));
    });
    process.stdin.on('error',()=>lost(process));
    process.once('error',()=>lost(process));
    process.once('close',()=>{lines.close();lost(process);});
    // This optional observer cannot keep a host alive on exit. Its stdin closes with the host.
    process.unref?.();process.stdin.unref?.();process.stdout.unref?.();
  }
  start();
  return {
    capture({source}={}){
      if(platform!=='darwin')return Promise.resolve({status:'unsupported',reason:'unsupported_platform'});
      if(closed)return Promise.resolve(unavailable('desktop_observer_stopped'));
      start();
      if(!child)return Promise.resolve(unavailable('desktop_observer_stopped'));
      // Startup/compilation or a queue must not shift observation to a later focused file.
      if(!ready)return Promise.resolve(unavailable('desktop_observer_starting'));
      if(pending.size)return Promise.resolve(unavailable('desktop_observer_busy'));
      const id=++sequence;
      return new Promise(resolve=>{
        const timer=setTimeout(()=>finish(id,unavailable('desktop_observer_timeout')),timeoutMs);
        pending.set(id,{resolve,timer});
        try{child.stdin.write(JSON.stringify({id,web:source==='web',port,sentMs:Date.now()})+'\n');}
        catch{finish(id,unavailable('desktop_observer_stopped'));}
      });
    },
    close(){
      closed=true;
      if(child){const process=child;lost(process);process.stdin.end();process.kill();}
    },
  };
}
