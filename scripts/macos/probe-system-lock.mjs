#!/usr/bin/env node
/** Exercise the packaged POSIX lock binding using disposable local files only. */
import assert from 'node:assert/strict';
import {closeSync,mkdtempSync,openSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export async function probeSystemLock(code){
  const {tryLockExclusive}=await import(pathToFileURL(join(code,'engine/harness/native/system/packages/entry/lib/flock.js')));
  const directory=mkdtempSync(join(tmpdir(),'opennova-native-lock-'));
  let first,second;
  try{
    const path=join(directory,'session.lock');
    first=openSync(path,'w+');second=openSync(path,'r+');
    await tryLockExclusive(first);
    await assert.rejects(tryLockExclusive(second),error=>['EAGAIN','EWOULDBLOCK'].includes(error.code)&&error.syscall==='flock');
    closeSync(first);first=undefined;
    await tryLockExclusive(second);
    return {nativeLockAcquired:true,contentionRejected:true,reacquiredAfterRelease:true};
  }finally{
    if(first!==undefined)closeSync(first);
    if(second!==undefined)closeSync(second);
    rmSync(directory,{recursive:true,force:true});
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.length&&!(args.length===2&&args[0]==='--code'))throw Error('Usage: probe-system-lock.mjs [--code <app code root>]');
  const code=args.length?resolve(args[1]):resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  console.log(JSON.stringify(await probeSystemLock(code)));
}
