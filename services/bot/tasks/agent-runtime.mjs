/** Private text-only SDK transport for one durable OpenNova task session.
 * Uses the public Agent create/resume factory; upstream SDK creates fresh sessions.
 * Profile launch, persistence, tools, and the Agent loop remain Harness-owned.
 */
import {readJson} from './agent-files.mjs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
export const name='opennova-task-runtime';
export const inject=['agents','sessionPersistence','llm'];
export async function apply(ctx,config){
  const lib=path=>import(pathToFileURL(join(config.harnessRoot,path,'lib/index.js')));
  const [{JsonRpcLineTransport},{createUserMessage}]=await Promise.all([lib('packages/sdk/protocol'),lib('packages/llm/llm')]);
  const transport=new JsonRpcLineTransport(process.stdin,process.stdout);
  let handle,initialization,closing;
  const close=()=>closing??=(async()=>{await initialization?.catch(()=>{});await handle?.dispose();})();
  ctx.on('session/event',(session,event)=>{if(session.id===config.sessionId)transport.notify('session.event',{sessionId:session.id,event});});
  ctx.on('agent/status',({agent,status})=>{if(agent.session.id===config.sessionId)transport.notify('session.status',{sessionId:config.sessionId,status});});
  transport.onRequest(async(method,params)=>{
    if(method==='initialize'){
      if(closing)throw Error('task_runtime_stopping');
      initialization??=(async()=>{
        await ctx.get('loader')?.await();
        if(readJson(join(config.runDir,'agent-ready.json'))?.runId!==config.runId)throw Error('task_policy_not_ready');
        if(params.provider!=='opennova-chatgpt'||params.model!=='gpt-6.1-sol'||params.cwd!==config.workspace)throw Error('task_runtime_route_mismatch');
        const agentOptions={provider:params.provider,model:params.model};
        await ctx.llm.resolveCallConfig(agentOptions);
        handle=await ctx.sessionPersistence.stat(config.sessionId)
          ?await ctx.agents.resume({resumeSessionId:config.sessionId,agentOptions})
          :await ctx.agents.create({sessionId:config.sessionId,meta:{cwd:config.workspace},agentOptions});
        return {serverInfo:{name:'opennova-task-runtime',version:'1'}};
      })();return initialization;
    }
    if(method==='shutdown'){
      await close();setImmediate(()=>{void (async()=>{await transport.flush();await ctx.root.fiber.dispose();process.exit(0);})().catch(()=>process.exit(1));});return {};
    }
    if(closing||!handle)throw Error('task_runtime_not_ready');
    if(params?.sessionId!==config.sessionId)throw Error('task_session_mismatch');
    if(method==='session/prompt'){
      if(!Array.isArray(params.contentBlocks)||!params.contentBlocks.length||params.contentBlocks.some(b=>b.type!=='text'||typeof b.text!=='string'))throw Error('task_text_required');
      const message=createUserMessage({content:params.contentBlocks,source:{kind:'user'}});
      handle.agent.followup(message);return {messageId:message.id};
    }
    throw Error('unsupported_task_runtime_method');
  });
  ctx.effect(()=>{transport.start();return async()=>{await close();transport.close();};});
}
