import {randomUUID} from 'node:crypto';
import {publicResearchConfig,RESEARCH_TOOLS} from './config.mjs';
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
export function installResearch(ctx,{ops,requests,config={}}) {
 const active=new Map();
 const valid=r=>requests.active===r&&!r.cancelled&&!r.signal.aborted;
 ctx.on('tools/execute',async(exec,next)=>{
  if(!RESEARCH_TOOLS.includes(exec.name))return next();
  const r=requests.active;
  if(!r||!active.has(r.id)||!valid(r))return researchError('cancelled');
  if(!config.available)return researchError('unavailable');
  const record={id:randomUUID(),kind:'tool',operation:'research',tool:exec.name,requestId:r.id,callId:exec.callId,provider:'deepseek',status:'running',createdAt:Date.now(),description:exec.name==='web_search'?'后台联网搜索':'后台读取资料'};
  ops.put(record);ops.finish(r.id,{research:{phase:exec.name==='web_search'?'searching':'reading',callId:exec.callId}});
  try{
   const result=await next();
   const code=!valid(r)?'cancelled':result.isError||result.meta?.statusCode>=400?researchFailure(undefined,result):undefined;
   ops.put({...record,status:code==='cancelled'?'cancelled':code?'failed':'completed',completedAt:Date.now(),elapsed_ms:Date.now()-record.createdAt,...code?{error:code}:{},output:code?`检索未完成：${code}`:'检索完成'});
   if(valid(r))ops.finish(r.id,{research:{phase:'summarizing',outcome:code?'partial':'complete',callId:exec.callId}});
   return code?researchError(code):result;
  }catch(error){
   const code=valid(r)?researchFailure(error):'cancelled';
   ops.put({...record,status:code==='cancelled'?'cancelled':'failed',error:code,completedAt:Date.now(),elapsed_ms:Date.now()-record.createdAt,output:`检索未完成：${code}`});
   return researchError(code);
  }
 });
 return {begin:r=>active.set(r.id,r),finish:id=>active.delete(id),health:()=>publicResearchConfig(config),close:()=>active.clear()};
}
