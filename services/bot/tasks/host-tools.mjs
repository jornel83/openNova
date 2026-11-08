/** Task-owned references and durable receipts for the shared desktop resource. */
import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {createWorkContext} from '../desktop/context.mjs';
import {createBrowserTools} from '../desktop/tools.mjs';
import {createDocumentOpener,createDocumentTool,inspectFileReference} from '../desktop/documents.mjs';
import {readJson} from './agent-files.mjs';
import {resolveTaskPath} from './filesystem.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const idOk=value=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value);
const browserNames=['nova_show','browser_open','browser_read','browser_click','browser_fill','browser_scroll','browser_close'];
export const HOST_TOOL_NAMES=[...browserNames,'document_open'];
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
export function hostToolDefinitions(){
  return [...createBrowserTools({}),createDocumentTool({})].map(([name,description,parameters])=>name==='browser_close'
    ?[name,'关闭本任务已取得引用的工作标签页（scope=tab）。后台员工不关闭共享工作窗口，保留总管、其他任务的页面和语音。',{...parameters,scope:{...parameters.scope,enum:['tab']}}]
    :[name,description,parameters]);
}

export function createTaskHostTools({tasks,ops,bridge,foregroundBusy=()=>false,documentFactory=createDocumentOpener,timeoutMs=60000}){
  const db=ops.db,contexts=new Map(),inflight=new Map(),queue=[];
  let active=null,owner=null,closed=false,pumping=false;
  db.exec('CREATE TABLE IF NOT EXISTS task_host_action (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS task_host_context (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS task_host_record (task_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(task_id,id))');
  const getAction=id=>{const row=db.prepare('SELECT body FROM task_host_action WHERE id=?').get(id);return row?JSON.parse(row.body):null;};
  const putAction=value=>{db.prepare('INSERT INTO task_host_action VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(value.id,JSON.stringify(value));return value;};
  // A lost acknowledgement never permits a second click, submission or open.
  for(const row of db.prepare('SELECT body FROM task_host_action').all()){
    const value=JSON.parse(row.body);
    if(value.status==='running')putAction({...value,status:'settled',result:{status:'unknown',error:'host_restarted_after_dispatch'},finishedAt:Date.now()});
  }
  function taskOps(taskId){return {
    put(record){db.prepare('INSERT INTO task_host_record VALUES (?,?,?) ON CONFLICT(task_id,id) DO UPDATE SET body=excluded.body').run(taskId,record.id,JSON.stringify(record));return structuredClone(record);},
    get(id){const row=db.prepare('SELECT body FROM task_host_record WHERE task_id=? AND id=?').get(taskId,id);if(!row)throw Error('unknown_id');return JSON.parse(row.body);},
    list(kind){return db.prepare('SELECT body FROM task_host_record WHERE task_id=?').all(taskId).map(row=>JSON.parse(row.body)).filter(record=>record.kind===kind);},
  };}
  function contextFor(taskId){
    if(contexts.has(taskId))return contexts.get(taskId);
    const row=db.prepare('SELECT body FROM task_host_context WHERE id=?').get(taskId),initial=row?JSON.parse(row.body):undefined;
    const context=createWorkContext({initial,inspectFile:inspectFileReference,onChange:value=>db.prepare('INSERT INTO task_host_context VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(taskId,JSON.stringify(value))});
    if(initial?.kind==='browser')context.updateBrowser({page:initial.page,selection:null},{activate:true});
    contexts.set(taskId,context);return context;
  }
  function validate(task,run){
    if(closed)throw Error('task_host_tools_closed');
    const current=tasks.row('task',task.id),currentRun=tasks.row('run',run.id);
    if(current.runId!==run.id||currentRun.taskId!==current.id||current.status!=='running'||currentRun.status!=='running'
      ||current.assignedBotId!==task.assignedBotId||current.assignmentVersion!==run.assignmentVersion)throw Error('actor_stale');
    if(current.policyVersion!==2||current.permission!=='full')throw Error('task_host_tool_denied');
    if(tasks.team&&(!tasks.team.profile(current.assignedBotId).enabled||current.assignedBotId!==tasks.team.chiefId&&!tasks.team.enabled()))throw Error('actor_disabled');
    return current;
  }
  function pump(){
    if(pumping||active||closed)return;pumping=true;
    try{
      for(let i=queue.length-1;i>=0;i--)if(queue[i].signal?.aborted){const [entry]=queue.splice(i,1);entry.reject(entry.signal.reason??Error('cancelled'));}
      let index=queue.findIndex(entry=>entry.kind==='foreground');
      if(index<0){if(foregroundBusy())return;index=queue.length?0:-1;}
      if(index<0)return;
      const entry=queue.splice(index,1)[0];active=entry;
      if(entry.kind==='foreground')owner=null;
      Promise.resolve().then(()=>{entry.signal?.throwIfAborted();return entry.fn();}).then(entry.resolve,entry.reject).finally(()=>{active=null;pump();});
    }finally{pumping=false;}
  }
  function enqueue(kind,fn,{signal,taskId,method}={}){
    if(closed)return Promise.reject(Error('task_host_tools_closed'));
    return new Promise((resolveDone,reject)=>{
      const entry={kind,fn,signal,taskId,method,resolve:resolveDone,reject};queue.push(entry);pump();
    });
  }
  const timer=setInterval(pump,50);timer.unref();
  function observeContext(value,flags={}){
    if(flags.disconnected){owner=null;for(const context of contexts.values())context.invalidate();return false;}
    if(active?.kind==='foreground'){owner=null;return false;}
    if(!owner)return false;
    const context=contextFor(owner),known=context.snapshot().page;
    if(flags.activate&&active?.kind!=='worker'){context.invalidate();owner=null;return false;}
    // Adopt a new tab only from the operation receipt; unrelated UI context
    // cannot grant the worker authority over another user's page.
    if(value.page&&(!known||known.bindingId!==value.page.bindingId||known.tabId!==value.page.tabId))return active?.kind==='worker';
    context.updateBrowser(value,flags);return true;
  }
  async function invoke({task,run,name,args={},actionId,signal}){
    if(!HOST_TOOL_NAMES.includes(name))throw Error('task_host_tool_denied');
    if(!idOk(actionId)||!args||typeof args!=='object'||Array.isArray(args))throw Error('invalid_task_tool_call');
    task={...task};run={...run};args=structuredClone(args);
    validate(task,run);
    if(name==='browser_close'&&args.scope!=='tab')throw Error('background_window_close_unavailable');
    const id=hash(task.id+'\0'+run.id+'\0'+actionId),fingerprint=JSON.stringify(stable({name,args}));
    if(fingerprint.length>32000)throw Error('invalid_task_tool_call');
    const old=getAction(id);
    if(old){if(old.fingerprint!==fingerprint)throw Error('task_tool_action_conflict');return inflight.get(id)??old.result;}
    const controller=new AbortController(),combined=AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);
    const watch=setInterval(()=>{try{validate(task,run);}catch(error){controller.abort(error);}},50);watch.unref();
    const promise=enqueue('worker',async()=>{
      const current=validate(task,run);combined.throwIfAborted();
      const record={id,taskId:task.id,runId:run.id,assignmentVersion:run.assignmentVersion,name,fingerprint,status:'running',createdAt:Date.now()};
      putAction(record);
      let result;
      try{
        const context=contextFor(task.id),localOps=taskOps(task.id),request={id:run.id,signal:combined};
        if(name==='document_open'){
          const workspace=readJson(join(tasks.agentHome(current),'workspace.json'));
          if(!workspace?.path)throw Error('task_workspace_not_ready');
          const root=realpathSync(workspace.path),path=realpathSync(resolveTaskPath({...current,workspace:root},args.path));
          const opener=documentFactory({workspace:root,ops:localOps,context});
          result=await opener.open({id:'task-doc-'+id,requestId:run.id,path,applicationId:args.applicationId},{signal:combined});
        }else{
          owner=task.id;
          const tools=createBrowserTools({bridge,context,ops:localOps,getRequest:()=>request});
          result=await tools.find(tool=>tool[0]===name)[3](args);
          if(result.page&&name!=='nova_show')context.updateBrowser({page:result.page,selection:null},{activate:true});
        }
      }catch(error){result={status:combined.aborted?'cancelled':'failed',error:String(error.message).slice(0,200)};}
      putAction({...record,status:'settled',result,finishedAt:Date.now()});return result;
    },{signal:combined,taskId:task.id,method:name});
    // Reserve while queued as well; duplicate HTTP deliveries share one action.
    putAction({id,taskId:task.id,runId:run.id,assignmentVersion:run.assignmentVersion,name,fingerprint,status:'running',createdAt:Date.now()});
    inflight.set(id,promise);
    try{return await promise;}
    catch(error){const result={status:'cancelled',error:String(error.message).slice(0,200)};putAction({...getAction(id),status:'settled',result,finishedAt:Date.now()});return result;}
    finally{clearInterval(watch);inflight.delete(id);}
  }
  return {invoke,observeContext,foreground:(fn,options={})=>enqueue('foreground',fn,options),
    context:taskId=>contextFor(taskId).snapshot(),
    async close(){closed=true;clearInterval(timer);for(const entry of queue.splice(0))entry.reject(Error('task_host_tools_closed'));await Promise.allSettled([...inflight.values()]);},
  };
}
