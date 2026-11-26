/** Durable Task / Run / Job records; command effects live in supervised workers. */
import {spawn} from 'node:child_process';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,statSync,realpathSync,openSync,readSync,closeSync,readdirSync,lstatSync} from 'node:fs';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readJson,saveJson,readSteps} from './agent-files.mjs';
import {TaskEventEngine} from './event-engine.mjs';
import {validateInputFiles,validateGeneralInputs,captureTaskInputs} from './documents.mjs';
import {freezeDocumentInputs,documentInputNames,documentDestination,isFrozenDocumentResearch} from './frozen-documents.mjs';
import {nativeFileMime} from '../desktop/file-types.mjs';
import {executionSpec,plainWorkspace} from './execution.mjs';
import {documentDeliveries} from './document-tools.mjs';
import {resolveTaskPath} from './filesystem.mjs';
import {workspaceDiff,applyWorkspace} from './workspace.mjs';
import {taskCandidateProfile} from '../../../scripts/candidate/install.mjs';
import {TeamReports} from '../team/reports.mjs';
import {TeamAssignments,planningSpec} from '../team/assignments.mjs';
import {validBudget,remainingBudget,capBudget} from './budgets.mjs';
import {taskActivity,readTaskActivity} from './activity.mjs';
import {canSummarizeFailure} from './failure.mjs';
import {TaskQueries} from './queries.mjs';
import {TaskClosure,taskIsClosed,assertTaskOpen} from './closure.mjs';
import {freezeTaskMedia,normalizeTaskMedia} from '../images/background.mjs';
import {hasRemoteMediaJob} from '../images/providers.mjs';
import {recoveryPlan} from './research-recovery.mjs';

