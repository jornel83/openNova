/** Harness hooks only: Harness still owns model requests, tool execution, history and cancellation. */
export const name='opennova-web-policy';
export const inject=['tools'];
export function apply(ctx,{budget,current,active=()=>current(),onStatus=()=>{},onResult=()=>{},onFailure=()=>{}}) {
  const calls=new Map();
  const finishing=r=>r&&(r.finalizing ||= (r.failedReads??0)>=2 || budget.shouldFinalize(r.id));
  ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>{
    const assembly=await next(),r=active();
    return r&&!r.cancelled&&finishing(r)?{...assembly,tools:[]}:assembly;
  });
  ctx.systemPrompt?.context({name:'opennova:retrieval-state',order:9100,required:true,interpolate:false,text:()=>{
    const r=active();
    return r?.finalizing?'本轮检索已结束，工具已关闭。现在直接给最终答复：只报告已有来源支持的信息，缺失部分说明未查到；不要猜测数据，不要因检索失败而重复追问用户已明确的条件。':'';
  }});
  ctx.on('agent/request',async({agent,step},next)=>{
    const r=current(agent);if(!r || r.cancelled)throw Error('request_not_active');
    try {budget.claimModel(r.id);}catch(e){onFailure(r,e.message);throw e;}
    r.step=step;
    if(!r.abortListener) {
      r.abortListener=()=>{onFailure(r,r.signal.reason?.message==='web_time_budget'?'web_time_budget':'agent_timeout');agent.cancel({kind:'user'});};
      r.signal.addEventListener('abort',r.abortListener,{once:true});
    }
    onStatus(r,'answering');return next();
  });
  ctx.on('tools/execute',async(exec,next)=>{
    const r=current(exec.agent);if(!r || r.cancelled)return {isError:true,content:[{type:'text',text:'Request cancelled.'}]};
    const blocked=()=>({isError:true,content:[{type:'text',text:'Retrieval finished. Use existing results or explain missing evidence; do not retry this request.'}]});
    if(finishing(r))return blocked();
    let key;
    if(exec.name==='web_fetch'&&typeof exec.arguments?.url==='string'){
      try{const url=new URL(exec.arguments.url);url.hash='';key=`fetch:${url.href}`;}catch{/* native validation reports invalid URLs */}
    }else if(exec.name==='web_search'&&Array.isArray(exec.arguments?.queries))key=`search:${JSON.stringify(exec.arguments.queries.map(q=>String(q).trim().toLowerCase()))}`;
    r.seenTools??=new Set();
    if(key&&r.seenTools.has(key)){r.finalizing=true;return blocked();}
    if(key)r.seenTools.add(key);
    let lease;
    try {lease=budget.claimTool({requestId:r.id,name:exec.name});}
    catch(e){return {isError:true,content:[{type:'text',text:e.message}],error:{message:e.message,info:{code:e.message}}};}
    calls.set(exec.token,{request:r,name:exec.name,callId:exec.callId});
    onStatus(r,exec.name==='web_search'?'searching':'reading',exec.callId);
    const original=exec.signal;exec.signal=AbortSignal.any([original,lease.signal]);
    try {
      let result=await next();
      if(lease.signal.aborted)result={isError:true,content:[{type:'text',text:'Web request timed out.'}]};
      if(exec.name==='web_fetch')r.failedReads=(result.isError || result.meta?.statusCode>=400)?(r.failedReads??0)+1:0;
      return result;
    }finally{exec.signal=original;lease.finish();}
  });
  ctx.on('tools/result',(exec,result)=>{
    const call=calls.get(exec.token);calls.delete(exec.token);
    if(call && current(exec.agent)===call.request && !call.request.cancelled)onResult(call.request,call,result);
  });
  ctx.on('dispose',()=>calls.clear());
}
