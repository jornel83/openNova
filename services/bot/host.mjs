import {randomUUID} from 'node:crypto';
import {createVoiceChannel} from './desktop/voice.mjs';
import {createEvents} from './desktop/events.mjs';
/** Real DeepSeek-Bot runtime, with a small loopback adapter for OpenNova clients. */
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createDocumentOpener,createDocumentTool,inspectFileReference} from './desktop/documents.mjs';
import {createWorkContext} from './desktop/context.mjs';
import {createBrowserTools,requestContent} from './desktop/tools.mjs';
import {Operations} from './operations.mjs';
import {researchTools} from './research/config.mjs';
import {createContentFetcher} from '../agent/web-fetch-content.mjs';
import {installResearch} from './research/runtime.mjs';
import {Requests} from './requests.mjs';
import {MemoryApprovals} from './memory.mjs';
import {admitText,withoutNativeChannel,ownResources} from './lifecycle.mjs';
import {createBridge} from './http.mjs';
import {createControls} from './controls.mjs';
import {ALLOWED_TOOLS,INSTRUCTIONS} from './policy.mjs';
import {completedReply} from '../agent/result.mjs';
import {bindProject,settleBot,cancelBot,staleRequest,auditTool,recoverToolRuns,PROJECT_TOOLS,TURN_TIMEOUT_MS} from './project.mjs';

export const name='opennova-bot-spike';
export const inject=['llm','tools','systemPrompt','sessionController','sessions','sessionTitle','workspaceRegistry','workingDirectory','permissionPresets','connection'];
export const textResult=value=>({isError:false,value:JSON.stringify(value),content:[{type:'text',text:JSON.stringify(value)}]});

