/** Offline attachment transport only; the real host owns locating, snapshots and history. */
import {appendFileSync,readFileSync,statSync} from 'node:fs';
import {basename} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

export function createNativeFileReader(){
  return async ({bytes,filename,mime,question,signal})=>{
    const trace=value=>appendFileSync(process.env.OPENNOVA_NATIVE_FILE_TEST_TRACE,JSON.stringify(value)+'\n');
    const marker=bytes.toString('utf8').match(/NATIVE_[A-Z_]+/)?.[0];
    if(!marker||mime!=='application/pdf')throw Error('unexpected_native_file_fixture');
    trace({phase:'started',filename,marker,question,aborted:!!signal?.aborted});
    // Deliberately ignores abort to exercise the host's late-result guard.
    if(question==='DELAY_LATE')await delay(1200);
    trace({phase:'returned',filename,marker,question,aborted:!!signal?.aborted});
    return {status:'read',content:marker,limitation:null};
  };
}

export function createActiveDocumentTracker(){
  return {
    capture(){
      const path=readFileSync(process.env.OPENNOVA_TEST_ACTIVE_DOCUMENT,'utf8').trim();
      if(!path)return {status:'unavailable'};
      const {size,mtimeMs,ctimeMs,ino}=statSync(path);
      return {status:'available',app:'WPS',file:{path,name:basename(path),size,mtimeMs,ctimeMs,ino}};
    },
    close(){},
  };
}
