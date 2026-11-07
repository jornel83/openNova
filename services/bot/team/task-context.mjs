/** Task-owned, host-recorded facts; never infer user consent from employee prose. */
import {join} from 'node:path';
import {readJson,readSteps} from '../tasks/agent-files.mjs';

export const TASK_CONTEXT_LIMITS={events:100,textChars:8000,bytes:65536};
export function captureTaskContext(tasks,task,run,job){
  const context={version:1,taskId:task.id,throughRunId:run.id,assignmentVersion:run.assignmentVersion??task.assignmentVersion??1,events:[],truncated:false,omittedEvents:0};
  const table=name=>!!tasks.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if(!table('background_run'))return context;
  const rows=kind=>tasks.db.prepare(`SELECT body FROM background_${kind} WHERE json_extract(body,'$.taskId')=? ORDER BY rowid`).all(task.id).map(row=>JSON.parse(row.body));
  const cutoff=job.finishedAt??run.finishedAt??Date.now();
  const runs=rows('run').filter(r=>r.taskId===task.id&&r.number<=run.number&&r.createdAt<=cutoff&&((r.assignmentVersion??1)<=(run.assignmentVersion??1)));
  const ownRuns=new Map(runs.map(r=>[r.id,r]));
  if(!ownRuns.has(run.id))return context;
  const events=[],seen=new Set(),acks=new Map();
  const add=(r,value)=>{
    if(typeof value.text!=='string'||!value.text.trim()||!Number.isFinite(value.at)||value.at>cutoff||seen.has(value.id))return;
    const event={...value,runId:r.id,runNumber:r.number,assignmentVersion:r.assignmentVersion??1};
    if(event.text.length>TASK_CONTEXT_LIMITS.textChars){event.text=event.text.slice(0,TASK_CONTEXT_LIMITS.textChars);event.textTruncated=true;context.truncated=true;}
    seen.add(event.id);events.push(event);
  };
  const reviewExists=table('team_review'),reportExists=table('team_report');
  for(const r of runs){
    if(r.instruction){
      let source='unknown',sourceId;
      const trigger=r.managementTrigger;
      if(trigger&&reviewExists&&reportExists){
        const stored=tasks.db.prepare('SELECT body FROM team_review WHERE id=?').get(trigger.reviewId),origin=stored&&JSON.parse(stored.body);
        const storedReport=tasks.db.prepare('SELECT body FROM team_report WHERE id=?').get(trigger.reportId),report=storedReport&&JSON.parse(storedReport.body);
        const previous=origin&&ownRuns.get(origin.runId);
        if(previous&&previous.number<r.number&&origin.taskId===task.id&&origin.nextRunId===r.id&&origin.reportId===trigger.reportId&&origin.assignmentVersion===(r.assignmentVersion??1)&&
          report?.taskId===task.id&&report.runId===origin.runId&&report.assignmentVersion===origin.assignmentVersion&&origin.decision?.instruction===r.instruction&&
          ['answered','changes_requested'].includes(origin.status)&&['user','supervisor'].includes(origin.source)){
          source=origin.source;sourceId=origin.id;
        }
      }else if(r.trigger){source='event';sourceId=r.trigger.eventId;}
      else if(r.instructionSource?.kind==='user'){
        const previous=ownRuns.get(r.instructionSource.previousRunId);
        if(previous&&previous.number<r.number&&typeof r.instructionSource.actionId==='string'&&r.instructionSource.actionId){source='user';sourceId=r.instructionSource.actionId;}
      }
      const handoff=[task.handoff,...(task.assignmentHistory??[])].find(h=>h&&h.previousAssignmentVersion+1===(r.assignmentVersion??1)&&ownRuns.get(h.previousRunId)?.number===r.number-1);
      if(source==='unknown'&&handoff){source='handoff';sourceId=handoff.actionId;}
      add(r,{id:'instruction:'+r.id,kind:'instruction',source,sourceId,at:r.createdAt,text:r.instruction});
    }
    let priorJob;try{priorJob=tasks.row('job',r.jobId);}catch{continue;}
    if(priorJob.taskId!==task.id||priorJob.runId!==r.id)continue;
    const questions=readSteps(tasks.directory(priorJob)).filter(step=>step.taskId===task.id&&step.runId===r.id&&step.tool==='task_question'&&step.status==='completed'&&typeof step.arguments?.question==='string');
    for(const step of questions)add(r,{id:'question:'+r.id+':'+step.id,kind:'question',source:'employee',at:step.finishedAt??step.createdAt??priorJob.finishedAt??r.createdAt,text:step.arguments.question});
    const answer=priorJob.agentResult;
    if(!questions.length&&answer?.runId===r.id&&answer.taskId===task.id&&typeof answer.question==='string')add(r,{id:'question:'+r.id,kind:'question',source:'employee',at:priorJob.finishedAt??r.finishedAt??r.createdAt,text:answer.question});
  }
  if(table('background_message'))for(const message of rows('message')){
    if(message.createdAt>cutoff||message.source&&message.source!=='user')continue;
    // Each assignment has its own receipt file. A pending or uncertain delivery
    // cannot be used as evidence that an employee received the user's answer.
    for(const r of runs){
      const assignment=r.assignmentVersion??1;
      // A user message submitted before an explicit handoff may genuinely be
      // delivered to the new assignee. Its submission version is not a receipt.
      if(message.assignmentVersion!==undefined&&(message.assignmentVersion>assignment||message.assignmentVersion<assignment&&message.source!=='user'))continue;
      if(!acks.has(assignment))acks.set(assignment,readJson(join(tasks.agentHome({...task,assignmentVersion:assignment}),'delivered.json'),{}));
      const receipt=acks.get(assignment)[message.id];
      if(receipt?.status!=='delivered'||receipt.runId!==r.id||!Number.isFinite(receipt.at)||receipt.at<message.createdAt||receipt.at>cutoff)continue;
      if(receipt.at<r.createdAt||receipt.at>(r.finishedAt??cutoff))continue;
      add(r,{id:'message:'+message.id,kind:'message',source:'user',at:receipt.at,submittedAt:message.createdAt,submittedAssignmentVersion:message.assignmentVersion,text:message.text});break;
    }
  }
  events.sort((a,b)=>a.runNumber-b.runNumber||a.at-b.at||a.id.localeCompare(b.id));
  context.events=events.slice(-TASK_CONTEXT_LIMITS.events);context.omittedEvents=events.length-context.events.length;
  while(Buffer.byteLength(JSON.stringify(context))>TASK_CONTEXT_LIMITS.bytes&&context.events.length){context.events.shift();context.omittedEvents++;}
  if(context.omittedEvents)context.truncated=true;
  return context;
}
