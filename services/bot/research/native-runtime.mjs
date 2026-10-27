import {randomUUID} from 'node:crypto';
import {publicResearchConfig} from './config.mjs';
import {researchInstructions} from './instructions.mjs';
import {createSources} from './sources.mjs';
import {createDerivations} from './derivation.mjs';
import {projectResearchReply} from './reply.mjs';

const NETWORK_TOOLS=new Set(['web_search','web_fetch']);
const textOf=content=>(content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
const phaseOf=name=>name==='web_search'?'searching':'reading';
function argumentsOf(value){
 try{const args=typeof value==='string'?JSON.parse(value):value;return args&&typeof args==='object'&&!Array.isArray(args)?args:{};}catch{return {};}
}

/** Read-only projection of native session events; never intercepts tool execution. */
export function installNativeResearch(ctx,{ops,requests,config={},onObservationError=()=>{}}){
 const states=new Map(),pending=new Map();
 const sources=createSources({ops,botId:config.botId,workspace:config.workspace});
 const derivations=createDerivations({ops,sources}); // Read compatibility for historical results.
 const valid=r=>requests.active===r&&!r.cancelled&&!r.signal.aborted&&states.has(r.id);
 const observe=(fn,fallback)=>{try{return fn();}catch(error){try{onObservationError(error);}catch{}return fallback?.();}};
 ctx.systemPrompt.context({name:'opennova-research',order:9910,required:true,interpolate:false,
  text:()=>researchInstructions({enabled:config.httpAvailable??config.available,searchAvailable:config.available})});
 function publish(r){
  if(!valid(r))return;
  const state=states.get(r.id),running=[...pending.values()].filter(p=>p.request===r);
  ops.finish(r.id,{research:{mode:'native',phase:running.length?phaseOf(running.at(-1).record.tool):'summarizing',callId:running.at(-1)?.record.callId??state.lastCallId,
   outcome:state.failures?'partial':'complete',usage:{searchCalls:state.searchCalls,fetchCalls:state.fetchCalls,elapsedMs:Date.now()-state.startedAt}}});
 }
 ctx.on('session/event',(session,event)=>observe(()=>{
  const r=requests.active;
  if(!r||!valid(r)||r.started===false||session.id!==r.sessionId)return;
  const data=event.data??{},state=states.get(r.id);
  if(event.type==='tool/call'&&NETWORK_TOOLS.has(data.name)){
   const key=session.id+':'+data.callId;if(pending.has(key))return;
   const record={id:randomUUID(),kind:'tool',operation:'research',tool:data.name,requestId:r.id,callId:data.callId,
    provider:data.name==='web_search'?'deepseek':'http',status:'running',createdAt:Date.now(),
    description:data.name==='web_search'?'后台联网搜索':'后台读取资料'};
   pending.set(key,{record,request:r,args:argumentsOf(data.arguments)});
   state.lastCallId=data.callId;
   if(data.name==='web_search')state.searchCalls++;else state.fetchCalls++;
   ops.put(record);publish(r);
  }else if(event.type==='tool/result'){
   const message=data.message??{},key=session.id+':'+message.toolCallId,item=pending.get(key);
   if(!item||item.request!==r)return;
   if(item.resultRecord){ops.put(item.resultRecord);pending.delete(key);publish(r);return;}
   const {record,args}=item,meta=data.meta??{},output=textOf(message.content),httpFailure=meta.statusCode!==undefined&&(meta.statusCode<200||meta.statusCode>=300);
   const failed=!!message.isError||httpFailure,found=[];
   if(failed)state.failures++;
   else if(record.tool==='web_search'){
    for(const source of meta.sources??[]){
     const s=observe(()=>sources.record({requestId:r.id,callId:record.callId,status:'completed',provider:'deepseek',...source,
      queries:args.queries,excerpt:source.snippet,evidenceType:source.snippet?.trim()?'search_summary':'search_link'}));
     if(s)found.push(s);
    }
   }else if(meta.url){
    const s=observe(()=>sources.record({requestId:r.id,callId:record.callId,status:'completed',provider:'http',url:meta.url,
     requestedUrl:args.url,statusCode:meta.statusCode,truncated:meta.truncated,excerpt:output,evidenceType:'page_response'}));
    if(s)found.push(s);
   }
   item.resultRecord={...record,status:failed?'failed':'completed',completedAt:Date.now(),elapsed_ms:Date.now()-record.createdAt,
    sourceIds:found.map(s=>s.id),output:output.slice(0,12000),...(meta.statusCode===undefined?{}:{http:{statusCode:meta.statusCode}}),
    ...(failed?{error:output.slice(0,1200)||`HTTP ${meta.statusCode}`,errorCode:data.error?.code??(httpFailure?'HTTP_'+meta.statusCode:undefined)}:{})};
   ops.put(item.resultRecord);pending.delete(key);
   publish(r);
  }
 }));
 function finish(id){
  for(const [key,item] of pending){if(item.request.id!==id)continue;pending.delete(key);
   observe(()=>ops.put(item.resultRecord??{...item.record,status:item.request.signal.aborted||item.request.cancelled?'cancelled':'interrupted',completedAt:Date.now()}));
  }
  states.delete(id);
 }
 const sourceTool=['research_sources','回查已保存的来源和历史脚本结果（不联网）。requestId/sourceIds 二选一；省略取最近已完成检索。历史信息不代表最新数据。',
  {requestId:{type:'string'},sourceIds:{type:'array',items:{type:'string'}}},args=>{
   const r=requests.active;if(!r||!valid(r))throw Error('request_not_active');
   let rows;try{rows=sources.lookup(args);}catch(error){if(error.message!=='source_not_found'||!args.requestId||!derivations.forRequest(args.requestId).length)throw error;rows=[];}
   sources.use(r.id,rows);const id=args.requestId??rows.at(-1)?.requestId;
   return {sources:rows,derivations:id?derivations.forRequest(id):[]};
  }];
 return {sourceTool,tools:[],sources,
  begin(r){states.set(r.id,{startedAt:Date.now(),searchCalls:0,fetchCalls:0,failures:0});},finish,
  refresh:record=>observe(()=>record?.derivations?.length?{...record,derivations:derivations.forRequest(record.id)}:record,()=>record),
  reply:(text,id)=>observe(()=>projectResearchReply({text,requestId:id,sources,derivations,research:ops.request?.(id)?.research}),
   ()=>projectResearchReply({text,requestId:id,sources:{forReply:()=>[]}})),
  health:()=>publicResearchConfig(config),close(){for(const id of states.keys())finish(id);},
 };
}