export async function apply(ctx,config) {
  const resources=ownResources(ctx);
  try {
  const {createRuntime}=await import(pathToFileURL(join(config.plugin,'index.js')).href);
  const {cleanEntry,cleanTopic}=await import(pathToFileURL(join(config.plugin,'src/host/memory.js')).href);
  const {defineTool}=await import(pathToFileURL(join(config.harnessRoot,'packages/core/tools/lib/index.js')).href);
  const {createUserMessage}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')).href);
  resources.assertOpen();
  const rt=createRuntime(withoutNativeChannel(ctx),{home:join(config.home,'bot'),workspace:config.workspace,mainName:'OpenNova',mainRole:'个人助手',memoryReview:false,timeZone:'Asia/Shanghai',browser:false});
  // Recovery is explicit in this experiment; upstream model-driven resume could
  // recreate tasks after a crash. Durable task/approval state remains queryable.
  const deliver=rt.deliver;
  rt.deliver=args=>(args.resumed||args.resent)?Promise.resolve():deliver(args);
  await rt.bootstrap();resources.assertOpen();if(rt.readOnly())throw Error('bot_home_already_owned');
  const bot=rt.botOf(rt.state.mainBotIds[0]);
  rt.dropKickoff(bot.id);bot.model='opennova-chatgpt/gpt-6.1-sol';bot.instructions=INSTRUCTIONS;
  await rt.save();await rt.applyModel(bot);resources.assertOpen();
  await bindProject(ctx,rt,bot,config.workspace);resources.assertOpen();
  const events=createEvents();
  resources.add(()=>events.close());
  const voice=createVoiceChannel({events});
  resources.add(()=>voice.close());
  let requests;
  const ops=new Operations({...config,events,getRequestId:()=>requests?.active?.id});
  recoverToolRuns(ops);
  resources.add(()=>ops.close());
  const syncRetired=()=>writeFileSync(join(config.home,'retired.json'),JSON.stringify(ops.retired()));
  syncRetired();
  const allowed=new Set(researchTools(ALLOWED_TOOLS,config.research)),approved=new WeakSet();
  const context=createWorkContext({inspectFile:inspectFileReference,initial:ops.list('context')[0]?.value,
    onChange:value=>{ops.put({id:'work-context',kind:'context',value});events.publish('work.context',value);}});
  const documents=createDocumentOpener({workspace:config.workspace,ops,context});
  let desktop;const runtimeId=randomUUID();
  requests=new Requests(ops,run,{context,events});
  resources.add(()=>requests.close());
  const transport=(await createContentFetcher(config.harnessRoot)).transport;
  const research=installResearch(ctx,{ops,requests,transport,config:{...config.research,botId:bot.id,workspace:config.workspace}});
  resources.add(()=>research.close());
  const memory=new MemoryApprovals(ops,{
    cleanEntry,cleanTopic,
    view:()=>rt.memoryEndpoint('memory-view',{botId:bot.id}),
    context:async()=>{const agent=await rt.resolveAgent(rt.chatOf(bot.id));return {messageIds:agent.session.deriveMessages().map(m=>m.id)};},
    execute:async(tool,args,callerSignal)=>{
      const timeout=AbortSignal.timeout(15000),signal=callerSignal?AbortSignal.any([callerSignal,timeout]):timeout;
      const agent=await rt.resolveAgent(rt.chatOf(bot.id));
      signal.throwIfAborted();
      approved.add(signal);
      try {
        const result=await ctx.tools.execute({name:tool,arguments:args,callId:'approval-'+Date.now(),agent,signal});
        if(result.isError)throw Error('memory_apply_failed: '+(result.error?.code||'unknown_tool_error'));
        return result.content?.filter(b=>b.type==='text').map(b=>b.text).join('')||'';
      }finally{approved.delete(signal);}
    },
    invalidate:async()=>{
      syncRetired();
      for(const id of new Set([bot.id,rt.chatOf(bot.id),...(bot.segments??[]).map(x=>x.sessionId)]))rt.renewMemory(id);
    },
  });
  const moduleTools=[
    research.sourceTool,...research.tools,
    createDocumentTool({opener:documents,getRequest:()=>requests.active}),
    ...createBrowserTools({context,ops,getRequest:()=>requests.active,bridge:{execute:(...args)=>desktop?desktop.execute(...args):Promise.resolve({status:'failed',error:'browser_not_enabled'})}}),
    ['start_test_task','启动用于验证重连的独立计时任务，持续 1 到 120 秒；不是实际计算作业。',{label:{type:'string',required:true},seconds:{type:'number',required:true}},a=>ops.startTask(a.label,Math.round(a.seconds*1000))],
    ['task_status','查询计时任务的真实状态',{id:{type:'string',required:true}},a=>ops.task(a.id)],
    ['cancel_test_task','用户明确要求取消时，取消指定计时任务',{id:{type:'string',required:true}},a=>ops.cancelTask(a.id)],
  ];
  for(const [name,description,parameters,execute] of moduleTools)ctx.effect(()=>ctx.tools.register(defineTool({name,description,parameters,output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},async execute(a){return JSON.stringify(await execute(a));}})));
  ctx.tools.guard(exec=>allowed.has(exec.name)?undefined:'Tool is outside the OpenNova experiment scope.');
  ctx.on('agent/pre-step',(payload,next)=>staleRequest(payload.messages,requests.active)?{kind:'reject'}:next(),{prepend:true});
  ctx.on('system-prompt/assemble',async(assembly,context,next)=>{const result=await next();return {...result,tools:result.tools.filter(t=>allowed.has(t.name))};});
  ctx.systemPrompt.context({name:'opennova-experiment',order:9900,required:true,interpolate:false,text:()=>INSTRUCTIONS});
  ctx.on('llm/stream',(options,next)=>{
    if((!requests.active||requests.active.cancelled)&&!rt.ownRequest(options))throw Error('bridge_request_required');
    if(options.provider!=='opennova-chatgpt'||options.model!=='gpt-6.1-sol')throw Error('bot_model_not_allowed');
    return next();
  });
  ctx.on('tools/execute',async(exec,next)=>{
    if(['remember','forget'].includes(exec.name)&&!approved.has(exec.signal))return textResult(await memory.mutate(exec.name,exec.arguments,exec.signal));
    if(requests.active)ops.finish(requests.active.id,{phase:'tool',tool:exec.name});
    if(PROJECT_TOOLS.includes(exec.name))return auditTool(ops,exec,next,{cwd:ctx.workingDirectory.get(exec.agent.session),requestId:requests.active?.id});
    return next();
  });
  ctx.on('session/event',(session,event)=>{
    const active=requests.active;
    if(!active||![active.sessionId,rt.chatOf(bot.id)].includes(session.id))return;
    if(session.id!==active.sessionId){active.sessionId=session.id;active.events=[];}
    if(event.type==='user/message'&&event.data?.source?.rpcId===active.id)active.started=true;
    if(active.started)active.events.push(event);
  });
  async function run(record,active) {
    const controller=active.controller;
    research.begin(active);
    const cancel=async()=>{
      controller.abort();
      await cancelBot(rt,bot);
    };
    active.cancel=cancel;
    const timeout=setTimeout(()=>{active.timedOut=true;void requests.cancel(record.id).catch(()=>{});},TURN_TIMEOUT_MS);
    try {
      await settleBot(rt,bot,controller.signal);
      if(active.cancelled)return;
      const sessionId=rt.chatOf(bot.id);
      active.sessionId=sessionId;
      const agent=await admitText({active,resolve:()=>rt.resolveAgent(sessionId),message:createUserMessage({content:requestContent(record),source:{kind:'user',rpcId:record.id,clientTimeZone:'Asia/Shanghai'}})});
      active.cancel=cancel;
      if(!agent)return;
      ops.finish(record.id,{status:'running',sessionId,startedAt:Date.now()});
      await settleBot(rt,bot,controller.signal);
      const events=active.events;
      if(active.cancelled)return;
      const final=events.findLast(e=>e.type==='assistant/message')?.data?.message?.content?.filter(b=>b.type==='text').map(b=>b.text).join('');
      const text=completedReply({events,finalResponse:final});
      return {...research.reply(text,record.id),sessionId:rt.chatOf(bot.id),elapsed_ms:Date.now()-record.createdAt};
    }catch(error){
      const end=active?.events.findLast(e=>e.type==='turn/end');
      console.error('Bot turn failure',JSON.stringify({code:error.message,reason:end?.data?.reason?.kind,failureCode:end?.data?.reason?.error?.code}));
      throw error;
    }
    finally{clearTimeout(timeout);research.finish(record.id);}
  }
  ops.recoverDirectFiles();
  await memory.recover();
  resources.assertOpen();
  const handle=createControls({ops,requests,memory,context,documents,events,voice,browserState:()=>desktop?.status()??{connected:false},
    desktopOpen:()=>desktop?desktop.handle('/desktop/open',{activate:true}):Promise.reject(Error('browser_not_enabled')),
    health:()=>({research:research.health(),runtimeId,desktopEnabled:!!desktop,ready:!requests.closed,model:bot.model,botId:bot.id,sessionId:rt.chatOf(bot.id),workspace:config.workspace,permission:bot.permission,projectTools:PROJECT_TOOLS,turnTimeoutMs:TURN_TIMEOUT_MS,outputMode:'settled-answer',executionMode:'direct',webUrl:config.webAssets?config.url:undefined}),
    memoryView:()=>rt.memoryEndpoint('memory-view',{botId:bot.id}),
    shutdown:()=>{setTimeout(()=>process.kill(process.pid,'SIGTERM'),100);return {stopping:true};},
  });
  const server=createBridge({token:readFileSync(config.tokenPath,'utf8').trim(),
    handle:(path,body)=>path.startsWith('/desktop/')&&desktop?desktop.handle(path,body):handle(path,body),
    extension:(req,res)=>desktop?.handleHttp(req,res),web:config.webAssets?{assets:config.webAssets,events}:undefined});
  if(config.desktop){
    const {createDesktop}=await import('./desktop/controller.mjs');
    desktop=createDesktop({server,home:config.home,chatUrl:config.url+'/',context});
  }
  resources.add(async()=>{requests.closed=true;await desktop?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,'127.0.0.1',resolve);});
  resources.assertOpen();
  console.log(`OpenNova Bot bridge ready on 127.0.0.1:${config.port}; bot ${bot.id}`);
  }catch(error){await resources.close();throw error;}
}
