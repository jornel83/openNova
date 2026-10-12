import {WEB_LIMITS} from './web-config.mjs';
/** One bounded turn; counts are taken synchronously before any asynchronous dispatch. */
export function createWebBudget({limits={},now=()=>performance.now()}={}) {
  limits={...WEB_LIMITS,...limits};const requests=new Map();
  const check=id=>{
    const r=requests.get(id);if(!r)throw Error('request_not_active');
    if(now()-r.started>=limits.requestMs || r.controller.signal.aborted)throw Error('agent_timeout');return r;
  };
  const elapsed=r=>r.spent+[...r.active].reduce((n,l)=>n+now()-l.started,0);
  const schedule=r=>{
    clearTimeout(r.webTimer);
    if(r.active.size)r.webTimer=setTimeout(()=>{for(const l of r.active)l.controller.abort(Error('web_time_budget'));},Math.max(0,(limits.webMs-elapsed(r))/r.active.size));
  };
  return {
    get size(){return requests.size;},
    startRequest(id) {
      if(requests.has(id))throw Error('request_already_active');
      const controller=new AbortController(),r={started:now(),controller,counts:{},models:0,spent:0,active:new Set()};
      r.timer=setTimeout(()=>controller.abort(Error('agent_timeout')),limits.requestMs);requests.set(id,r);return {signal:controller.signal};
    },
    claimModel(id) {const r=check(id);if(++r.models>limits.modelCalls)throw Error('model_budget_exceeded');},
    claimTool({requestId,name}) {
      const r=check(requestId);
      if(!['web_search','web_fetch'].includes(name))throw Error('unsupported_tool');
      if(elapsed(r)>=limits.webMs)throw Error('web_time_budget');
      const search=name==='web_search', count=(r.counts[name]??0)+1;
      if(count>(search?limits.searchCalls:limits.fetchCalls))throw Error('tool_budget_exceeded');r.counts[name]=count;
      const controller=new AbortController(),lease={started:now(),controller};
      r.active.add(lease);const timer=setTimeout(()=>controller.abort(Error('web_tool_timeout')),search?limits.searchMs:limits.fetchMs);lease.timer=timer;schedule(r);
      return {signal:AbortSignal.any([r.controller.signal,controller.signal]),finish(){
        if(!r.active.delete(lease))return;clearTimeout(timer);r.spent+=now()-lease.started;schedule(r);
      },dispose(){clearTimeout(timer);controller.abort();}};
    },
    finishRequest(id) {
      const r=requests.get(id);if(!r)return;requests.delete(id);clearTimeout(r.timer);clearTimeout(r.webTimer);
      r.controller.abort();for(const l of r.active){clearTimeout(l.timer);l.controller.abort();}r.active.clear();
    },
  };
}
