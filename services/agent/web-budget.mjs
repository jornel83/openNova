import {WEB_LIMITS} from './web-config.mjs';
/** One bounded turn; counts are taken synchronously before any asynchronous dispatch. */
export function createWebBudget({limits={},now=()=>performance.now()}={}) {
  limits={...WEB_LIMITS,...limits};const requests=new Map();
  const check=id=>{
    const r=requests.get(id);if(!r)throw Error('request_not_active');
    if(!r.controller.signal.aborted) {
      if(now()-r.started>=limits.requestMs)r.controller.abort(Error('agent_timeout'));
      else if(r.webStarted!==undefined && now()-r.webStarted>=limits.webMs)r.controller.abort(Error('web_time_budget'));
    }
    if(r.controller.signal.aborted)throw r.controller.signal.reason;return r;
  };
  return {
    get size(){return requests.size;},
    shouldFinalize(id) {
      const r=check(id);
      // Leave a model request and 15 seconds inside the existing hard deadline for the answer.
      return r.models>=limits.modelCalls-1 || (r.webStarted!==undefined &&
        (limits.webMs-(now()-r.webStarted)<=15000 ||
         (r.counts.web_search>=limits.searchCalls && r.counts.web_fetch>=limits.fetchCalls)));
    },
    startRequest(id) {
      if(requests.has(id))throw Error('request_already_active');
      const controller=new AbortController(),r={started:now(),controller,counts:{},models:0,active:new Set()};
      r.timer=setTimeout(()=>controller.abort(Error('agent_timeout')),limits.requestMs);requests.set(id,r);return {signal:controller.signal};
    },
    claimModel(id) {const r=check(id);if(++r.models>limits.modelCalls)throw Error('model_budget_exceeded');},
    claimTool({requestId,name}) {
      const r=check(requestId);
      if(!['web_search','web_fetch'].includes(name))throw Error('unsupported_tool');
      const search=name==='web_search', count=(r.counts[name]??0)+1;
      if(count>(search?limits.searchCalls:limits.fetchCalls))throw Error('tool_budget_exceeded');r.counts[name]=count;
      if(r.webStarted===undefined) {
        r.webStarted=now();
        // This deadline stays active through model reasoning and gaps between tools.
        r.webTimer=setTimeout(()=>r.controller.abort(Error('web_time_budget')),limits.webMs);
      }
      const controller=new AbortController(),lease={controller};
      r.active.add(lease);const timer=setTimeout(()=>controller.abort(Error('web_tool_timeout')),search?limits.searchMs:limits.fetchMs);lease.timer=timer;
      return {signal:AbortSignal.any([r.controller.signal,controller.signal]),finish(){
        if(!r.active.delete(lease))return;clearTimeout(timer);
      },dispose(){clearTimeout(timer);controller.abort();}};
    },
    finishRequest(id) {
      const r=requests.get(id);if(!r)return;requests.delete(id);clearTimeout(r.timer);clearTimeout(r.webTimer);
      r.controller.abort();for(const l of r.active){clearTimeout(l.timer);l.controller.abort();}r.active.clear();
    },
  };
}
