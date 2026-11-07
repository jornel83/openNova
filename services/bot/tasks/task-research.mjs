/** Native web tools with a source journal owned by one durable employee task. */
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Operations} from '../operations.mjs';
import {publicResearchConfig,researchTools} from '../research/config.mjs';
import {researchPlugins} from '../research/plugins.mjs';
import {installNativeResearch} from '../research/native-runtime.mjs';
import {saveJson} from './agent-files.mjs';

export const name='opennova-task-research';
export const inject=['tools','systemPrompt'];

// Secrets stay in the child's environment, never the persisted plugin patch.
export function taskResearchPlugins({harnessRoot,research={}}){
  return researchPlugins({harnessRoot,enabled:research.httpAvailable??research.available,searchAvailable:research.available,mode:'native'});
}
export function taskResearchTools(research={}){return researchTools([],{...research,mode:'native'});}

export function installTaskResearch(ctx,config){
  if(config.policyVersion!==2)throw Error('task_research_requires_current_policy');
  const controller=new AbortController(),active={id:config.runId,sessionId:config.sessionId,signal:controller.signal,started:true,cancelled:false};
  const ops=new Operations({home:join(config.agentHome,'research'),workspace:config.workspace});
  let closed=false,observationFailed=false;
  ops.submit(active.id,config.goal||'后台任务联网资料', 'task');
  ops.finish(active.id,{status:'running',taskId:config.taskId,sessionId:config.sessionId,startedAt:Date.now()});
  const observationError=()=>{observationFailed=true;};
  const runtime=installNativeResearch(ctx,{ops,requests:{active},config:{...publicResearchConfig({...config.research,mode:'native'}),
    botId:'task:'+config.taskId,workspace:config.workspace},onObservationError:observationError});
  runtime.begin(active);
  const persist=()=>{
    try{saveJson(join(config.runDir,'research.json'),{runId:config.runId,taskId:config.taskId,sources:runtime.sources.forRequest(active.id),
      research:{...(ops.request(active.id).research??{}),mode:'native',observationFailed}});}
    catch{observationError();}
  };
  ctx.systemPrompt.context({name:'opennova-task-research-scope',order:9911,required:true,interpolate:false,text:()=>
    '联网资料与来源记录仅属于当前任务，research_sources 可回查同一任务之前轮次。仅使用本轮实际提供的工具。'+
    (config.permission==='read-only'?'当前为只读权限：可搜索和读取网页，不得写文件、运行命令或修改外部内容。':'需要执行处理脚本时使用 task_command，成果写入当前任务工作目录。')});
  ctx.on('session/event',(session,event)=>{
    if(closed||session.id!==active.sessionId)return;
    if(event.type==='turn/start')ops.finish(active.id,{status:'running'});
    if(event.type==='turn/end'){
      const reason=event.data?.reason?.kind;
      if(reason==='aborted'){active.cancelled=true;controller.abort();runtime.finish(active.id);}
      ops.finish(active.id,{status:reason==='completed'?'completed':reason==='aborted'?'cancelled':'failed',completedAt:Date.now()});
    }
    // The native observer is registered first and has recorded this event.
    if(['tool/result','turn/end'].includes(event.type))persist();
  });
  const [tool,description,parameters,lookup]=runtime.sourceTool;
  const sourceTool=[tool,description,parameters,args=>{
    if(closed||controller.signal.aborted)throw Error('task_research_closed');
    // Within an unfinished run, an omitted selector should include newly read
    // sources; subsequent runs fall back to the last completed task request.
    const implicit=args.requestId===undefined&&args.sourceIds===undefined;
    const result=lookup(implicit&&runtime.sources.forRequest(active.id).length?{requestId:active.id}:args);
    persist();return result;
  }];
  persist();
  return {sourceTool,ops,runtime,close(){
    if(closed)return;closed=true;
    const status=ops.request(active.id).status;
    if(status==='running'){active.cancelled=true;controller.abort();ops.finish(active.id,{status:'cancelled',completedAt:Date.now()});}
    runtime.close();persist();ops.close();
  }};
}

export async function apply(ctx,config){
  const {defineTool}=await import(pathToFileURL(join(config.harnessRoot,'packages/core/tools/lib/index.js')));
  const scope=installTaskResearch(ctx,config);
  ctx.effect(()=>()=>scope.close());
  const [tool,description,parameters,execute]=scope.sourceTool;
  ctx.effect(()=>ctx.tools.register(defineTool({name:tool,description,parameters,
    output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},
    execute:async(args,exec)=>{
      if((exec.agent?.session?.id??exec.agent?.id)!==config.sessionId)throw Error('task_session_mismatch');
      exec.signal?.throwIfAborted();return JSON.stringify(execute(args));
    }})));
}
