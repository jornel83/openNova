import {DEFAULT_LIMITS} from './config.mjs';
import {canonicalUrl} from './sources.mjs';
/** Per-request Web limits only. A research deadline never aborts its parent task. */
export function createResearchBudget({limits={},now=()=>performance.now(),timers={setTimeout,clearTimeout}}={}){
 limits={...DEFAULT_LIMITS,...limits};const requests=new Map();
 const get=id=>{const r=requests.get(id);if(!r)throw Error('request_not_active');return r;};
 function check(r){
  r.parent?.throwIfAborted();
  if(r.start!==null&&now()-r.start>=limits.softMs){r.closed=true;r.reason='budget_exhausted';}
  if(r.start!==null&&now()-r.start>=limits.webMs)for(const lease of r.leases)lease.controller.abort(Error('budget_exhausted'));
  return r;
 }
 function finish(id){const r=requests.get(id);if(!r)return;requests.delete(id);for(const timer of r.timers)timers.clearTimeout(timer);r.parent?.removeEventListener('abort',r.abort);
  for(const lease of [...r.leases]){lease.controller.abort(Error('cancelled'));lease.finish();}}
 return {
  open(id,{signal}={}){if(requests.has(id))throw Error('request_already_active');const r={parent:signal,start:null,searchCalls:0,fetchCalls:0,failedReads:0,seen:new Set(),leases:new Set(),timers:[],closed:false};
   r.abort=()=>{for(const lease of r.leases)lease.controller.abort(signal.reason);};signal?.addEventListener('abort',r.abort,{once:true});requests.set(id,r);},
  claim(id,{name,args={},callId}){
   const r=check(get(id));if(r.closed)throw Error('budget_exhausted');
   const search=name==='web_search';if(search&&r.searchClosed)throw Error(r.searchReason);if(!search&&name!=='web_fetch')throw Error('unsupported_research_tool');
   if(!search&&r.failedReads>=2)throw Error('read_failures');
   const key=search?'search:'+JSON.stringify((args.queries??[]).map(q=>String(q).trim().toLowerCase())):'fetch:'+canonicalUrl(args.url);
   if(r.seen.has(key))throw Error('duplicate_research_call');
   const count=search?'searchCalls':'fetchCalls',cap=limits[count];if(r[count]>=cap)throw Error('budget_exhausted');
   r[count]++;r.seen.add(key);
   if(r.start===null){r.start=now();r.timers.push(timers.setTimeout(()=>{r.closed=true;r.reason='budget_exhausted';},limits.softMs),
    timers.setTimeout(()=>{r.closed=true;r.reason='budget_exhausted';for(const lease of r.leases)lease.controller.abort(Error('budget_exhausted'));},limits.webMs));}
   const controller=new AbortController();const timer=timers.setTimeout(()=>controller.abort(Error('timeout')),Math.min(search?limits.searchMs:limits.fetchMs,limits.webMs-(now()-r.start)));
   let finished=false;const lease={controller,signal:r.parent?AbortSignal.any([r.parent,controller.signal]):controller.signal,callId,
    finish({failed=false,code}={}){if(finished)return;finished=true;timers.clearTimeout(timer);r.leases.delete(lease);if(search&&['auth','rate_limited'].includes(code)){r.searchClosed=true;r.searchReason=code;}if(!search)r.failedReads=failed?r.failedReads+1:0;}};
   r.leases.add(lease);return lease;
  },
  snapshot(id){const r=get(id);if(!r.parent?.aborted)check(r);return {searchCalls:r.searchCalls,fetchCalls:r.fetchCalls,elapsedMs:r.start===null?0:Math.round(now()-r.start),closed:r.closed,searchClosed:!!r.searchClosed,...r.searchReason?{searchReason:r.searchReason}:{},fetchClosed:r.failedReads>=2,...r.reason?{reason:r.reason}:{}};},
  finish,close(){for(const id of [...requests.keys()])finish(id);},
 };
}
