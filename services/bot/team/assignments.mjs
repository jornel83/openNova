/** Explicit ownership and dependency admission; no inferred or silent reassignment. */
import {createHash,randomUUID} from 'node:crypto';
import {assertTaskOpen,taskIsClosed} from '../tasks/closure.mjs';
const assertOpen=(tasks,task)=>tasks.assertOpen?tasks.assertOpen(task):assertTaskOpen(task);
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const idOk=v=>typeof v==='string'&&/^[\w-]{1,100}$/.test(v);
const active=new Set(['running','pausing','cancelling']);
export function planningSpec(input){
  const dependsOn=input.dependsOn??[],priority=input.priority??'normal',dueAt=input.dueAt??null;
  if(!Array.isArray(dependsOn)||dependsOn.length>20||dependsOn.some(v=>!idOk(v))||!['low','normal','high'].includes(priority)||dueAt!==null&&(!Number.isSafeInteger(dueAt)||dueAt<0))throw Error('invalid_task_dependencies');
  return {dependsOn:[...new Set(dependsOn)],priority,dueAt};
}
export class TeamAssignments {
  constructor(tasks){this.tasks=tasks;}
  validate(id,dependsOn){
    const visit=(key,path)=>{if(key===id||path.has(key))throw Error('task_dependency_cycle');const t=this.tasks.row('task',key);if(taskIsClosed(t))throw Error('task_dependency_closed');if(t.managementReview||t.parentTaskId)throw Error('invalid_task_dependencies');for(const dep of t.dependsOn??[])visit(dep,new Set([...path,key]));};
    for(const dep of dependsOn)visit(dep,new Set());
  }
  set({id,runId,...input}){
    const t=this.tasks.row('task',id);if(t.runId!==runId)throw Error('task_run_changed');
    assertOpen(this.tasks,t);
    const run=this.tasks.row('run',runId);
    if(t.kind!=='agent'||run.startedAt||!['queued','blocked','paused'].includes(t.status))throw Error('task_dependencies_locked');
    const spec=planningSpec({...t,...input});this.validate(id,spec.dependsOn);
    Object.assign(t,spec,{dependencyInputs:[],transferInputs:[],blockedReason:null});this.tasks.put('task',t);this.tasks.changed(t);this.tick();return this.tasks.detail(id);
  }
  inputs(report,prefix){
    return (report.artifacts??[]).map(a=>{
      const file=this.tasks.reports.artifact({id:report.taskId,reportId:report.id,artifactId:a.id});
      return {taskId:report.taskId,projectId:report.projectId,reportId:report.id,artifactId:a.id,path:file.path,sha256:file.sha256??a.sha256,name:prefix+'/'+a.name};
    });
  }
  reassign({id,runId,assignmentVersion,assignedBotId,actionId,summary='',reportId}){
    const tasks=this.tasks,t=tasks.row('task',id);
    if(!idOk(actionId)||typeof summary!=='string'||summary.length>4000||!summary.trim())throw Error('invalid_task_handoff');
    const fingerprint=digest({runId,assignmentVersion,assignedBotId,summary,reportId});
    if(t.handoff?.actionId===actionId){if(t.handoff.fingerprint!==fingerprint)throw Error('task_id_conflict');return tasks.detail(id);}
    assertOpen(tasks,t);
    if(t.runId!==runId||t.assignmentVersion!==assignmentVersion)throw Error('task_run_changed');
    if(t.kind!=='agent'||t.managementReview||t.handoff?.status==='stopping'||assignedBotId===t.assignedBotId)throw Error('invalid_task_handoff');
    tasks.team.assignment({...t,assignedBotId});
    if(t.media&&!tasks.skills?.validateSelection({...t,assignedBotId}).includes('image-production'))throw Error('task_media_skill_required');
    let report=null;if(reportId){report=tasks.reports.get(reportId);tasks.reports.assertCurrent(t,reportId);}
    const inputs=report?this.inputs(report,'handoff/'+report.id):[];
    const managementPaused=!!t.management?.paused;
    t.management={...t.management,paused:true};t.automationPaused=true;
    t.handoff={actionId,fingerprint,status:'stopping',fromBotId:t.assignedBotId,toBotId:assignedBotId,previousRunId:runId,previousAssignmentVersion:assignmentVersion,summary,reportId,inputs,managementPaused,createdAt:Date.now()};
    tasks.put('task',t);tasks.pause({id,runId,handoffActionId:actionId});this.tick();return tasks.detail(id);
  }
  finishHandoff(t){
    if(taskIsClosed(t))return;
    const tasks=this.tasks,h=t.handoff,run=tasks.row('run',t.runId),job=tasks.row('job',run.jobId);
    if(active.has(t.status)||!job.cleanupConfirmed||tasks.workers.has(job.id))return;
    try{
      tasks.team.assignment({...t,assignedBotId:h.toBotId});
      if(t.media&&!tasks.skills?.validateSelection({...t,assignedBotId:h.toBotId}).includes('image-production'))throw Error('task_media_skill_required');
    }catch(error){t.blockedReason=error.message;tasks.put('task',t);return;}
    try{tasks.runBudget(t);}catch(error){if(t.blockedReason!==error.message){t.blockedReason=error.message;tasks.put('task',t);tasks.changed(t);}return;}
    // Versioned copies are rechecked before ownership changes. Unknown work is never replayed.
    if(h.reportId)try{const report=tasks.reports.get(h.reportId);this.inputs(report,'handoff/'+report.id);}catch(error){t.blockedReason=error.message;tasks.put('task',t);return;}
    tasks.atomic(()=>{
      t.assignedBotId=h.toBotId;t.assignmentVersion=(t.assignmentVersion??1)+1;t.routing='user-reassigned';
      const dependencyReports=new Set((t.dependencyInputs??[]).map(input=>input.reportId));
      t.sessionId='session-'+randomUUID().replaceAll('-','');t.transferInputs=[...(t.transferInputs??[]).filter(input=>dependencyReports.has(input.reportId)),...h.inputs];t.handoff={...h,status:'completed',completedAt:Date.now()};
      t.assignmentHistory=[...(t.assignmentHistory??[]),{...h,inputs:undefined}];delete t.stopIntent;t.blockedReason=null;
      // Resume only management previously enabled, within the same cumulative budget.
      t.management={...t.management,paused:h.managementPaused};
      tasks.newRun(t,run.number+1,'用户明确改派。交接摘要：'+h.summary+'\n指定成果已复制到 handoff 目录。原员工私有会话和记忆不随交接传递。');
    });tasks.changed(t);
  }
  staleInputs(task){
    return (task.dependencyInputs??[]).filter(input=>{
      try{const source=this.tasks.row('task',input.taskId),current=this.tasks.reports?.current(source);return taskIsClosed(source)||!current||current.id!==input.reportId||!this.tasks.supervisor?.isAccepted(current);}
      catch{return true;}
    }).map(input=>input.taskId);
  }
  tick(){
    const tasks=this.tasks;
    for(let t of tasks.queries?.assignmentCandidates()??tasks.all()){
      if(t.managementReview||taskIsClosed(t))continue;
      if(t.handoff?.status==='stopping'){this.finishHandoff(t);continue;}
      if(t.dependencyInputs?.length){
        const stale=this.staleInputs(t);
        if(JSON.stringify(stale)!==JSON.stringify(t.inputsStale??[])){t.inputsStale=stale;tasks.put('task',t);tasks.changed(t);}
      }
      if(!['queued','blocked'].includes(t.status))continue;
      let reason=null,reports=[];
      try{if(tasks.team)tasks.team.assignment(t);}catch(error){reason=error.message;}
      if(!reason&&!t.dependencyInputs?.length)for(const id of t.dependsOn??[]){
        const predecessor=tasks.row('task',id),report=tasks.reports?.current(predecessor);
        if(taskIsClosed(predecessor)){reason='dependency_closed:'+id;break;}
        if(!report||!tasks.supervisor?.isAccepted(report)){reason='dependency_waiting_acceptance:'+id;break;}
        try{tasks.reports.assertCurrent(predecessor,report.id);reports.push(report);}catch{reason='dependency_artifact_changed:'+id;break;}
      }
      if(!reason&&reports.length)try{
        const inputs=reports.flatMap(r=>this.inputs(r,'dependencies/'+r.taskId+'/'+r.id));
        t.transferInputs=[...(t.transferInputs??[]),...inputs];
        t.dependencyInputs=reports.map(r=>({taskId:r.taskId,projectId:r.projectId,reportId:r.id,version:r.version,summary:r.summary,artifacts:r.artifacts.map(a=>({id:a.id,name:a.name,sha256:a.sha256}))}));
      }catch{reason='dependency_artifact_missing';}
      const status=reason?'blocked':'queued';
      if(t.status!==status||t.blockedReason!==reason||reports.length){
        t.status=status;t.blockedReason=reason;
        const run=tasks.row('run',t.runId),job=tasks.row('job',run.jobId);
        tasks.atomic(()=>{tasks.put('task',t);tasks.put('run',{...run,status});tasks.put('job',{...job,status});});tasks.changed(t);
      }
    }
  }
}
