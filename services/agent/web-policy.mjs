/** Harness hooks only: Harness still owns model requests, tool execution, history and cancellation. */
export const name='opennova-web-policy';
export const inject=['tools'];
export function apply(ctx,{budget,current,onStatus=()=>{},onResult=()=>{},onFailure=()=>{}}) {
  const calls=new Map();
  ctx.on('agent/request',async({agent,step},next)=>{
    const r=current(agent);if(!r || r.cancelled)throw Error('request_not_active');
    try {budget.claimModel(r.id);}catch(e){onFailure(r,e.message);throw e;}
    r.step=step;
    if(!r.abortListener) {
      r.abortListener=()=>{onFailure(r,'agent_timeout');agent.cancel({kind:'user'});};
      r.signal.addEventListener('abort',r.abortListener,{once:true});
    }
    onStatus(r,'answering');return next();
  });
  ctx.on('tools/execute',async(exec,next)=>{
    const r=current(exec.agent);if(!r || r.cancelled)return {isError:true,content:[{type:'text',text:'Request cancelled.'}]};
    let lease;
    try {lease=budget.claimTool({requestId:r.id,name:exec.name});}
    catch(e){return {isError:true,content:[{type:'text',text:e.message}],error:{message:e.message,info:{code:e.message}}};}
    calls.set(exec.token,{request:r,name:exec.name,callId:exec.callId});
    onStatus(r,exec.name==='web_search'?'searching':'reading',exec.callId);
    const original=exec.signal;exec.signal=AbortSignal.any([original,lease.signal]);
    try {
      const result=await next();
      if(lease.signal.aborted)return {isError:true,content:[{type:'text',text:'Web request timed out.'}]};
      return result;
    }finally{exec.signal=original;lease.finish();}
  });
  ctx.on('tools/result',(exec,result)=>{
    const call=calls.get(exec.token);calls.delete(exec.token);
    if(call && current(exec.agent)===call.request && !call.request.cancelled)onResult(call.request,call,result);
  });
  ctx.on('dispose',()=>calls.clear());
}
