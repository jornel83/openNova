/** A trusted local tool process. Only its structured receipt crosses the bridge. */
import {spawn} from 'node:child_process';
import {accessSync,constants} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {ROOT} from '../../runtime/sources.mjs';
import {usesSparkImage} from './providers.mjs';
import {imageRuntimeEnv,legacyImagePython,pinImageRuntime} from './runtime.mjs';

export {pinImageRuntime} from './runtime.mjs';

export function runImageGenerator(envelope,{signal,recoverOnly=false,snapshot}={}){
  signal?.throwIfAborted();
  const spark=envelope.tool==='image_generate'&&usesSparkImage(envelope.arguments);
  const credentials=envelope.tool!=='media_export'&&!spark;
  const pin=snapshot?pinImageRuntime(snapshot,{credentials,spark}):undefined;
  const python=pin?.python??legacyImagePython();
  try{
    if(!isAbsolute(python))throw Error();
    accessSync(python,constants.X_OK);
  }catch{throw Error('image_python_unavailable');}
  const env=pin?.env??imageRuntimeEnv({credentials,spark}),root=pin?.archiveRoot??ROOT;
  const complete=result=>pin?{...result,runtime:{...result.runtime,...pin.runtime}}:result;
  return new Promise((resolve,reject)=>{
    const args=['-I','-B',join(root,'tools/image/tool.py'),'--request','-',...(recoverOnly?['--recover-only']:[])];
    const child=spawn(python,args,{cwd:root,env,stdio:['pipe','pipe','ignore']});
    let bytes=0,buffers=[],stopReason;
    const stop=reason=>{stopReason??=reason;child.kill('SIGKILL');};
    const abort=()=>stop('image_executor_interrupted');
    const timer=setTimeout(()=>stop('image_executor_timeout'),envelope.tool==='gif_generate'?270000:180000);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    child.stdout.on('data',data=>{
      bytes+=data.length;
      if(bytes>1024*1024)stop('image_receipt_too_large');else buffers.push(data);
    });
    child.stdin.on('error',()=>{}); // A startup failure can close stdin before the payload is consumed.
    child.once('error',()=>{cleanup();reject(Error('image_executor_unavailable'));});
    child.once('close',code=>{
      cleanup();
      if(stopReason)return reject(Error(stopReason));
      let reply;
      try{reply=JSON.parse(Buffer.concat(buffers).toString('utf8'));}catch{return reject(Error('image_executor_receipt_missing'));}
      if(code===0&&reply.ok===true&&reply.result?.status==='completed')return resolve(complete(reply.result));
      if(code===1&&reply.ok===false){
        if(['failed','cancelled','unknown','pending','partial'].includes(reply.result?.status))return resolve(complete(reply.result));
        if(/^[a-z][a-z0-9_]{1,120}$/.test(reply.error?.code))return reject(Error(reply.error.code));
      }
      reject(Error('invalid_image_executor_receipt'));
    });
    child.stdin.end(JSON.stringify(envelope));
  });
}
