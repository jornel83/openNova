import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Operations} from '../operations.mjs';
import {saveJson} from '../tasks/agent-files.mjs';
import {TeamSupervisor,MANAGEMENT_DEFAULTS} from '../team/supervisor.mjs';
import {normalizeReviewDecision,prepareReviewEvidence,prepareReviewWorkspace} from '../team/review.mjs';
import {allowedTaskTools} from '../tasks/execution.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'nova-supervisor-')),ops=new Operations({home,workspace:join(home,'project')}),db=ops.db;
  for(const table of ['task','run','job'])db.exec(`CREATE TABLE background_${table} (id TEXT PRIMARY KEY,body TEXT NOT NULL)`);
  let sequence=1,report,creates=0,failCreate=false;
  const tasks={db,root:join(home,'tasks'),team:{chiefId:'chief'},closed:false,workers:new Map(),
    row(kind,id){const row=db.prepare(`SELECT body FROM background_${kind} WHERE id=?`).get(id);if(!row)throw Error('unknown_task');return JSON.parse(row.body);},
    put(kind,value){db.prepare(`INSERT INTO background_${kind} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(value.id,JSON.stringify(value));return value;},
    all(){return db.prepare('SELECT body FROM background_task').all().map(row=>JSON.parse(row.body));},directory:job=>join(home,'jobs',job.id),changed(){},
    atomic(fn){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}},
    newRun(task,number,instruction,extra={}){const run={id:'run-'+(++sequence),taskId:task.id,number,jobId:'job-'+sequence,status:'queued',...extra};task.runId=run.id;task.status='queued';this.put('run',run);this.put('job',{id:run.jobId,status:'queued',cleanupConfirmed:true});this.put('task',task);},
    pause({id}){const task=this.row('task',id);task.status='paused';this.put('task',task);},
  };
  mkdirSync(tasks.root);
  const base={id:'employee-work',kind:'agent',runId:'run-1',assignmentVersion:1,assignedBotId:'employee',status:'completed',goal:'生成完整报告',management:{...MANAGEMENT_DEFAULTS,tokenBudget:600000,timeBudgetMs:7200000},tokenBudget:200000,timeoutMs:1800000};
  tasks.put('task',base);tasks.put('run',{id:'run-1',taskId:base.id,number:1,status:'completed',jobId:'job-1',startedAt:100,finishedAt:150});tasks.put('job',{id:'job-1',status:'completed',cleanupConfirmed:true});
  function finishTarget(content='draft'){
    const task=tasks.row('task',base.id);task.status='completed';tasks.put('task',task);
    const run=tasks.row('run',task.runId);run.status='completed';tasks.put('run',run);tasks.put('job',{...tasks.row('job',run.jobId),status:'completed',cleanupConfirmed:true});
    const path=join(home,'artifact-'+sequence+'.md');writeFileSync(path,content);
    report={id:'report-'+sequence,taskId:task.id,runId:task.runId,assignmentVersion:task.assignmentVersion,status:'completed',summary:content,
      artifacts:[{id:'artifact-'+sequence,name:'report.md',path,sha256:hash(content),status:'available',sourceStatus:'available'}],evidence:{execution:{status:'completed',exitCode:0,cleanupConfirmed:true},steps:[{id:'write-step',tool:'write',status:'completed'}],commands:[],checks:[]},sources:[]};return report;
  }
  finishTarget();
  const reports={current:task=>report.runId===task.runId&&report.assignmentVersion===task.assignmentVersion?structuredClone(report):null,get:()=>structuredClone(report),isDelivered:()=>true,
    assertCurrent(task,id){if(id!==report.id||task.runId!==report.runId||task.assignmentVersion!==report.assignmentVersion)throw Error('report_changed');return structuredClone(report);}};
  const createManagementTask=({id,managementReview,budgets})=>{
    creates++;if(failCreate){failCreate=false;throw Error('simulated_creation_interruption');}
    if(tasks.all().some(task=>task.id===id))return;
    const child={id,runId:id+'-run',kind:'agent',status:'queued',managementReview,...budgets};tasks.put('task',child);
    tasks.put('run',{id:child.runId,taskId:id,jobId:id+'-job',number:1,status:'queued'});tasks.put('job',{id:id+'-job',cleanupConfirmed:true,status:'queued'});
  };
  const supervisor=new TeamSupervisor({tasks,reports,createManagementTask,now:()=>1000});
  function decide(decision){const review=supervisor.history(base.id).find(r=>['queued','reviewing'].includes(r.status)),child=tasks.row('task',review.managementTaskId),run=tasks.row('run',child.runId);child.status='completed';run.status='completed';tasks.put('task',child);tasks.put('run',run);saveJson(join(tasks.directory(tasks.row('job',run.jobId)),'review-decision.json'),{...child.managementReview,managementRunId:run.id,decision});return review;}
  t.after(()=>{tasks.closed=true;ops.close();rmSync(home,{recursive:true,force:true});});
  return {tasks,supervisor,reports,home,finishTarget,decide,base,get report(){return report;},get creates(){return creates;},failOnce(){failCreate=true;}};
}
test('incomplete delivery is reworked once and the new report can be accepted',t=>{
  const f=fixture(t);f.supervisor.tick();assert.equal(f.creates,1);
  f.decide({action:'request_changes',summary:'缺少结论',instruction:'补上结论',evidenceIds:[]});f.supervisor.tick();
  const next=f.tasks.row('task',f.base.id);assert.equal(next.status,'queued');assert.equal(next.management.usedReworks,1);assert.ok(f.tasks.row('run',next.runId).executionBudget.tokenBudget>0);
  f.finishTarget('complete');f.supervisor.tick();f.decide({action:'accept',summary:'内容完整',evidenceIds:[f.report.artifacts[0].id]});f.supervisor.tick();
  assert.equal(f.supervisor.isAccepted(f.report),true);assert.equal(f.creates,2);assert.deepEqual(f.supervisor.history(f.base.id).map(r=>r.status),['accepted','changes_requested']);
  f.supervisor.tick();assert.equal(f.creates,2,'management reports do not start a review loop');
  f.tasks.put('task',{...f.tasks.row('task',f.base.id),unread:false});f.supervisor.tick();assert.equal(f.tasks.row('task',f.base.id).unread,false,'unchanged acceptance must not renew the unread notification');
});
test('paused management and cumulative rework/token budgets prevent automatic continuation',t=>{
  const f=fixture(t);f.supervisor.configure({id:f.base.id,runId:f.base.runId,paused:true});f.supervisor.tick();assert.equal(f.creates,0);
  f.supervisor.configure({id:f.base.id,runId:f.base.runId,paused:false,maxReworks:0});f.supervisor.tick();f.decide({action:'request_changes',summary:'不完整',instruction:'补充'});f.supervisor.tick();
  assert.equal(f.supervisor.history(f.base.id)[0].status,'budget_exhausted');assert.equal(f.tasks.row('task',f.base.id).runId,'run-1');
  const task=f.tasks.row('task',f.base.id);f.tasks.newRun(task,2,'manual');f.finishTarget();saveJson(join(f.tasks.directory(f.tasks.row('job',f.tasks.row('run',task.runId).jobId)),'progress.json'),{totalTokens:600000});
  f.supervisor.tick();assert.equal(f.supervisor.history(f.base.id)[0].status,'budget_exhausted');assert.equal(f.creates,1);
});
test('event continuation or assignment changes make an old review stale',t=>{
  const f=fixture(t);f.supervisor.tick();const review=f.decide({action:'request_changes',summary:'补充',instruction:'continue'});
  const task=f.tasks.row('task',f.base.id);f.tasks.newRun(task,2,'event already resumed');const runId=task.runId;f.supervisor.tick();
  assert.equal(f.supervisor.get(review.id).status,'stale');assert.equal(f.tasks.row('task',f.base.id).runId,runId);
  assert.throws(()=>f.supervisor.userDecision({id:task.id,runId:'run-1',reportId:f.report.id,action:'accept',summary:'yes',actionId:'old'}),/task_run_changed/);
});
test('manual acceptance supersedes an in-flight automatic decision and is idempotent',t=>{
  const f=fixture(t);f.supervisor.tick();const automatic=f.decide({action:'request_changes',summary:'late',instruction:'late work'});
  const action={id:f.base.id,runId:f.base.runId,reportId:f.report.id,action:'accept',text:'用户验收',actionId:'user-accept'};
  assert.equal(f.supervisor.userDecision(action).status,'accepted');assert.equal(f.supervisor.userDecision(action).status,'accepted');f.supervisor.tick();
  assert.equal(f.supervisor.get(automatic.id).status,'stale');assert.equal(f.tasks.row('task',f.base.id).runId,'run-1');assert.equal(f.supervisor.isAccepted(f.report),true);
});
test('creation intent resumes after interruption without duplicate management tasks',t=>{
  const f=fixture(t);f.failOnce();f.supervisor.tick();assert.equal(f.supervisor.history(f.base.id)[0].status,'queued');f.supervisor.tick();f.supervisor.tick();
  assert.equal(f.tasks.all().filter(task=>task.managementReview).length,1);assert.equal(f.creates,2);
});
test('acceptance rejects failed verification, uninspectable artifacts and summary-only evidence',t=>{
  const f=fixture(t),decision={action:'accept',summary:'verified',evidenceIds:[f.report.artifacts[0].id]};
  assert.throws(()=>normalizeReviewDecision({...decision,evidenceIds:['report:summary']},f.report),/concrete_evidence/);
  assert.throws(()=>normalizeReviewDecision(decision,{...f.report,evidence:{...f.report.evidence,commands:[{status:'completed',exitCode:1}]}}),/verification_incomplete/);
  assert.throws(()=>normalizeReviewDecision(decision,{...f.report,artifacts:f.report.artifacts.map(a=>({...a,name:'report.pdf'}))}),/artifact_not_readable/);
  assert.throws(()=>normalizeReviewDecision(decision,{...f.report,artifacts:f.report.artifacts.map(a=>({...a,status:'changed'}))}),/not_ready|invalid_review_evidence/);
});
test('management evidence workspace is copied and tool allowlist is strictly local read plus decision',t=>{
  const f=fixture(t),directory=join(f.home,'review-inputs');prepareReviewEvidence({report:f.report,task:f.base,directory});
  const workspace=prepareReviewWorkspace({home:join(f.home,'management'),managementReview:{reportId:f.report.id,targetTaskId:f.base.id,targetRunId:f.base.runId,assignmentVersion:1,evidenceDirectory:directory}});
  assert.equal(JSON.parse(readFileSync(join(workspace.path,'report.json'),'utf8')).reportId,f.report.id);
  assert.deepEqual(allowedTaskTools({managementReview:{},permission:'full',checksEnabled:true,networkTools:['web_search'],hostTools:['browser_open']}),['glob','grep','read','review_decide']);
});
test('answering an existing question uses the original session without consuming another rework',t=>{
  const f=fixture(t),task=f.tasks.row('task',f.base.id);task.status='waiting_input';task.stopIntent='paused';task.management.usedReworks=2;f.tasks.put('task',task);f.report.status='waiting_input';f.report.question='用哪个标题？';
  f.supervisor.tick();f.decide({action:'answer',summary:'原目标已指定标题',instruction:'使用原目标中的标题。'});f.supervisor.tick();
  const next=f.tasks.row('task',task.id);assert.equal(next.status,'queued');assert.equal(next.management.usedReworks,2);assert.equal(next.stopIntent,undefined);
  assert.equal(f.supervisor.history(task.id)[0].status,'answered');
});
test('effective acceptance becomes stale on artifact drift while history keeps the prior decision',t=>{
  const f=fixture(t);f.supervisor.userDecision({id:f.base.id,runId:f.base.runId,reportId:f.report.id,action:'accept',text:'验收',actionId:'accept-before-drift'});
  assert.equal(f.supervisor.summary(f.base).reviewStatus,'accepted');f.report.artifacts[0].sourceStatus='changed';
  assert.equal(f.supervisor.summary(f.base).reviewStatus,'stale');assert.equal(f.supervisor.view(f.base).currentReview.status,'stale');assert.equal(f.supervisor.history(f.base.id)[0].status,'accepted');
});
test('event continuation shares the cumulative management token and time budget',t=>{
  const f=fixture(t),task=f.tasks.row('task',f.base.id);assert.ok(f.supervisor.continuationBudget(task).executionBudget.tokenBudget>0);
  assert.equal(f.supervisor.continuationBudget({...task,management:{...task.management,paused:true}}).reason,'management_paused');
  saveJson(join(f.tasks.directory(f.tasks.row('job','job-1')),'progress.json'),{totalTokens:600000});
  assert.equal(f.supervisor.continuationBudget(task).reason,'management_budget_exhausted');
  assert.deepEqual(f.supervisor.continuationBudget({...task,management:{...task.management,enabled:false}}),{});
});
test('pause and resume continue the same management task with fresh Run receipts and immutable inputs',t=>{
  const f=fixture(t);f.supervisor.tick();const review=f.supervisor.history(f.base.id)[0],child=f.tasks.row('task',review.managementTaskId),oldRun=f.tasks.row('run',child.runId);
  const receipt={...child.managementReview,managementRunId:oldRun.id,decision:{action:'accept',summary:'旧轮已提交',evidenceIds:[f.report.artifacts[0].id]}};
  saveJson(join(f.tasks.directory(f.tasks.row('job',oldRun.jobId)),'review-decision.json'),receipt);
  f.supervisor.configure({id:f.base.id,runId:f.base.runId,paused:true});assert.equal(f.supervisor.get(review.id).status,'paused');
  f.supervisor.configure({id:f.base.id,runId:f.base.runId,paused:false});f.supervisor.tick();
  const resumed=f.tasks.row('task',child.id),run=f.tasks.row('run',resumed.runId);
  assert.notEqual(run.id,oldRun.id);assert.equal(run.number,2);assert.deepEqual(resumed.managementReview,child.managementReview);assert.equal(f.creates,1);
  assert.equal(f.supervisor.get(review.id).status,'queued');assert.equal(f.supervisor.get(review.id).resumePending,false);assert.ok(run.executionBudget.tokenBudget>0);
  f.supervisor.tick();assert.equal(f.supervisor.isAccepted(f.report),false,'the old Run decision receipt cannot complete the new Run');
  f.decide({action:'accept',summary:'重新读证据并验收',evidenceIds:[f.report.artifacts[0].id]});f.supervisor.tick();assert.equal(f.supervisor.isAccepted(f.report),true);
});
test('resume requested while management is pausing waits for cleanup and worker exit',t=>{
  const f=fixture(t);f.supervisor.tick();const review=f.supervisor.history(f.base.id)[0],child=f.tasks.row('task',review.managementTaskId),run=f.tasks.row('run',child.runId),job=f.tasks.row('job',run.jobId);
  f.tasks.pause=({id})=>{const item=f.tasks.row('task',id);f.tasks.put('task',{...item,status:'pausing',stopIntent:'paused'});};
  f.tasks.put('task',{...child,status:'running'});f.tasks.put('job',{...job,status:'running',cleanupConfirmed:false});f.tasks.workers.set(job.id,{});
  f.supervisor.configure({id:f.base.id,runId:f.base.runId,paused:true});f.supervisor.configure({id:f.base.id,runId:f.base.runId,paused:false});f.supervisor.tick();
  assert.equal(f.tasks.row('task',child.id).runId,run.id);assert.equal(f.supervisor.get(review.id).resumePending,true);
  f.tasks.put('task',{...f.tasks.row('task',child.id),status:'paused'});f.supervisor.tick();assert.equal(f.tasks.row('task',child.id).runId,run.id,'uncertain cleanup blocks resume');
  f.tasks.put('job',{...job,status:'paused',cleanupConfirmed:true});f.supervisor.tick();assert.equal(f.tasks.row('task',child.id).runId,run.id,'live worker blocks resume despite a cleanup receipt');
  f.tasks.workers.delete(job.id);f.supervisor.tick();const resumed=f.tasks.row('task',child.id);assert.notEqual(resumed.runId,run.id);assert.equal(resumed.stopIntent,undefined);assert.equal(f.supervisor.get(review.id).resumePending,false);
});
test('manual decisions override pending resume and exhausted budgets block it',t=>{
  const f=fixture(t);f.supervisor.tick();const review=f.supervisor.history(f.base.id)[0],child=f.tasks.row('task',review.managementTaskId);
  f.supervisor.configure({id:f.base.id,runId:f.base.runId,paused:true});f.supervisor.configure({id:f.base.id,runId:f.base.runId,paused:false});
  f.supervisor.userDecision({id:f.base.id,runId:f.base.runId,reportId:f.report.id,action:'accept',text:'用户验收',actionId:'accept-pending-resume'});f.supervisor.tick();
  assert.equal(f.supervisor.get(review.id).status,'stale');assert.equal(f.tasks.row('task',child.id).runId,child.runId);assert.equal(f.supervisor.isAccepted(f.report),true);
  const target=f.tasks.row('task',f.base.id);f.tasks.newRun(target,2,'new delivery');f.finishTarget();f.supervisor.tick();const next=f.supervisor.history(target.id)[0];
  f.supervisor.configure({id:target.id,runId:target.runId,paused:true});f.supervisor.configure({id:target.id,runId:target.runId,paused:false});
  saveJson(join(f.tasks.directory(f.tasks.row('job','job-1')),'progress.json'),{totalTokens:600000});f.supervisor.tick();assert.equal(f.supervisor.get(next.id).status,'budget_exhausted');
});
test('cumulative management time includes asynchronous command checks',t=>{
  const f=fixture(t);f.tasks.put('task',{id:'check',parentTaskId:f.base.id});f.tasks.put('run',{id:'check-run',taskId:'check',jobId:'check-job',startedAt:200,finishedAt:800});f.tasks.put('job',{id:'check-job'});
  assert.deepEqual(f.supervisor.usage(f.base),{usedTokens:0,usedDurationMs:650});
});

test('unlimited employee and supervisor budgets pass old thresholds and preserve rework counting',t=>{
  const f=fixture(t),task=f.tasks.row('task',f.base.id);
  assert.equal(MANAGEMENT_DEFAULTS.tokenBudget,0);assert.equal(MANAGEMENT_DEFAULTS.timeBudgetMs,0);
  Object.assign(task,{tokenBudget:0,timeoutMs:0,maxSteps:0,management:{...MANAGEMENT_DEFAULTS}});f.tasks.put('task',task);
  saveJson(join(f.tasks.directory(f.tasks.row('job','job-1')),'progress.json'),{totalTokens:9000000});
  f.tasks.put('run',{...f.tasks.row('run','run-1'),finishedAt:100000000});
  assert.deepEqual(f.supervisor.continuationBudget(task),{executionBudget:{tokenBudget:0,timeoutMs:0}});
  f.supervisor.tick();let review=f.supervisor.history(task.id)[0];
  assert.deepEqual(review.budgets,{maxSteps:0,tokenBudget:0,timeoutMs:0});
  f.decide({action:'request_changes',summary:'补全交付',instruction:'补充遗漏内容。'});f.supervisor.tick();
  const next=f.tasks.row('task',task.id);assert.equal(next.management.usedReworks,1);
  assert.deepEqual(f.tasks.row('run',next.runId).executionBudget,{tokenBudget:0,timeoutMs:0});
  f.finishTarget();f.supervisor.tick();review=f.supervisor.history(task.id)[0];
  f.supervisor.configure({id:task.id,runId:next.runId,paused:true});f.supervisor.configure({id:task.id,runId:next.runId,paused:false});f.supervisor.tick();
  const child=f.tasks.row('task',review.managementTaskId);assert.deepEqual(f.tasks.row('run',child.runId).executionBudget,{tokenBudget:0,timeoutMs:0});
});

test('cumulative limits can be cleared per dimension without erasing explicit per-run limits',t=>{
  const f=fixture(t),bound={id:f.base.id,runId:f.base.runId};
  f.supervisor.configure({...bound,tokenBudget:0,timeBudgetMs:0});let task=f.tasks.row('task',bound.id);
  assert.deepEqual(f.supervisor.continuationBudget(task),{executionBudget:{tokenBudget:200000,timeoutMs:1800000}});
  f.supervisor.configure({...bound,tokenBudget:1500});task=f.tasks.row('task',bound.id);
  assert.deepEqual(f.supervisor.continuationBudget(task),{executionBudget:{tokenBudget:1500,timeoutMs:1800000}});
  f.supervisor.tick();assert.deepEqual(f.supervisor.history(task.id)[0].budgets,{maxSteps:0,tokenBudget:1500,timeoutMs:0});
  for(const key of ['tokenBudget','timeBudgetMs'])for(const value of [-1,999,null,NaN,Infinity,'0'])assert.throws(()=>f.supervisor.configure({...bound,[key]:value}),/invalid_management_policy/);
});
