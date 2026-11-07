import {saveJson,readJson} from './agent-files.mjs';

const phases=new Set(['initializing','waiting_foreground','model','tool','idle','waiting_input','waiting_event']);
/** A heartbeat proves the runtime event loop responds, not that the model made progress. */
export function createTaskActivity({path,taskId,runId,now=Date.now}){
  let state={taskId,runId,phase:'initializing',since:now(),lastActivityAt:now()},lastWrite=0;
  const persist=()=>{lastWrite=now();try{saveJson(path,{...state,heartbeatAt:lastWrite});}catch{/* Status telemetry must not interrupt the work it observes. */}};
  persist();
  return {
    phase(phase,tool){
      if(!phases.has(phase))throw Error('invalid_task_activity');
      const at=now();state={...state,phase,tool:typeof tool==='string'?tool.slice(0,100):undefined,since:at,lastActivityAt:at};persist();
    },
    touch(){state.lastActivityAt=now();if(now()-lastWrite>=1000)persist();},
    heartbeat:persist,
  };
}

export function readTaskActivity(path){try{return readJson(path);}catch{return null;}}

export function taskActivity({task,run,job,record,logActivityAt,workerConnected=false,foregroundBusy=false,now=Date.now()}){
  const current=run.id===task.runId,terminal=!['running','queued','blocked','pausing','cancelling'].includes(run.status);
  const valid=record?.taskId===task.id&&record.runId===run.id&&phases.has(record.phase);
  const timestamp=value=>Number.isFinite(value)&&value>=run.createdAt&&value<=now?value:undefined;
  const lastActivityAt=terminal?run.finishedAt??job.finishedAt:Math.max(valid?timestamp(record.lastActivityAt)??0:0,timestamp(logActivityAt)??0)||undefined;
  let phase=run.status;
  if(run.status==='running')phase=valid?record.phase:task.kind==='agent'?'initializing':'command';
  if(current&&run.status==='queued'&&foregroundBusy)phase='waiting_foreground';
  return {phase,tool:valid&&phase==='tool'?record.tool:undefined,lastActivityAt:lastActivityAt??run.startedAt??run.createdAt,
    since:valid&&phase===record.phase?timestamp(record.since):run.startedAt??run.createdAt,
    ...(current&&run.status==='running'?{workerConnected,heartbeatAt:valid?timestamp(record.heartbeatAt):undefined}:{}),
    ...(job.cleanupConfirmed===false&&terminal?{cleanupUnconfirmed:true}:{})};
}
