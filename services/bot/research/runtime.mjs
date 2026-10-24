import {randomUUID} from 'node:crypto';
import {publicResearchConfig,RESEARCH_TOOLS} from './config.mjs';
import {researchInstructions} from './instructions.mjs';
import {createSources} from './sources.mjs';
import {projectResearchReply} from './reply.mjs';
export function researchFailure(error,result) {
 const message=String(error?.message||result?.error?.message||'');
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
 const sources=createSources({ops,botId:config.botId,workspace:config.workspace});
 const valid=r=>requests.active===r&&!r.cancelled&&!r.signal.aborted;
 ctx.systemPrompt.context({name:'opennova-research',order:9910,required:true,interpolate:false,text:()=>researchInstructions({enabled:config.available})});
 ctx.on('tools/execute',async(exec,next)=>{
  if(!RESEARCH_TOOLS.includes(exec.name))return next();
  const r=requests.active;
  if(!r||!active.has(r.id)||!valid(r))return researchError('cancelled');
  if(!config.available)return researchError('unavailable');
  const record={id:randomUUID(),kind:'tool',operation:'research',tool:exec.name,requestId:r.id,callId:exec.callId,provider:'deepseek',status:'running',createdAt:Date.now(),description:exec.name==='web_search'?'后台联网搜索':'后台读取资料'};
  ops.put(record);ops.finish(r.id,{research:{phase:exec.name==='web_search'?'searching':'reading',callId:exec.callId}});
  try{
   const result=await next();
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
   if(valid(r))ops.finish(r.id,{research:{phase:'summarizing',outcome:code?'partial':'complete',callId:exec.callId}});
   return code?researchError(code):result;
  }catch(error){
   const code=valid(r)?researchFailure(error):'cancelled';
   ops.put({...record,status:code==='cancelled'?'cancelled':'failed',error:code,completedAt:Date.now(),elapsed_ms:Date.now()-record.createdAt,output:`检索未完成：${code}`});
   return researchError(code);
  }
 });
 const sourceTool=['research_sources','回查已保存的检索来源和证据片段（不联网）。requestId/sourceIds 二选一；省略取最近已完成检索，历史证据不是最新天气。',
  {requestId:{type:'string'},sourceIds:{type:'array',items:{type:'string'}}},args=>{
   const r=requests.active;if(!r||!valid(r))throw Error('request_not_active');
   const rows=sources.lookup(args);sources.use(r.id,rows);return {sources:rows};
  }];
 return {sourceTool,sources,reply:(text,id)=>projectResearchReply({text,requestId:id,sources,research:ops.request?.(id)?.research}),begin:r=>active.set(r.id,r),finish:id=>active.delete(id),health:()=>publicResearchConfig(config),close:()=>active.clear()};
}
