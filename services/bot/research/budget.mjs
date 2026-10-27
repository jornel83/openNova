import {DEFAULT_LIMITS} from './config.mjs';
import {canonicalUrl} from './sources.mjs';
import {normalizeHttpRequest} from './http.mjs';
/** Counts observed network operations. Ordinary engineering Shell stays independent. */
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
  open(id,{signal}={}){if(requests.has(id))throw Error('request_already_active');const r={parent:signal,start:null,searchQueries:0,readCalls:0,researchExecCalls:0,seen:new Set(),leases:new Set(),timers:[],closed:false};
   r.abort=()=>{for(const lease of r.leases)lease.controller.abort(signal.reason);};signal?.addEventListener('abort',r.abort,{once:true});requests.set(id,r);},
  claim(id,{name,args={},kind,units=1,key,callId,signal,timeoutMs}){
   const r=check(get(id));if(r.closed)throw Error('budget_exhausted');
   kind??=name==='web_search'?'search':['web_fetch','web_request'].includes(name)?'read':name==='research_exec'?'exec':undefined;
   if(!['search','read','exec'].includes(kind))throw Error('unsupported_research_tool');
   if(kind==='search'&&r.searchClosed)throw Error(r.searchReason);
   let keys;
   if(name==='web_search'){
    if(!Array.isArray(args.queries)||!args.queries.length||args.queries.length>2||args.queries.some(q=>typeof q!=='string'||!q.trim()))throw Error('invalid_research_queries');
    units=args.queries.length;keys=args.queries.map(q=>'search:'+q.trim().toLowerCase());
   }else if(name==='web_request')keys=['read:'+JSON.stringify(normalizeHttpRequest(args))];
   else if(name==='web_fetch')keys=['page:'+JSON.stringify(normalizeHttpRequest({url:canonicalUrl(args.url)}))];
   else keys=[kind+':'+(key??JSON.stringify(args))];
   if(!Number.isInteger(units)||units<1)throw Error('invalid_research_units');
   if(new Set(keys).size!==keys.length||keys.some(k=>r.seen.has(k)))throw Error('duplicate_research_call');
   const count=kind==='search'?'searchQueries':kind==='read'?'readCalls':'researchExecCalls';
   const cap=kind==='search'?limits.searchCalls:kind==='read'?limits.fetchCalls:limits.execCalls;
   if(r[count]+units>cap)throw Error('budget_exhausted');
   r[count]+=units;for(const k of keys)r.seen.add(k);
   if(r.start===null){r.start=now();r.timers.push(timers.setTimeout(()=>{r.closed=true;r.reason='budget_exhausted';},limits.softMs),
    timers.setTimeout(()=>{r.closed=true;r.reason='budget_exhausted';for(const lease of r.leases)lease.controller.abort(Error('budget_exhausted'));},limits.webMs));}
   const controller=new AbortController(),perCall=kind==='search'?limits.searchMs:kind==='read'?limits.fetchMs:Math.min(timeoutMs??args.timeoutMs??limits.execMs,limits.webMs);
   const timer=timers.setTimeout(()=>controller.abort(Error('timeout')),Math.min(perCall,limits.webMs-(now()-r.start)));
   let finished=false;const lease={controller,signal:AbortSignal.any([r.parent,signal,controller.signal].filter(Boolean)),callId,
    finish({code}={}){if(finished)return;finished=true;timers.clearTimeout(timer);r.leases.delete(lease);if(kind==='search'&&['auth','rate_limited'].includes(code)){r.searchClosed=true;r.searchReason=code;}}};
   r.leases.add(lease);return lease;
  },
  snapshot(id){const r=get(id);if(!r.parent?.aborted)check(r);return {searchQueries:r.searchQueries,readCalls:r.readCalls,researchExecCalls:r.researchExecCalls,
   searchCalls:r.searchQueries,fetchCalls:r.readCalls,elapsedMs:r.start===null?0:Math.round(now()-r.start),closed:r.closed,searchClosed:!!r.searchClosed,
   ...r.searchReason?{searchReason:r.searchReason}:{},fetchClosed:r.readCalls>=limits.fetchCalls,...r.reason?{reason:r.reason}:{},networkCoverage:'observed_calls_only'};},
  finish,close(){for(const id of [...requests.keys()])finish(id);},
 };
}
