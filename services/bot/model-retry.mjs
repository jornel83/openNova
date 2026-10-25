import {errorEvent} from '../agent/errors.mjs';

/** Observe native retries; scheduling, cancellation and history stay owned by DSH. */
export function installModelRetryObserver(ctx,{ops,requests,onRetry=()=>{}}){
  ctx.on('session/event',(session,event)=>{
    const active=requests.active,data=event.data??{};
    if(!active?.started||session.id!==active.sessionId)return;
    const previous=ops.request(active.id).modelRetry;
    let retry;
    if(event.type==='llm/retry'){
      if(active.cancelled||data.provider!=='opennova-chatgpt'||data.failure?.status!==503)return;
      retry={status:'waiting',retryId:data.retryId,turn:data.turn,step:data.step,
        retry:data.retry,maxRetries:data.maxRetries,delayMs:data.delayMs,
        diagnostic:errorEvent(data.failure,'conversation')};
    }else if(previous&&data.turn===previous.turn){
      if(event.type==='llm/retry-started'&&data.retryId===previous.retryId&&data.retry===previous.retry&&!active.cancelled)
        retry={...previous,status:'requesting'};
      else if(event.type==='assistant/message'&&data.step===previous.step&&!data.interrupted)
        retry={...previous,status:'recovered'};
      else if(event.type==='turn/end'&&['waiting','requesting'].includes(previous.status))
        retry={...previous,status:active.cancelled?'cancelled':data.reason?.kind==='completed'?'recovered':data.reason?.kind==='error'?'failed':'cancelled'};
    }
    if(!retry)return;
    retry.updatedAt=Date.now();
    ops.finish(active.id,{modelRetry:retry});
    onRetry({bridgeRequestId:active.id,sessionId:session.id,...retry});
  });
}
