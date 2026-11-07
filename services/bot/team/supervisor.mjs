/** Autonomous review uses the ordinary serial task queue and versioned reports. */
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {readJson} from '../tasks/agent-files.mjs';
import {normalizeReviewDecision,prepareReviewEvidence} from './review.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const idOk=value=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value);
const live=new Set(['queued','running','pausing','cancelling']);
const waiting=new Set(['completed','failed','waiting_input']);
export const MANAGEMENT_DEFAULTS={enabled:true,paused:false,maxReworks:2,tokenBudget:600000,timeBudgetMs:7200000,usedReworks:0};
export class TeamSupervisor {
  constructor({tasks,reports,createManagementTask,now=Date.now}){
    Object.assign(this,{tasks,reports,createManagementTask,now,db:tasks.db});this.ticking=false;this.notifications=new Set();
    this.db.exec('CREATE TABLE IF NOT EXISTS team_review (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
  }
  get(id){const row=this.db.prepare('SELECT body FROM team_review WHERE id=?').get(id);return row?JSON.parse(row.body):null;}
  put(value){
    const previous=this.get(value.id);
    this.db.prepare('INSERT INTO team_review VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(value.id,JSON.stringify(value));
    if(value.source!=='user'&&previous?.status!==value.status&&['accepted','needs_user','budget_exhausted','failed'].includes(value.status)){
      const task=this.tasks.row('task',value.taskId);if(task.runId===value.runId&&task.assignmentVersion===value.assignmentVersion)this.tasks.put('task',{...task,unread:true});
    }
    if(!this.notifications.has(value.taskId)){this.notifications.add(value.taskId);queueMicrotask(()=>{this.notifications.delete(value.taskId);try{this.tasks.changed(this.tasks.row('task',value.taskId));}catch{}});}
    return value;
  }
  history(taskId){return this.db.prepare("SELECT body FROM team_review WHERE json_extract(body,'$.taskId')=? ORDER BY rowid DESC").all(taskId).map(row=>JSON.parse(row.body));}
  management(task){return {...MANAGEMENT_DEFAULTS,enabled:false,...task.management};}
  usage(task){
    const ids=new Set([task.id,...this.tasks.all().filter(item=>item.managementReview?.targetTaskId===task.id||item.parentTaskId===task.id).map(item=>item.id)]);let usedTokens=0,usedDurationMs=0;
    for(const row of this.db.prepare('SELECT body FROM background_run').all()){
      const run=JSON.parse(row.body);if(!ids.has(run.taskId))continue;
      const job=this.tasks.row('job',run.jobId),progress=readJson(join(this.tasks.directory(job),'progress.json'))??job.agentResult??{};
      usedTokens+=Number(progress.totalTokens)||0;
      if(run.startedAt)usedDurationMs+=Math.max(0,(run.finishedAt??this.now())-run.startedAt);
    }
    return {usedTokens,usedDurationMs};
  }
  summary(task){
    const report=this.reports.current(task),review=report&&this.history(task.id).find(item=>item.reportId===report.id);
    let status=review?.status,reason;
    if(status==='accepted'&&(report.evidence?.captureIncomplete||(report.artifacts??[]).some(item=>item.status!=='available'||item.sourceStatus&&!['available','unchanged'].includes(item.sourceStatus))||(report.evidence?.codeChanges??[]).some(item=>item.deleted&&existsSync(item.path)))){status='stale';reason='accepted_report_evidence_changed';}
    return {reportId:report?.id,reviewStatus:status??(report?'pending':undefined),reviewVersion:review?.id,
      inboxReason:reason??(review&&['needs_user','budget_exhausted','failed'].includes(status)?review.decision?.summary??review.error:undefined)};
  }
  view(task){const reviews=this.history(task.id),effective=this.summary(task),current=reviews.find(review=>review.reportId===effective.reportId);return {management:{...this.management(task),...this.usage(task)},currentReview:current?{...current,status:effective.reviewStatus,effectiveReason:effective.inboxReason}:null,reviewHistory:reviews,reviews};}
  continuationBudget(task){
    const settings=this.management(task);if(!settings.enabled)return {};
    if(settings.paused)return {reason:'management_paused'};
    const usage=this.usage(task),tokenBudget=settings.tokenBudget-usage.usedTokens,timeoutMs=settings.timeBudgetMs-usage.usedDurationMs;
    if(tokenBudget<1000||timeoutMs<1000)return {reason:'management_budget_exhausted'};
    return {executionBudget:{tokenBudget:Math.min(task.tokenBudget??200000,tokenBudget),timeoutMs:Math.min(task.timeoutMs,timeoutMs)}};
  }
  isAccepted(report){
    if(!report)return false;
    const task=this.tasks.row('task',report.taskId),effective=this.summary(task);
    return effective.reportId===report.id&&effective.reviewStatus==='accepted';
  }
  current(review){
    const task=this.tasks.row('task',review.taskId);
    if(review.source!=='user'&&this.history(task.id).some(other=>other.id!==review.id&&other.reportId===review.reportId&&other.source==='user'&&['accepted','changes_requested','answered','needs_user'].includes(other.status)))throw Error('review_stale');
    if(task.runId!==review.runId||task.assignmentVersion!==review.assignmentVersion||live.has(task.status)||!waiting.has(task.status))throw Error('review_stale');
    const report=this.reports.assertCurrent(task,review.reportId)??this.reports.get(review.reportId);
    if(report.runId!==task.runId||report.assignmentVersion!==task.assignmentVersion)throw Error('review_stale');
    return {task,report};
  }
  configure(body){
    const task=this.tasks.row('task',body.id);if(task.runId!==body.runId)throw Error('task_run_changed');
    if(task.managementReview)throw Error('management_task_not_configurable');
    const settings=this.management(task);
    for(const key of ['enabled','paused'])if(body[key]!==undefined){if(typeof body[key]!=='boolean')throw Error('invalid_management_policy');settings[key]=body[key];}
    for(const [key,min,max] of [['maxReworks',0,5],['tokenBudget',1000,3000000],['timeBudgetMs',1000,28800000]])if(body[key]!==undefined){if(!Number.isInteger(body[key])||body[key]<min||body[key]>max)throw Error('invalid_management_policy');settings[key]=body[key];}
    task.management=settings;this.tasks.put('task',task);
    if(!settings.enabled||settings.paused)for(const review of this.history(task.id))if(['queued','reviewing'].includes(review.status)){
      try{const child=this.tasks.row('task',review.managementTaskId);if(live.has(child.status))this.tasks.pause({id:child.id,runId:child.runId});}catch{}
      this.put({...review,status:'paused',finishedAt:this.now()});
    }
    if(settings.enabled&&!settings.paused)for(const review of this.history(task.id))if(review.status==='paused')this.put({...review,status:'queued',resumePending:true,error:undefined,finishedAt:undefined});
    this.tasks.changed(task);return this.view(task);
  }
  userDecision(body){
    if(!idOk(body.actionId))throw Error('invalid_review_action_id');
    const id='user-review-'+hash(body.actionId),fingerprint=JSON.stringify(body),old=this.get(id);
    if(old){if(old.fingerprint!==fingerprint)throw Error('review_action_conflict');return old;}
    const task=this.tasks.row('task',body.id);if(task.runId!==body.runId)throw Error('task_run_changed');
    const report=this.reports.assertCurrent(task,body.reportId)??this.reports.get(body.reportId);
    const review={id,fingerprint,taskId:task.id,runId:task.runId,assignmentVersion:task.assignmentVersion,reportId:report.id,source:'user',createdAt:this.now()};
    const result=this.apply(review,normalizeReviewDecision(body,report,{manual:true}),true);
    for(const other of this.history(task.id))if(other.id!==id&&other.reportId===report.id&&['queued','reviewing'].includes(other.status)){
      this.put({...other,status:'stale',error:'superseded_by_user_decision',finishedAt:this.now()});
      try{const child=this.tasks.row('task',other.managementTaskId);if(live.has(child.status))this.tasks.pause({id:child.id,runId:child.runId});}catch{}
    }
    return result;
  }
  apply(review,decision,manual=false){
    const {task,report}=this.current(review),settings=this.management(task),usage=this.usage(task);
    decision=normalizeReviewDecision(decision,report,{manual});
    if(!manual&&(!settings.enabled||settings.paused))return this.put({...review,status:'paused',decision,finishedAt:this.now()});
    const continueTask=['request_changes','answer'].includes(decision.action);
    if(continueTask&&task.kind!=='agent')decision={action:'needs_user',summary:'命令任务需要用户指定新的执行要求，不能自动重放原命令。',evidenceIds:[]};
    if(continueTask&&decision.action!=='needs_user'){
      const remainingTokens=settings.tokenBudget-usage.usedTokens,remainingTime=settings.timeBudgetMs-usage.usedDurationMs;
      if(!manual&&(decision.action==='request_changes'&&settings.usedReworks>=settings.maxReworks||remainingTokens<1000||remainingTime<1000))return this.put({...review,status:'budget_exhausted',decision,error:'management_budget_exhausted',finishedAt:this.now()});
      const oldRun=this.tasks.row('run',task.runId),job=this.tasks.row('job',oldRun.jobId);
      if(job.cleanupConfirmed!==true)throw Error('review_cleanup_unconfirmed');
      this.tasks.atomic(()=>{
        this.current(review);delete task.stopIntent;task.management={...settings,usedReworks:settings.usedReworks+(!manual&&decision.action==='request_changes'?1:0)};
        this.tasks.newRun(task,oldRun.number+1,decision.instruction,{managementTrigger:{reviewId:review.id,reportId:report.id},
          ...(!manual?{executionBudget:{tokenBudget:Math.min(task.tokenBudget,remainingTokens),timeoutMs:Math.min(task.timeoutMs,remainingTime)}}:{})});
        this.put({...review,decision,status:decision.action==='answer'?'answered':'changes_requested',nextRunId:task.runId,finishedAt:this.now()});
      });
    }else this.tasks.atomic(()=>{this.current(review);this.put({...review,decision,status:decision.action==='accept'?'accepted':'needs_user',finishedAt:this.now()});});
    this.tasks.changed(task);return this.get(review.id);
  }
  tick(){
    if(this.ticking||this.tasks.closed)return;this.ticking=true;
    try{
      for(const row of this.db.prepare('SELECT body FROM team_review').all()){
        const review=JSON.parse(row.body);if(!['queued','reviewing'].includes(review.status))continue;
        let current;try{current=this.current(review);}catch{
          this.put({...review,status:'stale',finishedAt:this.now()});
          try{const child=this.tasks.row('task',review.managementTaskId);if(live.has(child.status))this.tasks.pause({id:child.id,runId:child.runId});}catch{}
          continue;
        }
        if(!this.management(current.task).enabled||this.management(current.task).paused){this.put({...review,status:'paused',finishedAt:this.now()});continue;}
        let child;try{child=this.tasks.row('task',review.managementTaskId);}catch{
          try{this.createManagementTask({id:review.managementTaskId,report:current.report,review,managementReview:review.managementReview,goal:'读取 report.json，验收员工交付并调用 review_decide。',budgets:review.budgets});}catch{}
          continue;
        }
        if(live.has(child.status)){if(child.status==='running'&&review.status!=='reviewing')this.put({...review,status:'reviewing'});continue;}
        const run=this.tasks.row('run',child.runId),job=this.tasks.row('job',run.jobId);
        if(job.cleanupConfirmed!==true)continue;
        if(review.resumePending&&child.status!=='completed'){
          if(this.tasks.workers?.has(job.id))continue;
          const settings=this.management(current.task),usage=this.usage(current.task),tokenBudget=settings.tokenBudget-usage.usedTokens,timeoutMs=settings.timeBudgetMs-usage.usedDurationMs;
          if(tokenBudget<1000||timeoutMs<1000){this.put({...review,status:'budget_exhausted',error:'management_budget_exhausted',finishedAt:this.now()});continue;}
          this.tasks.atomic(()=>{
            this.current(review);delete child.stopIntent;
            this.tasks.newRun(child,run.number+1,'恢复同一报告的只读验收。重新读取 report.json 和相关证据，再用 review_decide 提交本轮决定。',{executionBudget:{tokenBudget:Math.min(child.tokenBudget,tokenBudget),timeoutMs:Math.min(child.timeoutMs,timeoutMs)}});
            this.put({...review,status:'queued',resumePending:false,resumedRunId:child.runId});
          });this.tasks.changed(child);continue;
        }
        const receipt=readJson(join(this.tasks.directory(job),'review-decision.json'));
        if(child.status!=='completed'||receipt?.reviewId!==review.id||receipt?.targetTaskId!==review.taskId||receipt?.targetRunId!==review.runId||receipt?.assignmentVersion!==review.assignmentVersion||receipt?.reportId!==review.reportId||receipt?.managementRunId!==run.id){this.put({...review,status:'needs_user',error:'management_review_incomplete',finishedAt:this.now()});continue;}
        try{this.apply(review,receipt.decision);}catch(error){this.put({...review,status:error.message==='review_stale'?'stale':'needs_user',error:String(error.message).slice(0,200),finishedAt:this.now()});}
      }
      for(const task of this.tasks.all()){
        const settings=this.management(task);
        if(!task.management||!settings.enabled||settings.paused||task.managementReview||!waiting.has(task.status)||task.assignedBotId===this.tasks.team?.chiefId)continue;
        const report=this.reports.current(task);if(!report||!this.reports.isDelivered(report.id))continue;
        if(this.history(task.id).some(review=>review.reportId===report.id))continue;
        const review={id:'review-'+hash(report.id),reportId:report.id,taskId:task.id,runId:task.runId,assignmentVersion:task.assignmentVersion,source:'supervisor',createdAt:this.now()};
        try{
          this.current(review);const usage=this.usage(task),tokenBudget=Math.min(60000,settings.tokenBudget-usage.usedTokens),timeoutMs=Math.min(300000,settings.timeBudgetMs-usage.usedDurationMs);
          if(tokenBudget<1000||timeoutMs<1000){this.put({...review,status:'budget_exhausted',error:'management_budget_exhausted',finishedAt:this.now()});continue;}
          const managementTaskId='management-'+hash(report.id),evidenceDirectory=join(this.tasks.root,'management-inputs',hash(report.id));
          prepareReviewEvidence({report,task,directory:evidenceDirectory});
          const managementReview={reviewId:review.id,reportId:report.id,targetTaskId:task.id,targetRunId:task.runId,assignmentVersion:task.assignmentVersion,evidenceDirectory};
          const budgets={maxSteps:24,tokenBudget,timeoutMs};
          this.put({...review,status:'queued',managementTaskId,managementReview,budgets});
          try{this.createManagementTask({id:managementTaskId,report,review,managementReview,goal:'读取 report.json，验收员工交付并调用 review_decide。',budgets});}catch(error){
            // Keep a recoverable intent even if creation or acknowledgement was interrupted.
            this.put({...this.get(review.id),error:String(error.message).slice(0,200)});
          }
        }catch(error){this.put({...review,status:'needs_user',error:String(error.message).slice(0,200),finishedAt:this.now()});}
      }
    }finally{this.ticking=false;}
  }
}
