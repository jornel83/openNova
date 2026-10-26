/** Native Harness project tools; this bridge records outcomes, never replays commands. */
import {realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

export const PROJECT_TOOLS=['glob','grep','read','write','edit','bash'];
export const PROJECT_PLUGINS=[
  {id:'agent-instructions',name:'@deepseek-ai/dsh-agent-instructions',config:{maxBytes:65536}},
  {id:'tool-fs',name:'@deepseek-ai/dsh-tool-fs'},
  {id:'tool-fs-search',name:'@deepseek-ai/dsh-tool-fs-search',config:{sampleOverCapGlobResults:false}},
  {id:'tool-bash',name:'@deepseek-ai/dsh-tool-bash',config:{enableRunInBackground:false,promoteOnTimeout:false}},
];
export const TURN_TIMEOUT_MS=600000;

export async function bindProject(ctx,rt,bot,path){
  const cwd=realpathSync(path);
  const workspace=await ctx.workspaceRegistry.resolveByPath(cwd)??await ctx.workspaceRegistry.create(cwd,'OpenNova');
  rt.state.workspaceId=workspace.id;
  bot.workDir=cwd; // Upstream uses this for future conversation parts, too.
  await rt.setPermission(bot,'danger-full-access');
  await rt.save();
  // Bot owns immutable per-part cwd: use its native handoff so old messages
  // remain available in history and future steps do not repeatedly switch parts.
  await rt.followFolder(bot.id);
  await settleBot(rt,bot);
  return cwd;
}

export async function settleBot(rt,bot,signal){
  const deadline=AbortSignal.any([AbortSignal.timeout(TURN_TIMEOUT_MS),...(signal?[signal]:[])]);
  for(;;){
    deadline.throwIfAborted();
    while([...rt.switchJobs()].some(job=>job.botId===bot.id))await delay(25,undefined,{signal:deadline});
    const id=rt.chatOf(bot.id),agent=await rt.resolveAgent(id);
    await new Promise((resolve,reject)=>{
      const abort=()=>reject(deadline.reason);
      deadline.addEventListener('abort',abort,{once:true});
      agent.whenIdle().then(resolve,reject).finally(()=>deadline.removeEventListener('abort',abort));
      if(deadline.aborted)abort();
    });
    if(id===rt.chatOf(bot.id)&&![...rt.switchJobs()].some(job=>job.botId===bot.id))return agent;
  }
}

export async function cancelBot(rt,bot){
  const seen=new Set();
  for(;;){
    seen.add(bot.id);seen.add(rt.chatOf(bot.id));
    for(const part of bot.segments??[])seen.add(part.sessionId);
    const switching=[...rt.switchJobs()].filter(job=>job.botId===bot.id);
    // Cancel the work still owned by the old part as well as the new one.
    // Discard input that has not yet been forwarded by the native handoff.
    for(const job of switching)job.carry.splice(0);
    const ids=[...seen],resolved=await Promise.allSettled(ids.map(id=>rt.resolveAgent(id)));
    const agents=resolved.filter(r=>r.status==='fulfilled').map(r=>r.value);
    for(const agent of agents)agent.cancel({kind:'user'});
    await Promise.all(agents.map(agent=>agent.whenIdle()));
    // Missing archived history must not prevent cancellation of the live part.
    // A missing current part is different: retain admission so cleanup can retry.
    const live=resolved[ids.indexOf(rt.chatOf(bot.id))];
    if(live?.status==='rejected')throw Error('cancel_cleanup_failed');
    await delay(25);
    if(![...rt.switchJobs()].some(job=>job.botId===bot.id)&&seen.has(rt.chatOf(bot.id))){
      const current=await rt.resolveAgent(rt.chatOf(bot.id));current.cancel({kind:'user'});await current.whenIdle();return;
    }
  }
}

// Forwarded native handoffs retain the original request source. A late message
// from a cancelled request must never borrow a later request's authority.
export function staleRequest(messages,active){
  return messages.some(m=>m.source?.rpcId&&(!active||active.cancelled||m.source.rpcId!==active.id));
}

function filePreview(result){
  const v=result.value,large=(v.before?.length??0)>64000||(v.after?.length??0)>64000;
  if(!large)return {beforeContent:v.before,content:v.after,previewValid:true};
  const diffs=[];let size=0;
  for(const d of result.meta?.diffs??[]){const n=(d.oldText?.length??0)+(d.newText?.length??0);if(size+n>64000)break;diffs.push(d);size+=n;}
  return {diffs,previewValid:diffs.length>0,previewTruncated:true};
}

const clip=(text,max=24000)=>typeof text==='string'?(text.length>max?'[前文已省略]\n'+text.slice(-max):text):'';
export async function auditTool(ops,exec,next,{cwd,requestId}={}){
  const a=exec.arguments||{},file=['write','edit'].includes(exec.name);
  const record={id:randomUUID(),kind:'tool',operation:exec.name==='bash'?'shell':file?'file':'read',executionMode:'direct',
    tool:exec.name,callId:exec.callId,requestId,cwd,status:'running',createdAt:Date.now(),
    ...(a.file_path?{path:a.file_path}:{}),...(exec.name==='bash'?{command:clip(a.command),description:clip(a.description,1000)}:{})};
  ops.put(record);
  try{
    const result=await next(),v=result.value??{};
    let status=result.isError?'failed':file?'applied':'completed';
    if(exec.name==='bash'&&!result.isError)status=v.aborted?'cancelled':v.timedOut?'timed_out':v.exitCode===0?'completed':'failed';
    const details=exec.name==='bash'?{cwd:v.cwd??cwd,exitCode:v.exitCode??null,stdout:clip(v.stdout?.text),stderr:clip(v.stderr?.text),
      stdoutPath:v.stdout?.spillPath,stderrPath:v.stderr?.spillPath,timeoutMs:v.timeoutMs}:
      file&&!result.isError?{path:v.path??a.file_path,...filePreview(result)}:{};
    if(exec.signal?.aborted&&status!=='applied')status='cancelled';
    ops.put({...record,...details,status,completedAt:Date.now(),output:clip(result.content?.filter(b=>b.type==='text').map(b=>b.text).join('\n')),
      ...(result.isError?{error:clip(result.error?.message||result.error?.code||'tool_failed',1000)}:{})});
    return result;
  }catch(error){
    ops.put({...record,status:exec.signal?.aborted?'cancelled':'failed',completedAt:Date.now(),error:clip(error.message,1000)});
    throw error;
  }
}

export function recoverToolRuns(ops){
  for(const r of ops.list('tool'))if(r.status==='running')ops.put({...r,status:'interrupted',completedAt:Date.now(),error:'宿主中断，操作结果待核对；未自动重跑。'});
}
