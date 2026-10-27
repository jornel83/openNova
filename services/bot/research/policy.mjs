/** Bound even a transport that ignores AbortSignal; discard its late value. */
export async function withResearchSignal(exec,signal,next,{joinOnAbort=false}={}){
 signal.throwIfAborted();const original=exec.signal;exec.signal=signal;
 let abort;
 try{
  // Native Shell owns child processes: cancellation must join its cleanup before the tool settles.
  if(joinOnAbort)return await next();
  return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return next();}),new Promise((_,reject)=>{
  abort=()=>reject(signal.reason??Error('cancelled'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 })]);}finally{signal.removeEventListener('abort',abort);exec.signal=original;}
}
