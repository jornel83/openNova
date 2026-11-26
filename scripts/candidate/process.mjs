// Run a candidate build stage inside its own disposable process group. The
// group leader watches an IPC pipe so abrupt verifier exit still stops children.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const runner=fileURLToPath(new URL('./stage-runner.mjs',import.meta.url));

export async function runLogged({command,args=[],cwd,env,logPath,timeoutMs,signal}){
  signal?.throwIfAborted();
  const owner=spawn(process.execPath,[runner],{cwd,env:{PATH:env.PATH},detached:true,stdio:['ignore','ignore','ignore','ipc']});
  const closed=new Promise(resolve=>{owner.once('exit',()=>resolve());owner.once('error',()=>resolve());});
  const stopSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
  let abort;
  try{
    return await new Promise((resolve,reject)=>{
      abort=()=>reject(Error(signal?.aborted?'candidate_interrupted':'candidate_stage_timeout'));
      stopSignal.addEventListener('abort',abort,{once:true});
      owner.once('error',reject);
      owner.once('exit',()=>reject(Error('candidate_stage_owner_exited')));
      owner.once('message',result=>result.error?reject(Error(result.error)):resolve({exitCode:result.code,signal:result.signal}));
      if(stopSignal.aborted){abort();return;}
      owner.send({type:'start',file:command,args,cwd,log:logPath,env:{...env,OPENNOVA_PROBE_CONTAIN_CHILDREN:'1'}},error=>{if(error)reject(error);});
    });
  }finally{
    stopSignal.removeEventListener('abort',abort);
    if(owner.connected)owner.send({type:'close'},()=>{});
    if(owner.pid){
      const alive=()=>{try{process.kill(-owner.pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
      for(let i=0;i<35&&alive();i++)await delay(100);
      if(alive())try{process.kill(-owner.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
      await closed;
      for(let i=0;i<15&&alive();i++)await delay(100);
      if(alive())throw Error('candidate_process_cleanup_unconfirmed');
    }
  }
}
