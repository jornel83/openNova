/** Per-Run credentials authorize only that Run's runtime routes, never Bot controls. */
import {createHash,timingSafeEqual} from 'node:crypto';
const paths=new Set(['/task-runtime/admission','/task-runtime/check','/task-runtime/tool']);
export function createTaskRuntimeBridge({tasks,actors,hostTools,foregroundBusy}){
  function authorize(body,token){
    const task=tasks.row('task',body.taskId),run=tasks.row('run',body.runId);
    const actual=Buffer.from(createHash('sha256').update(token).digest('hex')),expected=Buffer.from(run.toolTokenHash??'');
    if(!token||expected.length!==actual.length||!timingSafeEqual(actual,expected))throw Error('task_runtime_unauthorized');
    if(tasks.closed||task.policyVersion!==2||task.status!=='running'||run.status!=='running'||task.runId!==run.id||run.taskId!==task.id||run.assignmentVersion!==task.assignmentVersion||body.assignmentVersion!==task.assignmentVersion)throw Error('task_runtime_stale');
    return {task,run};
  }
  return async function handle(req,res){
    if(!req.url?.startsWith('/task-runtime/'))return false;
    const reply=(status,value)=>{if(!res.destroyed&&!res.writableEnded){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}};
    if(!paths.has(req.url)||req.method!=='POST'||req.headers.origin){reply(403,{error:'task_runtime_unauthorized'});return true;}
    const controller=new AbortController();let interval,actor;
    const closed=()=>{if(!res.writableEnded)controller.abort(Error('task_runtime_disconnected'));};res.on('close',closed);
    try{
      const chunks=[];let bytes=0;
      for await(const chunk of req){bytes+=chunk.length;if(bytes>100000)throw Error('request_too_large');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
      const token=(req.headers.authorization??'').startsWith('Bearer ')?req.headers.authorization.slice(7):'';
      const {task,run}=authorize(body,token);
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]);
      actor=actors?.issue({kind:'worker',botId:task.assignedBotId,taskId:task.id,runId:run.id,assignmentVersion:run.assignmentVersion,request:{id:run.id,signal}});
      if(actor)actors.check(actor,task.id);
      interval=setInterval(()=>{try{authorize(body,token);if(actor)actors.check(actor,task.id);}catch(error){controller.abort(error);}},100);interval.unref();
      let result;
      if(req.url==='/task-runtime/admission')result={foregroundBusy:!!foregroundBusy()};
      else if(req.url==='/task-runtime/check'){
        if(task.permission!=='full')throw Error('task_tool_denied');
        result=tasks.createCheck({...body,taskId:task.id,runId:run.id});
      }
      else{
        if(task.permission!=='full'||!hostTools)throw Error('task_tool_denied');
        result=await hostTools.invoke({task,run,name:body.name,args:body.args,actionId:body.actionId,signal});
      }
      reply(200,result);
    }catch(error){reply(400,{error:String(error.message||'task_runtime_error').slice(0,200)});}
    finally{clearInterval(interval);res.off('close',closed);if(actor)actors.revoke(actor);}
    return true;
  };
}