const worker=fileURLToPath(new URL('./worker.mjs',import.meta.url));
const live=new Set(['queued','blocked','running','pausing','cancelling']);
const terminal=new Set(['completed','failed','cancelled','interrupted','paused','waiting_input','waiting_event']);
const idOk=value=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
const MAX_LOG=8*1024*1024;
const asyncMediaOperations=new Set(['image_generate','gif_generate']);
const mediaNames=['image_generate','gif_generate','media_export','gif_review'];
function mediaWaiting(record){
  if(!hasRemoteMediaJob(record))return;
  return {kind:'media',mediaOperationId:record.id,remoteTaskId:record.generation.taskId};
}
export class TaskManager {
  constructor({ops,home,workspace,events,spawnWorker=spawn,agentProviderModule,agentPluginModule,agentResearchConfig,bridge,eventOptions}){
    Object.assign(this,{ops,db:ops.db,workspace:realpathSync(workspace),events,spawnWorker,agentProviderModule,agentPluginModule,agentResearchConfig,bridge});
    this.root=join(home,'tasks');mkdirSync(this.root,{recursive:true,mode:0o700});
    this.workers=new Map();this.closed=false;
    for(const table of ['background_task','background_run','background_job','background_message'])
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, body TEXT NOT NULL)`);
    this.automation=new TaskEventEngine(this,eventOptions);
    this.reports=new TeamReports(this);
    this.queries=new TaskQueries(this);
    this.assignments=new TeamAssignments(this);
    this.closures=new TaskClosure(this);
    // A restart never replays commands, including a launch whose delivery was
    // uncertain. A surviving supervisor will publish its cleanup receipt.
    for(const task of this.queries.select({statuses:['running','pausing','cancelling'],includeManagement:true})){
      const run=this.row('run',task.runId),job=this.row('job',run.jobId);
      const receipt=this.receipt(job);
      this.finish(task,run,job,receipt??{status:'interrupted',cleanupConfirmed:false,error:'host_interrupted_checking_cleanup'});
    }
    this.restartResearch=new Map(this.queries.select({statuses:['interrupted']}).filter(isFrozenDocumentResearch).map(task=>[task.id,task.runId]));
    this.timer=setInterval(()=>this.tick(),250);this.timer.unref();
    // Inbox files are rebuilt from durable messages immediately before launch
    // (and when a message arrives), not for every historical session at startup.
    queueMicrotask(()=>this.tick());
  }
  row(kind,id){
    if(!idOk(id))throw Error('invalid_task_id');
    const row=this.db.prepare(`SELECT body FROM background_${kind} WHERE id=?`).get(id);
    if(!row)throw Error('unknown_task');return JSON.parse(row.body);
  }
  put(kind,record){this.db.prepare(`INSERT INTO background_${kind} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(record.id,JSON.stringify(record));return record;}
  atomic(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  all(){return this.db.prepare('SELECT body FROM background_task ORDER BY rowid DESC').all().map(r=>JSON.parse(r.body));}
  closureAncestor(task){
    const seen=new Set([task.id]);let parentId=task.parentTaskId??task.managementReview?.targetTaskId;
    while(parentId&&!seen.has(parentId)){
      const parent=this.row('task',parentId);if(taskIsClosed(parent))return {id:parent.id,title:parent.title,status:parent.closure.status};
      seen.add(parentId);parentId=parent.parentTaskId??parent.managementReview?.targetTaskId;
    }
  }
  assertOpen(task){assertTaskOpen(task);if(this.closureAncestor(task))throw Error('task_closed');}
  changed(task){this.events?.publish('task.updated',this.summary(task),task.requestId);this.notifications?.changed(task);}
  summary(task,{includeProjectContext=false}={}){
    const run=this.row('run',task.runId),job=this.row('job',run.jobId);
    const parentClosure=this.closureAncestor(task),closed=taskIsClosed(task)||!!parentClosure;
    let projectName;try{projectName=task.projectId?this.projects?.store.get(task.projectId).name:undefined;}catch{}
    // Historical dependencies are checked when viewed, not on every idle tick.
    const {projectContext,inputSnapshot,media,candidateReview,...visibleTask}=task;
    return {...visibleTask,...(candidateReview?{candidateReview:true}:{}),...(includeProjectContext?{projectContext,inputSnapshot}:{}),...(projectName?{projectName}:{}),...(task.dependencyInputs?.length?{inputsStale:this.assignments.staleInputs(task)}:{}),...this.team?.owner(task),runNumber:run.number,startedAt:run.startedAt,finishedAt:run.finishedAt,exitCode:job.exitCode,error:job.error,
      ...(media?{mediaOperation:media.operation}:{}),...(task.status==='waiting_event'&&job.agentResult?.awaiting?.kind==='media'?{awaiting:job.agentResult.awaiting}:{}),
      cleanupConfirmed:job.cleanupConfirmed,logTruncated:job.truncated??false,
      diagnostic:job.agentResult?.diagnostic,failurePhase:job.agentResult?.failurePhase,completedCommands:job.agentResult?.completedCommands,
      canRecoverSummary:!closed&&task.status==='failed'&&canSummarizeFailure(task,job,this.reports.current(task)),
      ...(parentClosure?{parentClosure}:{}),canClose:!task.managementReview&&!closed,canReopen:!task.managementReview&&!parentClosure&&task.closure?.status==='closed',
      canContinue:!closed&&task.kind==='agent'&&terminal.has(task.status)&&job.cleanupConfirmed===true&&!(task.status==='waiting_event'&&job.agentResult?.awaiting?.kind==='media'),
      question:job.agentResult?.question,...this.supervisor?.summary(task),
      canRetry:!closed&&task.kind!=='agent'&&['failed','cancelled','interrupted'].includes(task.status)&&job.cleanupConfirmed===true};
  }
  list(options={}){
    const page=this.queries.page(options);
    return {...page,tasks:page.tasks.map(t=>this.summary(t)),problem:this.lastError?'task_scheduler_failed':null};
  }
  spec(input,root=this.workspace,check,managementReview){
    const assignment=this.team?.assignment(check?{...input,kind:'agent',workspaceMode:'code'}:input)??{};
    const plan=planningSpec(input);
    const acceptanceCriteria=input.acceptanceCriteria??'';
    if(typeof acceptanceCriteria!=='string'||acceptanceCriteria.length>8000)throw Error('invalid_acceptance_criteria');
    const managementEnabled=check||managementReview?false:input.managementEnabled??!!assignment.assignedBotId,maxReworks=input.maxReworks??2;
    const tokenBudget=input.managementTokenBudget===undefined?0:input.managementTokenBudget,timeBudgetMs=input.managementTimeBudgetMs===undefined?0:input.managementTimeBudgetMs;
    if(typeof managementEnabled!=='boolean'||!Number.isInteger(maxReworks)||maxReworks<0||maxReworks>5||!validBudget(tokenBudget,1000,3000000)||!validBudget(timeBudgetMs,1000,28800000))throw Error('invalid_management_budget');
    const work={...plan,acceptanceCriteria,management:{enabled:managementEnabled,paused:false,maxReworks,tokenBudget,timeBudgetMs,usedReworks:0}};
    if(input.candidateReview!==undefined&&typeof input.candidateReview!=='boolean'||input.candidateReview&&(input.kind!=='agent'||check||managementReview))throw Error('invalid_candidate_review_task');
    if(input.kind==='agent'){
      const {title,goal,constraints='',timeoutMs=0,maxSteps=0,tokenBudget=0,autoContinue=0}=input;
      const execution=executionSpec(input),{mode}=execution;
      if(!Number.isInteger(autoContinue)||autoContinue<0||autoContinue>5||autoContinue&&mode!=='edit')throw Error('invalid_event_budget');
      if(typeof title!=='string'||!title.trim()||title.length>160||typeof goal!=='string'||!goal.trim()||goal.length>8000||typeof constraints!=='string'||constraints.length>4000)throw Error('invalid_agent_task');
      if(!['analysis','edit'].includes(mode)||!validBudget(maxSteps,1,128)||!validBudget(tokenBudget,1000,1000000))throw Error('invalid_agent_budget');
      if(!validBudget(timeoutMs,1000,7200000))throw Error('invalid_task_timeout');
      if(input.documentResearch!==undefined&&typeof input.documentResearch!=='boolean'||input.currentFile!==undefined&&typeof input.currentFile!=='boolean')throw Error('invalid_document_inputs');
      const nativeInputs=Array.isArray(input.inputFiles)&&input.inputFiles.some(p=>typeof p==='string'&&nativeFileMime(p));
      const documentResearch=input.documentResearch===true||input.currentFile===true||input.documentOutputPath!==undefined||
        (input.documentResearch!==false&&!input.media&&input.workspaceMode==='documents'&&nativeInputs);
      const workspaceMode=input.workspaceMode??(documentResearch?'documents':'general');
      if(documentResearch&&(workspaceMode!=='documents'||input.media||managementReview))throw Error('invalid_document_research_mode');
      if(input.documentOutputPath!==undefined&&execution.permission!=='full')throw Error('task_document_write_denied');
      const documentOutputPath=input.documentOutputPath===undefined?undefined:documentDestination(root,input.documentOutputPath);
      if(!['general','code','documents'].includes(workspaceMode))throw Error('invalid_workspace_mode');
      if(input.skillNames!==undefined&&(!Array.isArray(input.skillNames)||input.skillNames.length>20||input.skillNames.some(name=>typeof name!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))))throw Error('invalid_task_skills');
      if(input.candidateReview&&(workspaceMode!=='code'||execution.permission!=='full'||input.media||documentResearch))throw Error('invalid_candidate_review_task');
      const skillSelection=input.skillNames===undefined?{}:{skillNames:[...new Set(input.skillNames)]};
      const inputFiles=documentResearch?documentInputNames(input.inputFiles??[]):workspaceMode==='code'?[]:(workspaceMode==='documents'?validateInputFiles:validateGeneralInputs)(root,input.inputFiles??[]);
      const media=input.media===undefined?undefined:normalizeTaskMedia(input.media);
      if(media&&(managementReview||execution.permission!=='full'))throw Error('task_media_permission_denied');
      return {...assignment,...work,...execution,...skillSelection,...(input.candidateReview?{candidateReview:true}:{}),workspaceMode,inputFiles,kind:'agent',title:title.trim(),goal,constraints,timeoutMs,maxSteps,tokenBudget,cwd:root,artifacts:[],...(autoContinue?{autoContinue}:{}),...(media?{media}:{}),
        ...(documentResearch?{documentResearch:true,...(input.currentFile?{currentFile:true}:{}),...(documentOutputPath?{documentOutputPath}:{})}:{})};
    }
    if(input.kind&&input.kind!=='command')throw Error('invalid_task_kind');
    if(input.media!==undefined)throw Error('invalid_task_media');
    const {title,command}=input;
    if(typeof title!=='string'||!title.trim()||title.length>160||typeof command!=='string'||!command.trim()||command.length>16000||command.includes('\0'))throw Error('invalid_task_command');
    const workdir=input.workdir??'.';
    if(typeof workdir!=='string'||!workdir||workdir.includes('\0'))throw Error('invalid_task_workdir');
    let cwd;
    if(check){
      // The parent held by the host grants access; model arguments cannot do so.
      const parent=this.row('task',check.taskId);if(parent.runId!==check.runId)throw Error('task_run_changed');
      try{cwd=realpathSync(resolveTaskPath({...parent,workspace:root},workdir,{directory:true}));}catch{throw Error('invalid_task_workdir');}
    }else{
      try{cwd=realpathSync(resolve(root,workdir));}catch{throw Error('invalid_task_workdir');}
      const rel=relative(root,cwd);
      if(rel==='..'||rel.startsWith('../')||isAbsolute(rel)||!statSync(cwd).isDirectory())throw Error('invalid_task_workdir');
    }
    const timeoutMs=input.timeoutMs??1800000;
    if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>7200000)throw Error('invalid_task_timeout');
    const artifacts=input.artifacts??[];
    if(!Array.isArray(artifacts)||artifacts.length>20||artifacts.some(p=>typeof p!=='string'||!p||p.length>1000||p.includes('\0')||isAbsolute(p)||p.split(/[\\/]/).includes('..')))throw Error('invalid_task_artifacts');
    if(plan.dependsOn.length)throw Error('task_dependencies_require_agent');
    return {...assignment,...work,title:title.trim(),command,cwd,timeoutMs,artifacts};
  }
  create(input,{requestId,source='web',check,managementReview,inputVersions,fileReferences}={}){
    if(this.closed)throw Error('host_stopping');
    if(check)this.assertOpen(this.row('task',check.taskId));
    if(managementReview)this.assertOpen(this.row('task',managementReview.targetTaskId));
    const id=input.id;
    if(!idOk(id))throw Error('invalid_task_id');
    const old=this.db.prepare('SELECT body FROM background_task WHERE id=?').get(id);
    const previous=old?JSON.parse(old.body):null,parent=check?this.row('task',check.taskId):managementReview?this.row('task',managementReview.targetTaskId):null;
    const submissionFingerprint=hash(JSON.stringify(input));
    if(previous?.submissionFingerprint===submissionFingerprint)return this.detail(id);
    // A retry and a child inherit the original binding before validating paths.
    // Current frontend selection can never rebase a durable task's workspace.
    const inherited=previous??parent;
    const binding=inherited?{projectId:inherited.projectId,cwd:inherited.sourceWorkspace??(inherited.kind==='agent'?inherited.cwd:this.workspace),projectRevision:inherited.projectRevision,projectContext:inherited.projectContext}:this.projects?.taskBinding(requestId);
    const root=previous?.specWorkspace??check?.workspace??binding?.cwd??this.workspace;
    const spec=this.spec(input,root,check,managementReview),fingerprint=hash(JSON.stringify(spec));
    if(old){
      const task=previous;
      if(task.fingerprint!==fingerprint){
        // Lost acknowledgements may retry pre-upgrade omitted defaults. Preserve
        // the original policy and budgets; an explicit changed value still conflicts.
        const legacyInput=!task.managementPolicyVersion&&input.managementEnabled===undefined
          ?{...input,managementEnabled:!!(spec.assignedBotId&&spec.assignedBotId!==spec.supervisorBotId&&!check&&!managementReview)}:input;
        const legacy=[legacyInput!==input&&this.spec(legacyInput,root,check,managementReview),
          !task.budgetVersion&&this.spec({...legacyInput,managementTokenBudget:input.managementTokenBudget??600000,managementTimeBudgetMs:input.managementTimeBudgetMs??7200000,
            ...(input.kind==='agent'?{maxSteps:input.maxSteps??32,tokenBudget:input.tokenBudget??200000,timeoutMs:input.timeoutMs??1800000}:{})},root,check,managementReview)];
        if(!legacy.some(value=>value&&task.fingerprint===hash(JSON.stringify(value))))throw Error('task_id_conflict');
      }
      return this.detail(id);
    }
    if(spec.candidateReview)spec.candidateReview=taskCandidateProfile(dirname(this.root),root);
    this.assignments.validate(id,spec.dependsOn);
    if(this.queries.counts({statuses:[...live],includeManagement:true}).total>=100)throw Error('task_queue_full');
    const projectBinding=binding?{projectId:binding.projectId??null,sourceWorkspace:binding.cwd??root,specWorkspace:root,projectRevision:binding.projectRevision,projectContext:binding.projectContext}:{};
    const references=[...(fileReferences??binding?.fileReferences??binding?.projectContext?.references??[]),...(binding?.context?.kind==='file'?[binding.context.file]:[])].map(reference=>{
      let path;try{path=realpathSync(reference.path);}catch{}
      const observed=path&&inputVersions?.get(path);return observed?{...reference,version:observed}:reference;
    });
    const inputSnapshot=spec.documentResearch?freezeDocumentInputs({home:dirname(this.root),projectId:binding?.projectId,source:root,inputFiles:spec.inputFiles,
      currentFile:spec.currentFile,current:binding?.context?.file,references}):spec.kind==='agent'&&spec.inputFiles?.length?captureTaskInputs(root,spec.inputFiles,{workspaceMode:spec.workspaceMode,references}):undefined;
    if(spec.documentResearch){
      spec.inputFiles=inputSnapshot.files.map(f=>f.path);
      if(spec.documentOutputPath){
        if(inputSnapshot.files.some(f=>f.sourcePath===spec.documentOutputPath))throw Error('task_document_input_output_conflict');
        try{lstatSync(spec.documentOutputPath);throw Error('document_target_exists');}catch(e){if(e.code!=='ENOENT')throw e;}
      }
    }
    const media=spec.media?freezeTaskMedia({workspace:root,projectId:binding?.projectId,projectRevision:binding?.projectRevision,config:spec.media,inputSnapshot,projectContext:{...binding?.projectContext,references}}):undefined;
    const now=Date.now(),task={id,...spec,...projectBinding,inputSnapshot,...(media?{media}:{}),budgetVersion:2,managementPolicyVersion:1,teamReportVersion:1,createdBy:{kind:source==='assistant'||source==='supervisor'?'chief':'user',requestId},fingerprint,submissionFingerprint,requestId,source,status:'queued',createdAt:now,updatedAt:now,unread:false};
    if(managementReview)task.managementReview=managementReview;
    if(check)Object.assign(task,{parentTaskId:check.taskId,parentRunId:check.runId});
    if(task.kind==='agent')task.sessionId='session-'+randomUUID().replaceAll('-','');
    this.atomic(()=>{this.newRun(task,1);if(task.autoContinue)this.automation.add({id:'check-'+hash(task.id).slice(0,40),taskId:task.id,type:'check',enabled:true,maxRuns:task.autoContinue,instruction:'根据本轮测试或构建的真实结果继续原任务。失败时在原任务范围内分析修复，成功时汇总。不要重复已完成或状态不明的操作，不自动应用到原工程。'},{atomic:false});});this.changed(task);queueMicrotask(()=>this.tick());return this.detail(id);
  }
  runBudget(task){
    if(task.kind!=='agent'||!task.management?.enabled||task.managementReview)return null;
    const usage=this.supervisor?.usage(task)??{usedTokens:0,usedDurationMs:0};
    const tokenBudget=remainingBudget(task.management.tokenBudget??0,usage.usedTokens),timeoutMs=remainingBudget(task.management.timeBudgetMs??0,usage.usedDurationMs);
    if(tokenBudget<1000||timeoutMs<1000)throw Error('management_budget_exhausted');
    return {tokenBudget:capBudget(task.tokenBudget,tokenBudget),timeoutMs:capBudget(task.timeoutMs,timeoutMs)};
  }
  newRun(task,number,instruction,extra={}){
    this.assertOpen(task);
    const stored=this.db.prepare('SELECT body FROM background_task WHERE id=?').get(task.id);if(stored)this.assertOpen(JSON.parse(stored.body));
    const employee=this.team?.snapshot(task);
    const previous=task.runId?this.row('run',task.runId):null;
    const skills=task.kind==='agent'&&!task.managementReview?(previous&&previous.assignmentVersion===task.assignmentVersion&&previous.skills!==undefined?previous.skills:this.skills?.snapshot(task)??[]):[];
    const budget=this.runBudget(task);if(budget)extra={...extra,executionBudget:{tokenBudget:capBudget(budget.tokenBudget,extra.executionBudget?.tokenBudget),timeoutMs:capBudget(budget.timeoutMs,extra.executionBudget?.timeoutMs)}};
    if(task.media&&!skills.some(skill=>skill.name==='image-production')&&!extra.summaryRecovery)throw Error('task_media_skill_required');
    const run={employee,skills,projectId:task.projectId,sourceWorkspace:task.sourceWorkspace,assignmentVersion:task.assignmentVersion,permission:task.permission,policyVersion:task.policyVersion,id:randomUUID(),taskId:task.id,number,status:'queued',createdAt:Date.now(),jobId:randomUUID(),instruction,...(task.media?{media:task.media}:{}),...extra};
    const job={id:run.jobId,runId:run.id,taskId:task.id,projectId:task.projectId,status:'queued',cleanupConfirmed:true,createdAt:run.createdAt,kind:task.kind??'command'};
    task.runId=run.id;task.status='queued';task.updatedAt=run.createdAt;task.unread=false;
    this.put('job',job);this.put('run',run);this.put('task',task);
  }
  activity(task,run,job){
    const directory=this.directory(job);let logActivityAt;
    try{logActivityAt=statSync(join(directory,'output.log')).mtimeMs;}catch{}
    return taskActivity({task,run,job,record:readTaskActivity(join(directory,'activity.json')),logActivityAt,workerConnected:!!this.workers.get(job.id)?.connected,foregroundBusy:!!this.foregroundBusy?.()});
  }
  detail(id){
    const task=this.row('task',id),runs=this.db.prepare("SELECT body FROM background_run WHERE json_extract(body,'$.taskId')=? ORDER BY rowid").all(id).map(r=>JSON.parse(r.body));
    return {task:this.summary(task,{includeProjectContext:true}),skills:runs.find(run=>run.id===task.runId)?.skills??[],skillCandidates:this.skills?.candidates({taskId:id})??[],video:this.video?.view(id)??[],media:this.media?.view(id)??[],runs:runs.map(run=>{
      const job=this.row('job',run.jobId),directory=this.directory(job);
      return {...run,activity:this.activity(task,run,job),job:{...job,logPath:join(directory,'output.log')},...(task.kind==='agent'?{
        jobs:readSteps(directory),progress:readJson(join(directory,'progress.json')),result:job.agentResult??readJson(join(directory,'agent-result.json')),
      }:{})};
    }),teamReview:{...this.reports.view(task),...this.supervisor?.view(task)},...(task.kind==='agent'?{automation:this.automation.view(task),checks:this.queries.related({parentTaskId:id}).map(t=>this.summary(t)),workspace:readJson(join(this.agentHome(task),'workspace.json')),messages:this.messages(task),applications:Object.values(readJson(join(this.agentHome(task),'applications.json'),{}))}:{})};
  }
  review(body){this.assertOpen(this.row('task',body.id));if(!this.supervisor)throw Error('team_supervisor_unavailable');const decision=this.supervisor.userDecision(body);return {...this.detail(body.id),decision};}
  closeTask(body){return this.closures.close(body);}
  reopenTask(body){return this.closures.reopen(body);}
  configureManagement(body){this.assertOpen(this.row('task',body.id));if(!this.supervisor)throw Error('team_supervisor_unavailable');this.supervisor.configure(body);return this.detail(body.id);}
  reassign(body){this.assertOpen(this.row('task',body.id));return this.assignments.reassign(body);}
  setDependencies(body){this.assertOpen(this.row('task',body.id));return this.assignments.set(body);}
  reportArtifact(body){return this.reports.artifact(body);}
  ruleCreate(body){this.assertOpen(this.row('task',body.taskId));this.automation.add(body);this.changed(this.row('task',body.taskId));return this.detail(body.taskId);}
  ruleToggle(body){const previous=this.automation.find('rule',body.id);if(previous)this.assertOpen(this.row('task',previous.taskId));const rule=this.automation.setEnabled(body);return this.detail(rule.taskId);}
  automationPause(body){this.assertOpen(this.row('task',body.id));this.automation.setPaused(body);return this.detail(body.id);}
  createCheck({taskId,runId,stepId,title,command,workdir='.',timeoutMs=600000}){
    if(!idOk(stepId))throw Error('invalid_task_id');
    const task=this.row('task',taskId);
    this.assertOpen(task);
    if(task.runId!==runId)throw Error('task_run_changed');
    if(task.kind!=='agent'||task.mode!=='edit'||task.status!=='running'||!this.automation.canCheck(taskId))throw Error('task_check_unavailable');
    if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000)throw Error('invalid_task_timeout');
    const remaining=this.runBudget(task);if(remaining)timeoutMs=capBudget(timeoutMs,remaining.timeoutMs);
    const workspace=readJson(join(this.agentHome(task),'workspace.json'));
    if(!workspace)throw Error('task_workspace_not_ready');
    const id='check-'+hash(runId+'\0'+stepId).slice(0,48);
    const existing=this.queries.related({parentRunId:runId}).find(t=>t.id!==id);
    if(existing)throw Error('task_check_already_submitted');
    return this.create({id,assignedBotId:task.assignedBotId,title:title||'任务验证',command,workdir,timeoutMs},{source:'agent-check',check:{taskId,runId,workspace:workspace.path}});
  }
  stopChecks(task){for(const child of this.queries.related({parentTaskId:task.id}).filter(t=>live.has(t.status)))this.cancel(child.id,child.runId);}
  agentHome(task){return join(this.root,'agents',hash(task.id+(task.assignmentVersion>1?'\0assignment:'+task.assignmentVersion:'')));}
  messages(task){
    const acks=readJson(join(this.agentHome(task),'delivered.json'),{});
    return this.db.prepare("SELECT body FROM background_message WHERE json_extract(body,'$.taskId')=? ORDER BY rowid").all(task.id).map(r=>JSON.parse(r.body)).map(m=>({...m,delivery:acks[m.id]?.status==='sending'&&(!live.has(task.status)||acks[m.id].runId!==task.runId)?{...acks[m.id],status:'unknown'}:acks[m.id]??{status:'pending'}}));
  }
  syncInbox(task){saveJson(join(this.agentHome(task),'inbox.json'),this.messages(task).map(({delivery,...m})=>m));}
  message({id,messageId,text}){
    if(this.closed)throw Error('host_stopping');const task=this.row('task',id);
    this.assertOpen(task);
    if(task.kind!=='agent'||!idOk(messageId)||typeof text!=='string'||!text.trim()||text.length>4000)throw Error('invalid_task_message');
    const old=this.db.prepare('SELECT body FROM background_message WHERE id=?').get(messageId);
    if(old){const m=JSON.parse(old.body);if(m.taskId!==id||m.text!==text)throw Error('task_id_conflict');return this.detail(id);}
    if(this.messages(task).length>=100)throw Error('task_message_limit');
    this.put('message',{id:messageId,taskId:id,projectId:task.projectId,text,source:'user',assignmentVersion:task.assignmentVersion??1,createdAt:Date.now()});this.syncInbox(task);this.changed(task);return this.detail(id);
  }
  pause({id,runId,handoffActionId}){
    const task=this.row('task',id);if(task.kind!=='agent')throw Error('not_agent_task');
    if(task.runId!==runId)throw Error('task_run_changed');
    if(task.handoff?.status==='stopping'&&handoffActionId!==task.handoff.actionId)task.handoff={...task.handoff,status:'cancelled',reason:'user_paused'};
    task.automationPaused=true;task.management={...task.management,paused:true};this.put('task',task);this.stopChecks(task);
    this.video?.stop(task.id);
    this.media?.stop(task.id);
    if(!live.has(task.status)){if(task.status==='waiting_event'){const r=this.row('run',runId);this.finish(task,r,this.row('job',r.jobId),{status:'paused',cleanupConfirmed:true});}this.changed(task);return this.detail(id);}
    if(task.status==='cancelling')return this.detail(id);
    const run=this.row('run',runId),job=this.row('job',run.jobId);
    if(['queued','blocked'].includes(task.status))this.finish(task,run,job,{status:'paused',cleanupConfirmed:true});
    else{
      task.status='pausing';task.stopIntent='paused';this.atomic(()=>{this.put('task',task);this.put('run',{...run,status:'pausing'});this.put('job',{...job,status:'pausing'});});this.changed(task);
      const child=this.workers.get(job.id);if(child?.connected)child.send({type:'stop',reason:'interrupted'},()=>{});
    }
    return this.detail(id);
  }
  summaryRecoveryInput(task,run){
    const {reportId,sourceRunId}=run.summaryRecovery,report=this.reports.get(reportId,{fresh:true}),sourceRun=this.row('run',sourceRunId),job=this.row('job',sourceRun.jobId);
    if(sourceRun.taskId!==task.id||report.taskId!==task.id||report.assignmentVersion!==task.assignmentVersion||report.projectId!==task.projectId||!canSummarizeFailure({...task,runId:sourceRunId,status:'failed'},job,report))throw Error('task_summary_recovery_unavailable');
    const clip=value=>typeof value==='string'?value.slice(0,2000):value;
    const evidence={...report.evidence,steps:report.evidence.steps.slice(0,60).map(s=>({...s,output:clip(s.output)})),commands:report.evidence.commands.slice(0,40).map(c=>({...c,log:clip(c.log)})),checks:report.evidence.checks.slice(0,20).map(c=>({...c,log:clip(c.log),output:clip(c.output)}))};
    return {reportId,sourceRunId,report:{id:report.id,runId:report.runId,status:report.status,summary:report.summary,evidence,artifacts:report.artifacts.map(({id,name,status,sha256})=>({id,name,status,sha256})),note:'工具记录和输出按长度截取；原完整证据仍保存在原执行记录，缺失信息不可推测。'}};
  }
  continue({id,runId,actionId,text='',summaryOnly=false,reportId}){
    if(this.closed)throw Error('host_stopping');if(this.applying)throw Error('task_workspace_busy');
    const task=this.row('task',id);
    this.assertOpen(task);
    if(!idOk(actionId)||typeof text!=='string'||text.length>4000||typeof summaryOnly!=='boolean'||summaryOnly&&text.trim())throw Error('invalid_task_message');
    const recoveryKey=summaryOnly?reportId:undefined;
    if(task.lastContinueAction===actionId){if(task.lastContinueText!==text||task.lastSummaryReport!==recoveryKey)throw Error('task_id_conflict');return this.detail(id);}
    if(task.runId!==runId)throw Error('task_run_changed');
    if(!this.summary(task).canContinue)throw Error('task_retry_unavailable');
    let summaryRecovery;
    if(summaryOnly){
      const report=this.reports.assertCurrent(task,reportId),job=this.row('job',this.row('run',runId).jobId);
      if(!canSummarizeFailure(task,job,report))throw Error('task_summary_recovery_unavailable');
      summaryRecovery={reportId:report.id,sourceRunId:runId};
    }
    task.lastContinueAction=actionId;task.lastContinueText=text;task.lastSummaryReport=recoveryKey;delete task.stopIntent;
    this.atomic(()=>this.newRun(task,this.row('run',runId).number+1,summaryOnly?'仅根据已保存证据补充汇总，不重新执行命令或修改文件。':text||'请继续完成原任务，先核对已有结果。',{instructionSource:{kind:'user',actionId,previousRunId:runId},...(summaryRecovery?{summaryRecovery}:{})}));
    this.changed(task);queueMicrotask(()=>this.tick());return this.detail(id);
  }
  resumeVideo(record){
    const actionId='video-'+hash(record.id+'\0'+record.runId).slice(0,60),task=this.row('task',record.taskId);
    if(task.lastVideoResumeAction===actionId)return true;
    if(this.closed||this.applying||task.runId!==record.runId||task.assignmentVersion!==record.assignmentVersion||task.status!=='waiting_event'||task.automationPaused||task.management?.paused||taskIsClosed(task))return false;
    this.assertOpen(task);
    const run=this.row('run',record.runId),job=this.row('job',run.jobId);
    if(job.cleanupConfirmed!==true||this.workers.has(job.id)||job.agentResult?.awaiting?.videoRecordId!==record.id)return false;
    const context={kind:'video',recordId:record.id,remoteTaskId:record.remoteTaskId,remoteStatus:record.remoteStatus,outputDir:record.outputDir,waitingTimedOut:!!record.waitingTimedOut};
    if(record.autoGenerate&&record.remoteStatus==='succeeded'&&record.artifact?.sha256)context.artifact=record.artifact;
    const next=context.artifact?'交付回执中的 MP4 并核对成片。':record.autoGenerate?'使用原任务 ID 和目录调用 video_generate 续取或报告失败。':'核对同一远端任务，成功后下载和完成交付。';
    task.lastVideoResumeAction=actionId;
    this.atomic(()=>this.newRun(task,run.number+1,'视频后台跟进返回：'+JSON.stringify(context)+'。'+next,{instructionSource:{kind:'video',actionId,previousRunId:run.id},eventContext:context}));
    this.changed(task);queueMicrotask(()=>this.tick());return true;
  }
  installMedia(service){
    this.media=service;
    // Constructor recovery predates service installation. Only restore clean
    // interrupted Runs with a confirmed durable remote operation, never replay.
    for(const task of this.queries.select({statuses:['interrupted'],includeManagement:false})){
      if(!asyncMediaOperations.has(task.media?.operation)||task.stopIntent||taskIsClosed(task))continue;
      const run=this.row('run',task.runId),job=this.row('job',run.jobId),receipt=this.receipt(job);
      if(job.cleanupConfirmed===true&&receipt?.cleanupConfirmed===true&&this.mediaAwaiting(task,run))this.finish(task,run,job,receipt);
    }
  }
  mediaAwaiting(task,run){
    if(!asyncMediaOperations.has(task.media?.operation)||task.stopIntent||taskIsClosed(task)||this.closureAncestor(task))return null;
    const record=this.media?.awaiting(task.id,run.id);
    return record?.name===task.media.operation&&record.taskId===task.id&&record.projectId===task.projectId&&(record.assignmentVersion??1)===(task.assignmentVersion??1)?mediaWaiting(record):null;
  }
  resumeMedia(record){
    if(this.closed||this.applying||!idOk(record?.id)||!idOk(record?.taskId)||!idOk(record?.runId)||!mediaWaiting(record)||
        !['completed','failed','unknown','cancelled','interrupted'].includes(record.terminalStatus??record.status))return false;
    const task=this.row('task',record.taskId);
    const actionId='media-'+hash(record.id+'\0'+record.runId).slice(0,60);
    if(task.media?.operation!==record.name||task.projectId!==record.projectId||(task.assignmentVersion??1)!==(record.assignmentVersion??1))return false;
    if(task.lastMediaResumeAction===actionId)return true;
    if(task.runId!==record.runId||task.status!=='waiting_event'||taskIsClosed(task)||this.closureAncestor(task))return false;
    const run=this.row('run',record.runId),job=this.row('job',run.jobId),awaiting=job.agentResult?.awaiting;
    if(job.cleanupConfirmed!==true||this.workers.has(job.id)||awaiting?.kind!=='media'||awaiting.mediaOperationId!==record.id||awaiting.remoteTaskId!==record.generation.taskId)return false;
    const context={kind:'media',operationId:record.id,remoteTaskId:record.generation.taskId,status:record.terminalStatus??record.status,error:record.error,
      files:Object.fromEntries(Object.entries(record.artifacts??{}).map(([role,artifact])=>[role,{path:artifact.path,sha256:artifact.sha256}]))};
    task.lastMediaResumeAction=actionId;
    this.atomic(()=>this.newRun(task,run.number+1,'媒体后台跟进结果：'+JSON.stringify(context)+'。使用 task_media_status 查询同一个操作回执；仅汇总真实交付文件或错误，不重新提交生成。',{instructionSource:{kind:'media',actionId,previousRunId:run.id},eventContext:context,
      mediaResume:{operationId:record.id,originRunId:record.originRunId??record.runId}}));
    this.changed(task);queueMicrotask(()=>this.tick());return true;
  }
  async diff({id,runId}){
    const task=this.row('task',id);if(task.runId!==runId)throw Error('task_run_changed');
    if(plainWorkspace(task))throw Error('documents_no_git_diff');
    if(task.kind!=='agent'||!this.summary(task).canContinue||this.workers.size||this.applying)throw Error('task_workspace_busy');
    this.applying=true;try{return await workspaceDiff(this.agentHome(task));}finally{this.applying=false;}
  }
  async applyChanges(body){
    if(!idOk(body.actionId)||typeof body.revision!=='string')throw Error('invalid_task_id');
    const task=this.row('task',body.id);if(task.runId!==body.runId)throw Error('task_run_changed');
    if(plainWorkspace(task))throw Error('documents_no_git_diff');
    if(task.kind!=='agent'||task.mode!=='edit'||!this.summary(task).canContinue||this.workers.size||this.applying)throw Error('task_workspace_busy');
    this.applying=true;try{const application=await applyWorkspace(this.agentHome(task),body);return {...this.detail(task.id),application};}finally{this.applying=false;}
  }
  directory(job){return join(this.root,job.id);}
  receipt(job){
    try{
      const value=JSON.parse(readFileSync(join(this.directory(job),'result.json'),'utf8'));
      if(value.jobId!==job.id||value.runId!==job.runId||!terminal.has(value.status)||typeof value.cleanupConfirmed!=='boolean')return null;
      if(job.kind==='agent'&&value.cleanupConfirmed){
        for(const step of readSteps(this.directory(job)).filter(s=>s.tool==='task_command')){
          const directory=join(this.directory(job),'commands',step.id);
          if(!readJson(join(directory,'intent.json')))continue;
          const receipt=readJson(join(directory,'result.json'));
          if(receipt?.jobId!==step.id||receipt?.runId!==job.runId||!receipt?.cleanupConfirmed)return {...value,status:'interrupted',cleanupConfirmed:false,error:'task_command_cleanup_unconfirmed'};
        }
      }
      return value;
    }catch{return null;}
  }
  finish(task,run,job,result){
    // Stale workers can never overwrite a replacement Run.
    const current=this.row('task',task.id);if(current.runId!==run.id)return;
    // A worker captured before the user's close must preserve the durable intent.
    if(current.closure)task={...task,...(!task.closure?{stopIntent:current.stopIntent}:{}),closure:current.closure,automationPaused:true,management:{...task.management,paused:true}};
    else if(task.closure){task={...task};delete task.closure;}
    const finishedAt=result.finishedAt??Date.now();
    let agentResult=job.kind==='agent'?readJson(join(this.directory(job),'agent-result.json')):null;
    if(job.kind==='agent'){
      const research=readJson(join(this.directory(job),'research.json'));
      if(research?.runId===run.id&&research.taskId===task.id)agentResult={...agentResult,runId:run.id,taskId:task.id,sources:research.sources??[],research:research.research};
    }
    // The durable check receipt wins if HTTP delivery was lost after acceptance.
    // Interrupted Runs still require manual review; never replay uncertain work.
    const check=job.kind==='agent'&&this.queries.related({parentRunId:run.id})[0];
    if(check&&result.cleanupConfirmed&&['completed','failed'].includes(result.status)&&agentResult?.status!=='waiting_input'){
      agentResult={...agentResult,runId:run.id,status:'waiting_event',awaiting:{taskId:check.id,runId:check.runId},text:agentResult?.text||'检查已提交，等待结果事件接续。'};
      result={...result,status:'completed'};
    }
    // The server owns the generation receipt. If a worker lost its response
    // or the host restarted after the paid POST, exit to waiting with the same ID.
    const awaitingMedia=asyncMediaOperations.has(task.media?.operation)&&result.cleanupConfirmed&&!task.stopIntent&&
      ['completed','failed','interrupted','waiting_event'].includes(result.status)?this.mediaAwaiting(task,run):null;
    if(awaitingMedia){
      agentResult={...agentResult,runId:run.id,status:'waiting_event',awaiting:awaitingMedia,text:agentResult?.text||'媒体生成已提交，后台继续跟进同一个任务。'};
      result={...result,status:'completed',error:undefined};
    }else if(agentResult?.awaiting?.kind==='media'&&result.cleanupConfirmed&&asyncMediaOperations.has(task.media?.operation)&&this.media&&result.status==='completed'&&!task.stopIntent){
      agentResult={...agentResult,status:'failed',awaiting:undefined,error:'task_media_receipt_unavailable'};
      result={...result,status:'failed',error:'task_media_receipt_unavailable'};
    }
    if(task.media&&this.media&&result.status==='completed'&&agentResult?.status==='completed'&&!run.summaryRecovery&&!task.stopIntent){
      const receipts=this.media.evidence(task.id,run.id).filter(evidence=>evidence.operation===task.media.operation);
      const actual=receipts.at(-1);
      if(actual?.status!=='completed'){
        const error=typeof actual?.error==='string'&&/^[a-z][a-z0-9_]{1,120}$/.test(actual.error)?actual.error:'task_media_receipt_unavailable';
        agentResult={...agentResult,status:'failed',error};result={...result,status:'failed',error};
      }
    }
    // If the Agent already persisted its final answer before the supervisor
    // received the host disconnect, the report itself need not be regenerated.
    if(isFrozenDocumentResearch(task)&&result.status==='interrupted'&&result.cleanupConfirmed&&!current.stopIntent&&
      agentResult?.runId===run.id&&['completed','waiting_input'].includes(agentResult.status)&&typeof agentResult.text==='string'&&agentResult.text.trim())
      result={...result,status:'completed',error:undefined};
    const artifacts=this.artifacts(task,job);
    if(isFrozenDocumentResearch(task)&&task.documentOutputPath&&result.status==='completed'&&agentResult?.status==='completed'&&!task.stopIntent){
      const delivery=artifacts.find(a=>a.documentArtifactId&&a.path===task.documentOutputPath);
      if(delivery?.status!=='available'){
        const error=delivery?'task_document_delivery_changed':'task_document_receipt_unavailable';
        const text=delivery?'交付文件已被修改或移走，无法确认当前版本。':'未找到指定交付文件的成功生成回执。';
        agentResult={...agentResult,status:'failed',error,text};result={...result,status:'failed',error};
      }
    }
    const status=task.stopIntent&&result.cleanupConfirmed?task.stopIntent:task.status==='cancelling'&&result.cleanupConfirmed?'cancelled':
      result.status==='completed'&&job.kind==='agent'?(agentResult?.runId===run.id&&['completed','waiting_input','waiting_event'].includes(agentResult.status)?agentResult.status:'failed'):result.status;
    if(status==='failed'&&agentResult?.runId===run.id&&agentResult.error==='task_inputs_changed')result={...result,error:'task_inputs_changed'};
    if(job.kind==='agent'&&result.cleanupConfirmed)for(const step of readSteps(this.directory(job)).filter(s=>s.status==='running'||s.tool==='task_command')){
      const receipt=step.tool==='task_command'?readJson(join(this.directory(job),'commands',step.id,'result.json')):null;
      if(!receipt&&step.status!=='running')continue;
      // Preserve command chronology when reconciling its worker receipt at end of run.
      const stepEnd=[step.finishedAt,receipt?.finishedAt].find(time=>Number.isSafeInteger(time)&&time>=step.createdAt&&time<=finishedAt);
      saveJson(join(this.directory(job),'steps',step.id+'.json'),{...step,...(receipt??{status:'interrupted',error:'tool_outcome_unknown'}),id:step.id,finishedAt:stepEnd??finishedAt});
    }
    this.atomic(()=>{
      const finalJob={...job,...result,id:job.id,status,finishedAt,agentResult,artifacts};
      this.put('job',finalJob);
      const finalRun={...run,status,finishedAt};this.put('run',finalRun);
      task={...task,status,updatedAt:finishedAt,unread:true};this.put('task',task);
      this.automation.recordCompletion(task,{...run,status},{...job,...result,status});
      this.reports.capture(task,finalRun,finalJob);
      if(finalRun.skills?.length)this.skills?.recordUsage({taskId:task.id,runId:run.id,skills:finalRun.skills,status});
    });
    this.changed(task);
  }
  artifacts(task,job){
    if(this.media?.reportOnly(task,this.row('run',job.runId)))return [];
    const workspace=plainWorkspace(task)?readJson(join(this.agentHome(task),'workspace.json')):null;
    const root=plainWorkspace(task)?workspace?.path:task.cwd;
    if(plainWorkspace(task)&&!root)return [];
    let files=task.artifacts;
    if(plainWorkspace(task)&&root){
      files=[];const walk=(dir,prefix='')=>{for(const entry of readdirSync(dir,{withFileTypes:true})){
        // Keep one overflow candidate so reports can mark their 50-file snapshot incomplete.
        if(files.length>=51)return;
        if(entry.isSymbolicLink()||entry.name.startsWith('.')||['node_modules','__pycache__','.venv'].includes(entry.name))continue;
        const name=prefix+entry.name;if(entry.isDirectory()){if(name.split('/').length<6)walk(join(dir,entry.name),name+'/');}
        else if(entry.isFile()){
          const baseline=workspace?.inputBaseline?.[name],path=join(dir,entry.name);
          if(!(workspace?.inputFiles??task.inputFiles??[]).includes(name)||baseline&&(lstatSync(path).size!==baseline.size||hash(readFileSync(path))!==baseline.sha256))files.push(name);
        }
      }};try{walk(root);}catch{}
    }
    if(isFrozenDocumentResearch(task)){
      const seen=new Set(),rows=[];
      for(const a of documentDeliveries(this.ops,task)){
        if(seen.has(a.path)||!(a.path===task.documentOutputPath||relative(root,a.path)&&!relative(root,a.path).startsWith('..')&&!isAbsolute(relative(root,a.path))))continue;
        seen.add(a.path);
        const row={id:a.id,name:a.path===task.documentOutputPath?a.path.split('/').at(-1):relative(root,a.path),path:a.path,size:a.size,sha256:a.sha256,documentArtifactId:a.id};
        try{const s=lstatSync(a.path);if(!s.isFile()||realpathSync(a.path)!==a.path||s.size!==a.size||hash(readFileSync(a.path))!==a.sha256)throw Error();
          rows.push({...row,status:'available',mtimeMs:s.mtimeMs});}catch{rows.push({...row,status:'changed'});}
      }
      // The only other deliveries admitted to this profile are plain text
      // outputs. Inputs, task-private JSON specs and unreceipted binaries are not deliverables.
      files=files.filter(name=>/\.(md|txt)$/i.test(name)&&!workspace.inputFiles?.includes(name)&&!seen.has(resolve(root,name)));
      return [...rows,...files.map((name,index)=>{
        const path=resolve(root,name),row={name,path,id:job.id+'-text-'+index};
        try{const s=lstatSync(path);if(!s.isFile()||realpathSync(path)!==path)throw Error();
          return {...row,size:s.size,mtimeMs:s.mtimeMs,status:'available'};}catch{return {...row,status:'missing'};}
      })];
    }
    return files.map((path,index)=>{
      try{
        const absolute=realpathSync(resolve(root,path)),rel=relative(plainWorkspace(task)?root:task.sourceWorkspace??this.workspace,absolute),stat=statSync(absolute);
        if(rel==='..'||rel.startsWith('../')||isAbsolute(rel)||!stat.isFile())throw Error();
        return {id:`${job.id}-${index}`,path:absolute,name:path,size:stat.size,mtimeMs:stat.mtimeMs,status:'available'};
      }catch{return {id:`${job.id}-${index}`,name:path,status:'missing'};}
    });
  }
  tick(){
    if(this.closed)return;
    try{
      for(const {task,run,job} of this.queries.currentWork()){
        const receipt=this.receipt(job);
        if(receipt&&(live.has(task.status)||receipt.cleanupConfirmed!==job.cleanupConfirmed||receipt.error!==job.error))this.finish(task,run,job,receipt);
      }
      this.recoverResearch();
      this.closures.tick();
      void this.outbox?.tick().catch(()=>{});
      this.automation.tick();this.supervisor?.tick();this.assignments.tick();this.watch?.tick();void this.video?.tick().catch(()=>{});void this.media?.tick().catch(()=>{});this.skillService?.tick();this.notifications?.tick();this.lastError=null;
      // One active project command. Unconfirmed cleanup also holds the slot.
      if(this.applying||this.workers.size||this.queries.holdsSlot())return;
      if(this.foregroundBusy?.())return;
      const next=this.queries.nextQueued();if(next&&(!isFrozenDocumentResearch(next)||!this.bridge||this.runtimeBridge))this.launch(next);
    }catch(error){this.lastError=String(error.message);}
  }
  recoverResearch(){
    if(this.closed||this.bridge&&!this.runtimeBridge)return;
    for(const [id,runId] of this.restartResearch){
      const task=this.row('task',id);
      if(task.runId!==runId||task.status!=='interrupted'){this.restartResearch.delete(id);continue;}
      const run=this.row('run',runId),job=this.row('job',run.jobId);
      if(!job.cleanupConfirmed||this.workers.has(job.id))continue;
      const plan=recoveryPlan(this,task,run,job);
      this.restartResearch.delete(id);
      if(!plan)continue;
      if(plan.block){this.put('job',{...job,error:plan.block});this.changed(task);continue;}
      this.atomic(()=>this.newRun(task,run.number+1,run.instruction,{...plan,instructionSource:{kind:'restart',previousRunId:run.id}}));
      this.changed(task);
    }
  }
  launch(task){
    const current=this.row('task',task.id);if(current.runId!==task.runId)return;this.assertOpen(current);task=current;
    const run=this.row('run',task.runId),job=this.row('job',run.jobId),startedAt=Date.now();
    try{if(this.team)this.team.assignment(task);}catch(error){this.finish(task,run,job,{status:'failed',cleanupConfirmed:true,error:error.message});return;}
    if(run.trigger){const rule=this.automation.find('rule',run.trigger.ruleId);if(task.automationPaused||!rule?.enabled||rule.expiresAt<=this.automation.now()){task.automationPaused=true;this.finish(task,run,job,{status:'paused',cleanupConfirmed:true});return;}}
    try{mkdirSync(this.directory(job),{mode:0o700});}catch{this.finish(task,run,job,{status:'failed',error:'task_directory_failed',cleanupConfirmed:true});return;}
    task={...task,status:'running',updatedAt:startedAt};run.status='running';run.startedAt=startedAt;job.status='running';job.cleanupConfirmed=false;
    this.atomic(()=>{this.put('task',task);this.put('run',run);this.put('job',job);});this.changed(task);
    let child;
    try{
      let command=task.command;
      if(task.kind==='agent'){
        this.syncInbox(task);
        const specPath=join(this.directory(job),'agent-spec.json');
        let bridge=this.bridge;
        if(bridge&&task.policyVersion>=2&&this.runtimeBridge){
          const token=randomBytes(32).toString('hex'),tokenPath=join(this.directory(job),'bridge.token');
          writeFileSync(tokenPath,token,{mode:0o600});
          run.toolTokenHash=hash(token);this.put('run',run);
          bridge={url:bridge.url,tokenPath,scoped:true,hostTools:this.runtimeBridge.hostTools};
        }
        saveJson(specPath,{taskId:task.id,projectId:task.projectId,projectContext:task.projectContext,sourceWorkspace:task.sourceWorkspace,runId:run.id,runNumber:run.number,runDir:this.directory(job),agentHome:this.agentHome(task),source:task.cwd,
          employee:run.employee,skills:run.skills??[],assignmentVersion:run.assignmentVersion,workspaceMode:task.workspaceMode,...(task.candidateReview?{candidateReview:task.candidateReview}:{}),inputFiles:task.inputFiles,inputSnapshot:task.inputSnapshot,
          ...(isFrozenDocumentResearch(task)?{documentResearch:true,documentOutputPath:task.documentOutputPath}:{}),
          ...(run.media?{media:run.media}:{}),...(run.mediaResume?{mediaResume:run.mediaResume}:{}),
          sessionId:task.sessionId,goal:task.goal,constraints:task.constraints,acceptanceCriteria:task.acceptanceCriteria,managementReview:task.managementReview,
          ...(run.researchResume?{researchResume:run.researchResume}:{}),
          ...(run.summaryRecovery?{summaryRecovery:this.summaryRecoveryInput(task,run)}:{}),
          transferInputs:task.transferInputs,dependencyInputs:task.dependencyInputs,mode:task.mode,permission:task.permission,policyVersion:task.policyVersion,maxSteps:run.researchResume?.remainingSteps??task.maxSteps,tokenBudget:run.executionBudget?.tokenBudget??task.tokenBudget,
          timeoutMs:run.executionBudget?.timeoutMs??task.timeoutMs,instruction:run.instruction,eventContext:run.eventContext,checksEnabled:this.automation.canCheck(task.id),bridge,providerModule:this.agentProviderModule,agentPluginModule:this.agentPluginModule,researchConfig:this.agentResearchConfig});
        const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
        command=[process.execPath,fileURLToPath(new URL('./agent-runner.mjs',import.meta.url)),specPath].map(quote).join(' ');
      }
      child=this.spawnWorker(process.execPath,[worker,this.directory(job)],{cwd:isFrozenDocumentResearch(task)?this.directory(job):task.cwd,detached:true,
        env:{...process.env,NODE_OPTIONS:''},stdio:['ignore','ignore','ignore','ipc']});
      this.workers.set(job.id,child);
      child.on('message',message=>{
        if(this.closed)return;
        if(message.type==='log')this.events?.publish('task.log',{taskId:task.id,runId:run.id,jobId:job.id,bytes:message.bytes,truncated:message.truncated},task.requestId);
        if(message.type==='result')this.tick();
      });
      const exited=()=>{
        this.workers.delete(job.id);
        if(this.closed)return;
        const current=this.row('task',task.id),receipt=this.receipt(job);
        if(current.runId===run.id&&live.has(current.status))this.finish(current,run,job,receipt??{status:'interrupted',cleanupConfirmed:false,error:'worker_lost_check_state'});
        this.tick();
      };
      child.once('exit',exited);
      child.once('error',()=>{
        this.workers.delete(job.id);
        if(!this.closed)this.finish(this.row('task',task.id),run,job,{status:'failed',cleanupConfirmed:true,error:'worker_spawn_failed'});
      });
      child.send({type:'start',spec:{jobId:job.id,runId:run.id,command,cwd:isFrozenDocumentResearch(task)?this.directory(job):task.cwd,timeoutMs:run.executionBudget?.timeoutMs??task.timeoutMs,logLimit:MAX_LOG}},()=>{});
    }catch(error){
      this.workers.delete(job.id);this.finish(task,run,job,{status:'failed',cleanupConfirmed:!child?.pid,error:error?.message==='task_summary_recovery_unavailable'?'task_summary_recovery_unavailable':'worker_spawn_failed'});
    }
  }
  cancel(id,expectedRunId){
    const task=this.row('task',id),run=this.row('run',task.runId),job=this.row('job',run.jobId);
    if(expectedRunId&&expectedRunId!==task.runId)throw Error('task_run_changed');
    this.video?.stop(task.id);
    this.media?.stop(task.id);
    if(task.kind==='agent'){task.automationPaused=true;task.management={...task.management,paused:true};if(task.handoff?.status==='stopping')task.handoff={...task.handoff,status:'cancelled',reason:'user_cancelled'};this.put('task',task);this.stopChecks(task);}
    if(['paused','waiting_input','waiting_event'].includes(task.status)){delete task.stopIntent;this.finish(task,run,job,{status:'cancelled',cleanupConfirmed:true});return this.detail(id);}
    if(!live.has(task.status))return this.detail(id);
    if(['queued','blocked'].includes(task.status))this.finish(task,run,job,{status:'cancelled',cleanupConfirmed:true});
    else{
      task.status='cancelling';task.stopIntent='cancelled';task.updatedAt=Date.now();
      this.atomic(()=>{this.put('task',task);this.put('run',{...run,status:'cancelling'});this.put('job',{...job,status:'cancelling'});});this.changed(task);
      const child=this.workers.get(job.id);if(child?.connected)child.send({type:'stop',reason:'cancelled'},()=>{});
    }
    return this.detail(id);
  }
  retry({id,runId,actionId}){
    if(this.closed)throw Error('host_stopping');
    if(!idOk(actionId))throw Error('invalid_task_id');
    const task=this.row('task',id);
    this.assertOpen(task);
    if(task.lastRetryAction===actionId)return this.detail(id);
    if(task.runId!==runId)throw Error('task_run_changed');
    if(!this.summary(task).canRetry)throw Error('task_retry_unavailable');
    const number=this.row('run',task.runId).number+1;
    task.lastRetryAction=actionId;delete task.stopIntent;this.atomic(()=>this.newRun(task,number));this.changed(task);queueMicrotask(()=>this.tick());return this.detail(id);
  }
  read({id,runId}){
    const task=this.row('task',id);if(task.runId===runId&&terminal.has(task.status)){task.unread=false;this.put('task',task);this.changed(task);}return this.summary(task);
  }
  jobFor(id,runId){const task=this.row('task',id),run=this.row('run',runId??task.runId);if(run.taskId!==id)throw Error('unknown_task');return this.row('job',run.jobId);}
  log({id,runId,stepId,offset=0,limit=32768}){
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<4||limit>65536)throw Error('invalid_log_range');
    const job=this.jobFor(id,runId);let directory=this.directory(job);
    if(stepId!==undefined){
      if(!idOk(stepId)||job.kind!=='agent'||!readSteps(directory).some(s=>s.id===stepId&&s.tool==='task_command'))throw Error('unknown_task_step');
      directory=join(directory,'commands',stepId);
    }
    const path=join(directory,'output.log'),receipt=stepId?readJson(join(directory,'result.json')):job;let fd;
    try{
      fd=openSync(path,'r');const size=statSync(path).size;
      if(offset>size)throw Error('invalid_log_range');
      const buffer=Buffer.alloc(Math.min(limit,size-offset));let length=readSync(fd,buffer,0,buffer.length,offset);
      // Keep the cursor on UTF-8 boundaries. The worker writes complete strings.
      if(offset+length<size&&length){const tail=Buffer.alloc(1);readSync(fd,tail,0,1,offset+length);if((tail[0]&0xc0)===0x80){length--;while(length>0&&(buffer[length]&0xc0)===0x80)length--;}}
      return {text:buffer.subarray(0,length).toString('utf8'),offset,nextOffset:offset+length,size,hasMore:offset+length<size,runId:job.runId,stepId,truncated:receipt?.truncated??false};
    }catch(error){if(error.code==='ENOENT')return {text:'',offset:0,nextOffset:0,size:0,hasMore:false,runId:job.runId};throw error;}
    finally{if(fd!==undefined)closeSync(fd);}
  }
  artifact({id,runId,artifactId}){
    const job=this.jobFor(id,runId),artifact=job.artifacts?.find(a=>a.id===artifactId);
    if(!artifact||artifact.status!=='available')throw Error('task_artifact_missing');
    try{const path=realpathSync(artifact.path),stat=statSync(path);if(path!==artifact.path||!stat.isFile()||stat.size!==artifact.size||stat.mtimeMs!==artifact.mtimeMs)throw Error();return artifact;}
    catch{throw Error('task_artifact_changed');}
  }
  async close(){
    if(this.closing)return this.closing;
    this.closed=true;clearInterval(this.timer);
    return this.closing=(async()=>{
      await this.skillService?.syncing;
      await this.video?.close();
      await this.media?.close();
      await this.outbox?.close();
      await this.automation.close();
      await Promise.all([...this.workers.values()].map(child=>new Promise(resolveDone=>{
        const timer=setTimeout(resolveDone,6500);child.once('exit',()=>{clearTimeout(timer);resolveDone();});
        if(child.connected){child.send({type:'stop',reason:'interrupted'},()=>{});child.disconnect();}
      })));
      for(const task of this.queries.select({statuses:['running','pausing','cancelling'],includeManagement:true})){
        const run=this.row('run',task.runId),job=this.row('job',run.jobId);
        this.finish(task,run,job,this.receipt(job)??{status:'interrupted',cleanupConfirmed:false,error:'cleanup_unconfirmed'});
      }
    })();
  }
}

