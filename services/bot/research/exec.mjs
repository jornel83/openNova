import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';

/** Native Harness Shell with a per-execution context for observed HTTP calls. */
export function createResearchExec({shell,ops,workspace,home,port}){
 const active=new Map();
 async function run(args,{requestId,callId,signal}){
  if(typeof args.command!=='string'||!args.command.trim()||args.command.length>30000)throw Error('invalid_research_command');
  if(args.timeoutMs!==undefined&&(!Number.isInteger(args.timeoutMs)||args.timeoutMs<1||args.timeoutMs>90000))throw Error('invalid_research_timeout');
  if(args.workdir!==undefined&&typeof args.workdir!=='string')throw Error('invalid_research_workdir');
  signal?.throwIfAborted();
  const id=randomUUID(),outputDirectory=join(workspace,'output/research/requests',requestId,id);
  mkdirSync(outputDirectory,{recursive:true,mode:0o700});
  const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const item={id,requestId,callId,controller,signal:combined,pending:new Set(),httpFailures:0};active.set(id,item);
  const record={id,kind:'research_execution',requestId,callId,command:args.command,cwd:resolve(workspace,args.workdir??'.'),outputDirectory,status:'running',createdAt:Date.now()};ops.put(record);
  try{
   const spec=shell.resolve({command:args.command,workdir:record.cwd,timeoutMs:args.timeoutMs??45000,onExpiry:'kill',stdoutMaxBytes:12000,signal:combined,
    env:{OPENNOVA_RESEARCH_EXECUTION_ID:id,OPENNOVA_RESEARCH_OUTPUT_DIR:outputDirectory,OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(port)}});
   item.process=await shell.execute(spec);const result=await item.process.result();
   // Revoke helper access before settling; pending network operations are cancelled and joined.
   active.delete(id);controller.abort(Error('execution_finished'));await Promise.allSettled([...item.pending]);
   const status=result.aborted||signal?.aborted?'cancelled':result.timedOut?'timed_out':result.exitCode!==0||item.httpFailures?'failed':'completed';
   const final={...record,status,exitCode:result.exitCode,signal:result.signal,timedOut:result.timedOut,aborted:result.aborted,httpFailures:item.httpFailures,
    stdout:result.stdout.text.slice(-12000),stderr:result.stderr.text.slice(-12000),stdoutPath:result.stdout.spillPath,stderrPath:result.stderr.spillPath,completedAt:Date.now()};
   ops.put(final);return final;
  }catch(error){const final={...record,status:combined.aborted?'cancelled':'failed',error:error.message,httpFailures:item.httpFailures,completedAt:Date.now()};ops.put(final);return final;}
  finally{active.delete(id);controller.abort(Error('execution_finished'));if(item.process){item.process.kill();await item.process.done;}await Promise.allSettled([...item.pending]);}
 }
 async function http({executionId,request},execute){
  const item=active.get(executionId);if(!item||item.signal.aborted)throw Error('execution_not_active');
  const valid=()=>active.get(executionId)===item&&!item.signal.aborted;
  const promise=Promise.resolve().then(()=>execute(request,{requestId:item.requestId,callId:randomUUID(),parentCallId:item.callId,signal:item.signal,origin:'shell-helper',valid}));
  item.pending.add(promise);
  try{const receipt=await promise;if(!valid())throw Error('execution_not_active');if(!receipt.ok)item.httpFailures++;return receipt;}
  catch(error){item.httpFailures++;throw error;}
  finally{item.pending.delete(promise);}
 }
 return {run,http,async close(){const items=[...active.values()];for(const item of items)item.controller.abort(Error('cancelled'));await Promise.allSettled(items.flatMap(item=>[item.process?.done,...item.pending]));active.clear();}};
}

export const executionTool=['research_exec','运行研究脚本，支持自主取数与数据处理。使用 node tools/research/http.mjs --url URL 自动记录 HTTP 来源。结果文件写入 $OPENNOVA_RESEARCH_OUTPUT_DIR，完成后可用 research_derive 登记结果；普通 curl 输出不会自动成为已读取接口来源。',
 {command:{type:'string',required:true},workdir:{type:'string'},timeoutMs:{type:'number'}},()=>{throw Error('research_middleware_required');}];
