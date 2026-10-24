/** Bound even a transport that ignores AbortSignal; discard its late value. */
export async function withResearchSignal(exec,signal,next){
 signal.throwIfAborted();const original=exec.signal;exec.signal=signal;
 let abort;
 try{return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return next();}),new Promise((_,reject)=>{
  abort=()=>reject(signal.reason??Error('cancelled'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 })]);}finally{signal.removeEventListener('abort',abort);exec.signal=original;}
}
