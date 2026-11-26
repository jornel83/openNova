import {errorEvent} from '../agent/errors.mjs';
import {routingAuthorization} from './projects/routing.mjs';

/** Native compaction is maintenance of an owned session, not a foreground turn. */
export function installModelGate(ctx,{rt,bot,getActive,isOwnedSession,onMaintenance=()=>{}}){
 ctx.on('llm/stream',(options,next)=>{
  const active=getActive();
  const routing=routingAuthorization(options);
  if(routing){
   if(active!==routing.active||active?.id!==routing.requestId||active.cancelled||active.signal?.aborted||routing.signal.aborted||
     options.signal!==routing.signal||options.sessionId!==undefined||options.purpose!==undefined||!Array.isArray(options.tools)||options.tools.length)throw Error('routing_request_required');
   if(options.provider!==routing.provider||options.model!==routing.model||options.provider!=='opennova-chatgpt'||options.model!=='gpt-6.1-sol')throw Error('bot_model_not_allowed');
   return next();
  }
  const owner=typeof options.sessionId==='string'?rt.selfOf?.(options.sessionId):undefined;
  if(owner&&owner!==bot.id)throw Error('team_task_admission_required');
  const owned=[bot.id,rt.chatOf(bot.id),...(bot.segments??[]).map(p=>p.sessionId)];
  const owns=typeof options.sessionId==='string'&&(isOwnedSession?isOwnedSession(options.sessionId):owned.includes(options.sessionId));
  const maintenance=options.purpose==='compaction'&&owns;
  if(options.purpose==='compaction'&&!maintenance)throw Error('bridge_request_required');
  const native=rt.ownRequest(options)&&owns;
  const bound=!isOwnedSession||active?.binding&&['work','daily','manage'].includes(active.binding.focus)&&owns;
  const foreground=bound&&active&&!active.cancelled&&!active.signal?.aborted&&options.sessionId===rt.chatOf(bot.id)&&options.purpose===undefined;
  if(!foreground&&!native&&!maintenance)throw Error('bridge_request_required');
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
