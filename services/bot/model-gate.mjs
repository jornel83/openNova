import {errorEvent} from '../agent/errors.mjs';

/** Native compaction is maintenance of an owned session, not a foreground turn. */
export function installModelGate(ctx,{rt,bot,getActive,onMaintenance=()=>{}}){
 ctx.on('llm/stream',(options,next)=>{
  const active=getActive();
  const owned=[bot.id,rt.chatOf(bot.id),...(bot.segments??[]).map(p=>p.sessionId)];
  const maintenance=options.purpose==='compaction'&&typeof options.sessionId==='string'&&owned.includes(options.sessionId);
  if(options.purpose==='compaction'&&!maintenance)throw Error('bridge_request_required');
  if((!active||active.cancelled)&&!rt.ownRequest(options)&&!maintenance)throw Error('bridge_request_required');
  if(options.provider!=='opennova-chatgpt'||options.model!=='gpt-6.1-sol')throw Error('bot_model_not_allowed');
  if(!maintenance)return next();
  return (async function*(){
   const started=Date.now(),base={stage:'context_maintenance',sessionId:options.sessionId};
   const report=value=>{try{onMaintenance({...base,...value,elapsedMs:Date.now()-started});}catch{}};
   let finish;
   report({status:'running'});
   try{
    options.signal?.throwIfAborted();
    for await(const chunk of next()){if(chunk.type==='finish')finish=chunk.reason;yield chunk;}
    if(finish?.kind==='stop')report({status:'completed'});
    else report({status:options.signal?.aborted||finish?.kind==='aborted'?'cancelled':'failed',diagnostic:errorEvent(finish?.failure??Error('incomplete_model_response'),'context_maintenance')});
   }catch(error){report({status:options.signal?.aborted?'cancelled':'failed',diagnostic:errorEvent(error,'context_maintenance')});throw error;}
  })();
 });
}
