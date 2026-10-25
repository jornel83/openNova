import {join} from 'node:path';
import {createResearchHttp} from './http.mjs';
import {createResearchExec,executionTool} from './exec.mjs';
import {createDerivations,derivationTool} from './derivation.mjs';
import {httpTool} from './http-tool.mjs';
import {randomUUID} from 'node:crypto';
import {publicResearchConfig,RESEARCH_TOOLS,DEFAULT_LIMITS} from './config.mjs';
import {researchInstructions} from './instructions.mjs';
import {createSources} from './sources.mjs';
import {projectResearchReply} from './reply.mjs';
import {createResearchBudget} from './budget.mjs';
import {withResearchSignal} from './policy.mjs';
export function researchFailure(error,result) {
 const message=String(error?.message||result?.error?.message||'');
 if(/budget_exhausted|duplicate_research_call|read_failures/.test(message)||['auth','rate_limited'].includes(message))return message;
 const code=result?.meta?.statusCode;
 if(/invalid_json|invalid_public_header|invalid_encoding|invalid_research|input_artifact_changed|invalid_observation/.test(message))return message;
 if(/body_unavailable/.test(message))return /title_only|encoding_error/.exec(message)?.[0]??'empty';
 if(error?.name==='AbortError'||/cancel/i.test(message))return 'cancelled';
 if(/timeout|timed.out/i.test(message))return 'timeout';
 if(code===401||code===402||/401|402|credential|api.key|insufficient.?balance|quota/i.test(message))return 'auth';
 if(code===429||/429|rate.limit/i.test(message))return 'rate_limited';
 if(code===403||/403|blocked|private|disallowed/i.test(message))return 'blocked';
 if(/unsupported|content.type/i.test(message))return 'unsupported';
 if(/empty|body_unavailable/i.test(message))return 'empty';
 return 'unavailable';
}
export function researchError(code){return {isError:true,error:{message:code,info:{code}},content:[{type:'text',text:`Research unavailable: ${code}. Use existing evidence, explain missing information; do not retry the same request or open a browser automatically.`}]};}
export function resultFailure(name,result){
 if(result.meta?.execution&&result.meta.execution.status!=='completed')return result.meta.execution.status==='cancelled'?'cancelled':result.meta.execution.status==='timed_out'?'timeout':result.meta.execution.httpFailures?'http_failed':'script_failed';
 if(result.meta?.receipt&&!result.meta.receipt.ok)return result.meta.receipt.error;
 if(result.isError||result.meta?.statusCode>=300)return researchFailure(undefined,result);
 if(name==='web_search'&&!(result.meta?.sources??result.value?.sources)?.length)return 'empty';
 if(name==='web_fetch'&&result.value?.body?.kind==='text'&&!result.value.body.content?.trim())return 'empty';
}
export function installResearch(ctx,{ops,requests,config={},transport}) {
 const active=new Map();
 const limits={...DEFAULT_LIMITS,...config.limits},budget=createResearchBudget({limits});
 const sources=createSources({ops,botId:config.botId,workspace:config.workspace});
 const http=transport?createResearchHttp({transport,sources,ops,artifactRoot:join(config.workspace,'output/research/requests')}):undefined;
 const executions=ctx.get?.('shell')?createResearchExec({shell:ctx.get('shell'),ops,...config}):undefined;
 const derivations=createDerivations({ops,sources});
 const valid=r=>requests.active===r&&!r.cancelled&&!r.signal.aborted;
 ctx.systemPrompt.context({name:'opennova-research',order:9910,required:true,interpolate:false,text:()=>researchInstructions({enabled:config.httpAvailable??config.available,searchAvailable:config.available,state:requests.active&&active.has(requests.active.id)?budget.snapshot(requests.active.id):undefined})});
 ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>{
  const result=await next(),r=requests.active;if(!r||!active.has(r.id))return result;
  const state=budget.snapshot(r.id);return {...result,tools:result.tools.filter(t=>!(state.closed&&RESEARCH_TOOLS.includes(t.name)&&t.name!=='research_derive')&&
   !(t.name==='web_search'&&(state.searchClosed||state.searchCalls>=limits.searchCalls))&&!(['web_fetch','web_request'].includes(t.name)&&(state.fetchClosed||state.fetchCalls>=limits.fetchCalls)))};
 });
 async function executeResearch(exec,next){
  if(!RESEARCH_TOOLS.includes(exec.name))return next();
  const r=requests.active;
  if(!r||!active.has(r.id)||!valid(r))return researchError('cancelled');
  if(exec.name==='web_search'?!config.available:!(config.httpAvailable??config.available))return researchError('unavailable');
  const record={id:randomUUID(),kind:'tool',operation:'research',tool:exec.name,requestId:r.id,callId:exec.callId,provider:exec.name==='web_search'?'deepseek':'opennova-http',status:'running',createdAt:Date.now(),description:({web_search:'后台联网搜索',web_fetch:'后台读取资料',web_request:'后台获取数据',research_exec:'运行研究脚本',research_derive:'记录脚本结果'})[exec.name]};
  ops.put(record);ops.finish(r.id,{research:{phase:({web_search:'searching',web_fetch:'reading',web_request:'requesting',research_exec:'processing',research_derive:'processing'})[exec.name],callId:exec.callId}});
  let lease;
  try{
   lease=exec.name==='research_derive'?{signal:r.signal,finish(){}}:budget.claim(r.id,{name:exec.name,args:exec.arguments,callId:exec.callId,signal:exec.signal});
   const result=await withResearchSignal(exec,lease.signal,exec.name==='web_request'?async()=>{
    const receipt=await http(exec.arguments,{requestId:r.id,callId:exec.callId,parentCallId:exec.parentCallId,origin:exec.origin,signal:exec.signal,valid:()=>valid(r)&&(!exec.valid||exec.valid())});
    return {isError:!receipt.ok,value:JSON.stringify(receipt),meta:{receipt,statusCode:receipt.statusCode},content:[{type:'text',text:JSON.stringify(receipt)}]};
   }:exec.name==='research_exec'?async()=>{
    const value=await executions.run(exec.arguments,{requestId:r.id,callId:exec.callId,signal:exec.signal});
    return {isError:value.status!=='completed',value:JSON.stringify(value),meta:{execution:value},content:[{type:'text',text:JSON.stringify(value)}]};
   }:exec.name==='research_derive'?async()=>{
    const value=derivations.record(exec.arguments,{requestId:r.id,callId:exec.callId,signal:exec.signal});
    return {isError:false,value:JSON.stringify(value),meta:{derivation:value},content:[{type:'text',text:JSON.stringify(value)}]};
   }:next);
   const code=!valid(r)?'cancelled':resultFailure(exec.name,result);
   const found=[];
   if(!code){
    const common={requestId:r.id,callId:exec.callId,status:'completed'};
    if(exec.name==='web_search')for(const source of (result.meta?.sources??result.value?.sources??[]).slice(0,5)){
     const s=sources.record({...common,...source,provider:'deepseek',query:source.query,queries:exec.arguments?.queries,excerpt:source.snippet,evidenceType:'search_summary'});if(s)found.push(s);
    }
    else if(exec.name==='web_request'){const receipt=result.meta.receipt;found.push(...sources.forRequest(r.id).filter(s=>s.observationId===receipt.observationId));}
    else if(exec.name==='web_fetch'){
     const value=result.value??{},s=sources.record({...common,url:result.meta?.url??value.url,requestedUrl:exec.arguments?.url,provider:'opennova-http',
      excerpt:value.body?.content??'',truncated:result.meta?.truncated??value.truncated,evidenceType:'page_body'});if(s)found.push(s);
    }
   }
   const execution=result.meta?.execution,receipt=result.meta?.receipt,derivation=result.meta?.derivation;
   const detail=execution?{command:execution.command,cwd:execution.cwd,exitCode:execution.exitCode,stdout:execution.stdout,stderr:execution.stderr,timedOut:execution.timedOut,httpFailures:execution.httpFailures,executionId:execution.id}:
    receipt?{http:{statusCode:receipt.statusCode,contentType:receipt.contentType,encoding:receipt.encoding,retrievedAt:receipt.retrievedAt,quality:receipt.quality},receiptId:receipt.receiptId}:{};
   const output=execution?[execution.stdout,execution.stderr].filter(Boolean).join('\n').slice(-12000):receipt?JSON.stringify(receipt):derivation?JSON.stringify(derivation):code?`检索未完成：${code}`:JSON.stringify(found.map(s=>({title:s.title,url:s.url,evidenceType:s.evidenceType})));
   ops.put({...record,...detail,status:code==='cancelled'?'cancelled':code?'failed':'completed',completedAt:Date.now(),elapsed_ms:Date.now()-record.createdAt,...code?{error:code}:{},sourceIds:found.map(s=>s.id),output});
   lease.finish({failed:!!code,code});
   if(valid(r))ops.finish(r.id,{research:{phase:'summarizing',outcome:code?'partial':'complete',callId:exec.callId,usage:budget.snapshot(r.id)}});
   return code?{...researchError(code),meta:result.meta}:result;
  }catch(error){
   const code=valid(r)?researchFailure(error):'cancelled';
   ops.put({...record,status:code==='cancelled'?'cancelled':'failed',error:code,completedAt:Date.now(),elapsed_ms:Date.now()-record.createdAt,output:`检索未完成：${code}`});
   lease?.finish({failed:true,code});
   if(valid(r))ops.finish(r.id,{research:{phase:'summarizing',outcome:'partial',callId:exec.callId,reason:code,usage:budget.snapshot(r.id)}});
   return researchError(code);
  }finally{lease?.finish();}
 }
 ctx.on('tools/execute',executeResearch);
 const sourceTool=['research_sources','回查已保存的检索来源和证据片段（不联网）。requestId/sourceIds 二选一；省略取最近已完成检索，历史证据不是最新天气。',
  {requestId:{type:'string'},sourceIds:{type:'array',items:{type:'string'}}},args=>{
   const r=requests.active;if(!r||!valid(r))throw Error('request_not_active');
   let rows;try{rows=sources.lookup(args);}catch(error){if(error.message!=='source_not_found'||!args.requestId||!derivations.forRequest(args.requestId).length)throw error;rows=[];}
   sources.use(r.id,rows);const id=args.requestId??rows.at(-1)?.requestId??ops.list('request').find(x=>x.status==='completed'&&derivations.forRequest(x.id).length)?.id;
   return {sources:rows,derivations:id?derivations.forRequest(id):[]};
  }];
 return {refresh:record=>record?.derivations?.length?{...record,derivations:derivations.forRequest(record.id)}:record,sourceTool,tools:[httpTool,executionTool,derivationTool],sources,derivations,
  async httpFromScript(body){return executions.http(body,async(args,context)=>{
   const r=requests.active;if(!r||r.id!==context.requestId||!valid(r))throw Error('execution_not_active');
   const result=await executeResearch({name:'web_request',arguments:args,...context},()=>{});
   return result.meta?.receipt??{ok:false,error:result.error?.info?.code??'unavailable'};
  });},reply:(text,id)=>projectResearchReply({text,requestId:id,sources,derivations,research:ops.request?.(id)?.research}),
  begin(r){active.set(r.id,r);budget.open(r.id,{signal:r.signal});},finish(id){budget.finish(id);active.delete(id);},health:()=>publicResearchConfig(config),async close(){budget.close();active.clear();await executions?.close();}};
}
