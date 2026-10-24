import {randomUUID} from 'node:crypto';
import {publicResearchConfig,RESEARCH_TOOLS,DEFAULT_LIMITS} from './config.mjs';
import {researchInstructions} from './instructions.mjs';
import {createSources} from './sources.mjs';
import {projectResearchReply} from './reply.mjs';
import {createResearchBudget} from './budget.mjs';
import {withResearchSignal} from './policy.mjs';
export function researchFailure(error,result) {
 const message=String(error?.message||result?.error?.message||'');
 if(/budget_exhausted|duplicate_research_call|read_failures/.test(message))return message;
 const code=result?.meta?.statusCode;
 if(error?.name==='AbortError'||/cancel/i.test(message))return 'cancelled';
 if(/timeout|timed.out/i.test(message))return 'timeout';
 if(code===401||/401|402|credential|api.key/i.test(message))return 'auth';
 if(code===429||/429|rate.limit/i.test(message))return 'rate_limited';
 if(code===403||/403|blocked|private|disallowed/i.test(message))return 'blocked';
 if(/unsupported|content.type/i.test(message))return 'unsupported';
 if(/empty|body_unavailable/i.test(message))return 'empty';
 return 'unavailable';
}
export function researchError(code){return {isError:true,error:{message:code,info:{code}},content:[{type:'text',text:`Research unavailable: ${code}. Use existing evidence, explain missing information; do not retry the same request or open a browser automatically.`}]};}
export function resultFailure(name,result){
 if(result.isError||result.meta?.statusCode>=300)return researchFailure(undefined,result);
 if(name==='web_search'&&!(result.meta?.sources??result.value?.sources)?.length)return 'empty';
 if(name==='web_fetch'&&result.value?.body?.kind==='text'&&!result.value.body.content?.trim())return 'empty';
}
export function installResearch(ctx,{ops,requests,config={}}) {
 const active=new Map();
 const limits={...DEFAULT_LIMITS,...config.limits},budget=createResearchBudget({limits});
 const sources=createSources({ops,botId:config.botId,workspace:config.workspace});
 const valid=r=>requests.active===r&&!r.cancelled&&!r.signal.aborted;
 ctx.systemPrompt.context({name:'opennova-research',order:9910,required:true,interpolate:false,text:()=>researchInstructions({enabled:config.available,state:requests.active&&active.has(requests.active.id)?budget.snapshot(requests.active.id):undefined})});
 ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>{
  const result=await next(),r=requests.active;if(!r||!active.has(r.id))return result;
  const state=budget.snapshot(r.id);return {...result,tools:result.tools.filter(t=>!(state.closed&&RESEARCH_TOOLS.includes(t.name))&&
   !(t.name==='web_search'&&state.searchCalls>=limits.searchCalls)&&!(t.name==='web_fetch'&&(state.fetchClosed||state.fetchCalls>=limits.fetchCalls)))};
 });
 ctx.on('tools/execute',async(exec,next)=>{
  if(!RESEARCH_TOOLS.includes(exec.name))return next();
  const r=requests.active;
  if(!r||!active.has(r.id)||!valid(r))return researchError('cancelled');
  if(!config.available)return researchError('unavailable');
  const record={id:randomUUID(),kind:'tool',operation:'research',tool:exec.name,requestId:r.id,callId:exec.callId,provider:'deepseek',status:'running',createdAt:Date.now(),description:exec.name==='web_search'?'后台联网搜索':'后台读取资料'};
  ops.put(record);ops.finish(r.id,{research:{phase:exec.name==='web_search'?'searching':'reading',callId:exec.callId}});
  let lease;
  try{
   lease=budget.claim(r.id,{name:exec.name,args:exec.arguments,callId:exec.callId});
   const result=await withResearchSignal(exec,lease.signal,next);
   const code=!valid(r)?'cancelled':resultFailure(exec.name,result);
   const found=[];
   if(!code){
    const common={requestId:r.id,callId:exec.callId,status:'completed'};
    if(exec.name==='web_search')for(const source of (result.meta?.sources??result.value?.sources??[]).slice(0,5)){
     const s=sources.record({...common,...source,provider:'deepseek',query:exec.arguments?.queries?.[0],excerpt:source.snippet,evidenceType:'search_summary'});if(s)found.push(s);
    }
    else {
     const value=result.value??{},s=sources.record({...common,url:result.meta?.url??value.url,requestedUrl:exec.arguments?.url,provider:'opennova-http',
      excerpt:value.body?.content??'',truncated:result.meta?.truncated??value.truncated,evidenceType:'page_body'});if(s)found.push(s);
    }
   }
   ops.put({...record,status:code==='cancelled'?'cancelled':code?'failed':'completed',completedAt:Date.now(),elapsed_ms:Date.now()-record.createdAt,...code?{error:code}:{},sourceIds:found.map(s=>s.id),output:code?`检索未完成：${code}`:JSON.stringify(found.map(s=>({title:s.title,url:s.url,evidenceType:s.evidenceType}))) });
   lease.finish({failed:!!code});
   if(valid(r))ops.finish(r.id,{research:{phase:'summarizing',outcome:code?'partial':'complete',callId:exec.callId,usage:budget.snapshot(r.id)}});
   return code?researchError(code):result;
  }catch(error){
   const code=valid(r)?researchFailure(error):'cancelled';
   ops.put({...record,status:code==='cancelled'?'cancelled':'failed',error:code,completedAt:Date.now(),elapsed_ms:Date.now()-record.createdAt,output:`检索未完成：${code}`});
   lease?.finish({failed:true});
   if(valid(r))ops.finish(r.id,{research:{phase:'summarizing',outcome:'partial',callId:exec.callId,reason:code,usage:budget.snapshot(r.id)}});
   return researchError(code);
  }finally{lease?.finish();}
 });
 const sourceTool=['research_sources','回查已保存的检索来源和证据片段（不联网）。requestId/sourceIds 二选一；省略取最近已完成检索，历史证据不是最新天气。',
  {requestId:{type:'string'},sourceIds:{type:'array',items:{type:'string'}}},args=>{
   const r=requests.active;if(!r||!valid(r))throw Error('request_not_active');
   const rows=sources.lookup(args);sources.use(r.id,rows);return {sources:rows};
  }];
 return {sourceTool,sources,reply:(text,id)=>projectResearchReply({text,requestId:id,sources,research:ops.request?.(id)?.research}),
  begin(r){active.set(r.id,r);budget.open(r.id,{signal:r.signal});},finish(id){budget.finish(id);active.delete(id);},health:()=>publicResearchConfig(config),close(){budget.close();active.clear();}};
}