export function taskTools(tasks,getRequest){
  const request=()=>{const r=getRequest();if(!r||r.cancelled||r.signal?.aborted)throw Error('bridge_request_required');return r;};
  return [
    ['background_task_review','用户明确验收、要求修改或回答员工问题时使用；先查询当前任务和成果版本。验收不应用代码或发布。',{id:{type:'string',required:true},runId:{type:'string',required:true},reportId:{type:'string',required:true},action:{type:'string',enum:['accept','request_changes','answer','needs_user'],required:true},text:{type:'string',required:true}},a=>tasks.review({...a,actionId:hash(request().id+'\0review\0'+JSON.stringify(a))})],
    ['background_task_management','按用户要求设置总管自动跟进；暂停不停止当前执行，需要停止用background_agent_pause。不得自行扩大返工次数或预算。',{id:{type:'string',required:true},runId:{type:'string',required:true},enabled:{type:'boolean'},paused:{type:'boolean'},maxReworks:{type:'integer'},tokenBudget:{type:'integer',description:'用户明确指定的累计Token上限，0表示不限制，有限值1000–3000000。'},timeBudgetMs:{type:'integer',description:'用户明确指定的累计执行时长上限，毫秒；0表示不限制，有限值最多8小时。'},retryReview:{type:'boolean',description:'用户明确要求仅重试失败的自动验收时设true；不重新执行原任务。'},reportId:{type:'string'},reviewId:{type:'string'}},a=>tasks.configureManagement({...a,actionId:hash(request().id+'\0review-retry\0'+JSON.stringify(a))})],
    ['background_task_reassign','仅用户明确要求改派时使用；先查询runId、assignmentVersion和员工ID。先清理旧执行，再以新会话交接摘要和指定成果。',{id:{type:'string',required:true},runId:{type:'string',required:true},assignmentVersion:{type:'integer',required:true},assignedBotId:{type:'string',required:true},summary:{type:'string',required:true},reportId:{type:'string'}},a=>tasks.reassign({...a,actionId:hash(request().id+'\0handoff\0'+JSON.stringify(a))})],
    ['background_task_dependencies','按用户明确要求配置尚未开始的Agent任务前置依赖；前置成果必须验收后才能放行。不猜测依赖关系。',{id:{type:'string',required:true},runId:{type:'string',required:true},dependsOn:{type:'array',items:{type:'string'},required:true},priority:{type:'string',enum:['low','normal','high']},dueAt:{type:'number'}},a=>{request();return tasks.setDependencies(a);}],
    ['background_agent_rule','只有用户明确要求时，为指定任务配置事件接续规则。type=check/task/file/github；source 必须按类型精确指定。默认停用，enabled=true 表示用户授权启用。',{taskId:{type:'string',required:true},type:{type:'string',enum:['check','task','file','github'],required:true},instruction:{type:'string',required:true},source:{type:'object',additionalProperties:false,properties:{taskId:{type:'string'},runId:{type:'string'},paths:{type:'array',items:{type:'string'}},repository:{type:'string'},number:{type:'integer'},authors:{type:'array',items:{type:'string'}}},description:'task: taskId/runId；file: paths；github: repository/number/authors（仅 /opennova 前缀评论）。'},maxRuns:{type:'number'},ttlHours:{type:'number'},enabled:{type:'boolean'}},a=>tasks.ruleCreate({...a,id:hash(request().id+'\0rule\0'+JSON.stringify(a))})],
    ['background_agent_automation','按用户要求暂停或恢复该任务的自动接续。暂停自动接续不停止已运行的轮次；要立即停止请用 background_agent_pause。',{id:{type:'string',required:true},paused:{type:'boolean',required:true}},a=>{request();return tasks.automationPause(a);}],
    ['background_agent_start','创建独立后台数字员工工作会话。承接前台决定时，把已选方案、用户给出的约束和交付要求写入目标。用户未指定实现方式时，具体工具、底稿格式和步骤由执行员工选择。明确只读时用 read-only。基于文件的后台研究设置 documentResearch=true、workspaceMode=documents，按用户点名的文件名/路径给 inputFiles；用户说当前文件传 currentFile=true。仅用户明确指定最终 Word/PDF 交付位置时传 documentOutputPath。启动时锁定输入字节，继续原任务不会重读原件。普通代码和通用任务使用对应模板。提交后主对话仍可交流。',{
      candidateReview:{type:'boolean',description:'用户要内部员工修复并验证 OpenNova 自身的无音频文字启动候选版时设 true，配合 workspaceMode=code。使用宿主登记的验收配置。'},
      documentResearch:{type:'boolean',description:'按用户要求后台研究文件时设 true。'},currentFile:{type:'boolean',description:'把本轮绑定的当前文件纳入固定输入。'},documentOutputPath:{type:'string',description:'用户指定的最终 .docx/.pdf 本机目标路径，须不存在。'},
      acceptanceCriteria:{type:'string',description:'从用户目标提取的可验证交付标准，不添加用户未要求的工作。'},managementEnabled:{type:'boolean',description:'总管亲自执行及员工任务均默认启用独立成果检查与跟进；用户明确关闭时设false。'},maxReworks:{type:'integer',description:'默认最多两次自动返工，只有用户要求调整时填写，0–5。'},managementTokenBudget:{type:'integer',description:'可选累计Token预算，默认0表示不限制；只有用户明确要求设置上限时填写有限值。'},managementTimeBudgetMs:{type:'integer',description:'可选累计执行时长毫秒，默认0表示不限制；只有用户明确要求设置上限时填写有限值。'},dependsOn:{type:'array',items:{type:'string'},description:'用户明确指定的前置任务ID，等待其已验收成果。'},priority:{type:'string',enum:['low','normal','high']},dueAt:{type:'number',description:'用户明确的截止时间，Unix毫秒；用于排序提醒，独立于执行超时。'},
      assignedBotId:{type:'string',description:'team_list 返回的员工 ID；省略由总管负责。'},skillNames:{type:'array',items:{type:'string'},description:'指定该员工已绑定的技能名称；省略自动匹配，空数组不使用技能。'},workspaceMode:{type:'string',enum:['general','code','documents'],description:'任务模板，默认general；code准备Git快照，documents用于固定文件研究或普通文本任务。模板不限制工具权限。'},inputFiles:{type:'array',items:{type:'string'},description:'研究资料用项目内唯一文件名或相对路径；绝对路径须位于项目或是已关联文件。研究最多10份共40MiB，PDF/Word/Excel/图像单份20MiB，文本64KiB。普通general仍用项目相对路径。'},title:{type:'string',required:true},goal:{type:'string',required:true},constraints:{type:'string'},permission:{type:'string',enum:['full','read-only'],description:'执行权限，默认full；只有用户明确要求只读时选择read-only。完整执行使用已接入且已授权的工具，不新增外部账号。'},mode:{type:'string',enum:['analysis','edit'],description:'旧客户端兼容字段，优先使用permission；analysis对应read-only，edit对应full，不得冲突。'},timeoutMs:{type:'number',description:'每轮执行时限毫秒，默认0不限制；只有用户明确要求时设置有限值。'},maxSteps:{type:'number',description:'每轮模型步骤上限，默认0不限制；只有用户明确要求时设置有限值。'},tokenBudget:{type:'number',description:'每轮Token预算，默认0不限制；只有用户明确要求时设置有限值。'},autoContinue:{type:'number',description:'仅用户明确要求测试完成自动接续时设置，1–5 次；默认关闭。'},
      media:{type:'object',additionalProperties:false,description:'仅用户明确委派生成/修改静态图、制作 GIF、本地导出或审阅 GIF 时填写。只给提示词时不要填写。员工须已绑定 image-production；选择一个实际操作。',properties:{
        operation:{type:'string',enum:mediaNames,required:true},characterIds:{type:'array',items:{type:'string'},description:'当前项目已批准角色的标识，需明确涉及该角色时填写。'},
        projectInputs:{type:'array',items:{type:'string'},description:'用户指定的项目参考文件路径，均为当前项目相对路径。'},
        outputPath:{type:'string',description:'仅用户明确要求保存回项目时填：当前项目内准确的新文件路径（GIF 为新目录）。省略则交付到独立任务目录。'},
      }},
    },a=>{const r=request(),input={...a,kind:'agent'},root=tasks.projects?.taskBinding(r.id)?.cwd??tasks.workspace;return tasks.create({...input,id:hash(r.id+'\0'+JSON.stringify(tasks.spec(input,root)))},{requestId:r.id,source:'assistant',inputVersions:r.objectReads,fileReferences:r.fileReferences});}],
    ['background_agent_message','向指定后台 Agent 任务补充要求。只表示消息已保存，不能声称正在执行的操作已经按新要求修改。',{id:{type:'string',required:true},text:{type:'string',required:true}},a=>tasks.message({...a,messageId:hash(request().id+'\0'+a.id+'\0'+a.text)})],
    ['background_agent_pause','暂停后台 Agent，停止模型和工具，保留工作区和会话供继续。先查询当前 runId。',{id:{type:'string',required:true},runId:{type:'string',required:true}},a=>{request();return tasks.pause(a);}],
    ['background_agent_continue','用户要求继续、回答任务问题或接着修改时，沿用同一任务会话和工作目录创建新 Run。明确要求仅补汇总时设summaryOnly=true并填写当前reportId，此时所有工具禁用，不重新执行命令。',{id:{type:'string',required:true},runId:{type:'string',required:true},text:{type:'string'},summaryOnly:{type:'boolean'},reportId:{type:'string'}},a=>tasks.continue({...a,actionId:hash(request().id+'\0continue\0'+JSON.stringify(a))})],
    ['background_agent_diff','查看已停止 Agent 任务的文件差异和版本，用于审阅或应用到原工程。',{id:{type:'string',required:true},runId:{type:'string',required:true}},a=>tasks.diff(a)],
    ['background_agent_apply','按用户明确要求将已检查的任务差异应用到原工程；必须使用刚查询的 revision，冲突时停止。',{id:{type:'string',required:true},runId:{type:'string',required:true},revision:{type:'string',required:true}},a=>tasks.applyChanges({...a,actionId:hash(request().id+'\0'+a.id+'\0'+a.revision)})],
    ['background_task_start','将明确的测试、构建或脚本交给后台执行，立即返回任务编号；随后结束本轮等待，用户可继续聊天。不要循环等待。命令在项目内目录运行，不能守护化；结束交流或停止播报不会取消任务。',{
      assignedBotId:{type:'string',description:'team_list 的员工 ID；省略由总管负责。'},managementEnabled:{type:'boolean',description:'默认独立检查命令结果；用户明确关闭自动检查时设false。失败命令不会自动重放。'},title:{type:'string',required:true},command:{type:'string',required:true},workdir:{type:'string'},timeoutMs:{type:'number'},artifacts:{type:'array',items:{type:'string'},description:'需要展示的结果文件，相对执行目录；最多 20 项。'},
    },args=>{
      const request=getRequest();if(!request||request.cancelled||request.signal?.aborted)throw Error('bridge_request_required');
      const root=tasks.projects?.taskBinding(request.id)?.cwd??tasks.workspace;
      return tasks.create({...args,id:hash(request.id+'\0'+JSON.stringify(tasks.spec(args,root)))},{requestId:request.id,source:'assistant'});
    }],
    ['background_task_list','查询后台任务的真实状态与结果；默认当前项目，明确查询另一项目时填写projectId；filter=closed查看已关闭历史；不执行或重跑命令。',{filter:{type:'string',enum:['all','active','attention','recent','closed']},projectId:{type:'string'}},(a={})=>{const r=getRequest();return tasks.list({limit:30,...(a.filter?{filter:a.filter}:{}),...(a.projectId?{projectId:a.projectId}:tasks.projects?{projectId:r?.projectId??r?.binding?.projectId??null}:{})});}],
    ['background_task_status','查询指定后台任务及每次执行的实际结果。',{id:{type:'string',required:true}},a=>tasks.detail(a.id)],
    ['background_task_log','读取后台任务日志，nextOffset 可用于继续读取。',{id:{type:'string',required:true},runId:{type:'string'},stepId:{type:'string',description:'Agent 命令步骤编号，可读取该步骤的实时日志。'},offset:{type:'number'}},a=>tasks.log(a)],
    ['background_task_cancel','用户要求取消指定后台任务时使用；取消中不代表进程已停止，也不撤销已保存文件。',{id:{type:'string',required:true}},a=>tasks.cancel(a.id)],
    ['background_task_retry','用户明确要求重试已停止的失败、取消或中断任务时，创建新的执行尝试。先查询当前 runId。',{id:{type:'string',required:true},runId:{type:'string',required:true}},a=>{
      const request=getRequest();if(!request||request.cancelled)throw Error('bridge_request_required');
      return tasks.retry({...a,actionId:hash(request.id+'\0'+a.id+'\0'+a.runId)});
    }],
  ];
}
