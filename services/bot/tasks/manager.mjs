/** Durable Task / Run / Job records; command effects live in supervised workers. */
import {spawn} from 'node:child_process';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,statSync,realpathSync,openSync,readSync,closeSync,readdirSync,lstatSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readJson,saveJson,readSteps} from './agent-files.mjs';
import {TaskEventEngine} from './event-engine.mjs';
import {validateInputFiles,validateGeneralInputs} from './documents.mjs';
import {executionSpec,plainWorkspace} from './execution.mjs';
import {workspaceDiff,applyWorkspace} from './workspace.mjs';
import {TeamReports} from '../team/reports.mjs';
import {TeamAssignments,planningSpec} from '../team/assignments.mjs';
import {validBudget,remainingBudget,capBudget} from './budgets.mjs';
import {taskActivity,readTaskActivity} from './activity.mjs';

const worker=fileURLToPath(new URL('./worker.mjs',import.meta.url));
const live=new Set(['queued','blocked','running','pausing','cancelling']);
const terminal=new Set(['completed','failed','cancelled','interrupted','paused','waiting_input','waiting_event']);
const idOk=value=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
const MAX_LOG=8*1024*1024;
export class TaskManager {
  constructor({ops,home,workspace,events,spawnWorker=spawn,agentProviderModule,agentPluginModule,agentResearchConfig,bridge,eventOptions}){
    Object.assign(this,{db:ops.db,workspace:realpathSync(workspace),events,spawnWorker,agentProviderModule,agentPluginModule,agentResearchConfig,bridge});
    this.root=join(home,'tasks');mkdirSync(this.root,{recursive:true,mode:0o700});
    this.workers=new Map();this.closed=false;
    for(const table of ['background_task','background_run','background_job','background_message'])
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, body TEXT NOT NULL)`);
    this.automation=new TaskEventEngine(this,eventOptions);
    this.reports=new TeamReports(this);
    this.assignments=new TeamAssignments(this);
    // A restart never replays commands, including a launch whose delivery was
    // uncertain. A surviving supervisor will publish its cleanup receipt.
    for(const task of this.all())if(live.has(task.status)&&!['queued','blocked'].includes(task.status)){
      const run=this.row('run',task.runId),job=this.row('job',run.jobId);
      const receipt=this.receipt(job);
      this.finish(task,run,job,receipt??{status:'interrupted',cleanupConfirmed:false,error:'host_interrupted_checking_cleanup'});
    }
    this.timer=setInterval(()=>this.tick(),250);this.timer.unref();
    for(const task of this.all())if(task.kind==='agent')this.syncInbox(task);
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
  changed(task){this.events?.publish('task.updated',this.summary(task),task.requestId);}
  summary(task){
    const run=this.row('run',task.runId),job=this.row('job',run.jobId);
    return {...task,...this.team?.owner(task),runNumber:run.number,startedAt:run.startedAt,finishedAt:run.finishedAt,exitCode:job.exitCode,error:job.error,
      cleanupConfirmed:job.cleanupConfirmed,logTruncated:job.truncated??false,
      canContinue:task.kind==='agent'&&terminal.has(task.status)&&job.cleanupConfirmed===true,
      question:job.agentResult?.question,...this.supervisor?.summary(task),
      canRetry:task.kind!=='agent'&&['failed','cancelled','interrupted'].includes(task.status)&&job.cleanupConfirmed===true};
  }
  list({limit=50,offset=0}={}){
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0)throw Error('invalid_task_page');
    const all=this.all().filter(t=>!t.managementReview).sort((a,b)=>Number(live.has(b.status))-Number(live.has(a.status))||Number(!!b.unread)-Number(!!a.unread));
    return {tasks:all.slice(offset,offset+limit).map(t=>this.summary(t)),total:all.length,problem:this.lastError?'task_scheduler_failed':null,
      activeCount:all.filter(t=>live.has(t.status)).length,unreadCount:all.filter(t=>t.unread).length,hasMore:offset+limit<all.length};
  }
  spec(input,root=this.workspace,check){
    const assignment=this.team?.assignment(check?{...input,kind:'agent',workspaceMode:'code'}:input)??{};
    const plan=planningSpec(input);
    const acceptanceCriteria=input.acceptanceCriteria??'';
    if(typeof acceptanceCriteria!=='string'||acceptanceCriteria.length>8000)throw Error('invalid_acceptance_criteria');
    const managementEnabled=input.managementEnabled??!!(assignment.assignedBotId&&assignment.assignedBotId!==assignment.supervisorBotId&&!check),maxReworks=input.maxReworks??2;
    const tokenBudget=input.managementTokenBudget===undefined?0:input.managementTokenBudget,timeBudgetMs=input.managementTimeBudgetMs===undefined?0:input.managementTimeBudgetMs;
    if(typeof managementEnabled!=='boolean'||!Number.isInteger(maxReworks)||maxReworks<0||maxReworks>5||!validBudget(tokenBudget,1000,3000000)||!validBudget(timeBudgetMs,1000,28800000))throw Error('invalid_management_budget');
    const work={...plan,acceptanceCriteria,management:{enabled:managementEnabled,paused:false,maxReworks,tokenBudget,timeBudgetMs,usedReworks:0}};
    if(input.kind==='agent'){
      const {title,goal,constraints='',timeoutMs=0,maxSteps=0,tokenBudget=0,autoContinue=0}=input;
      const execution=executionSpec(input),{mode}=execution;
      if(!Number.isInteger(autoContinue)||autoContinue<0||autoContinue>5||autoContinue&&mode!=='edit')throw Error('invalid_event_budget');
      if(typeof title!=='string'||!title.trim()||title.length>160||typeof goal!=='string'||!goal.trim()||goal.length>8000||typeof constraints!=='string'||constraints.length>4000)throw Error('invalid_agent_task');
      if(!['analysis','edit'].includes(mode)||!validBudget(maxSteps,1,128)||!validBudget(tokenBudget,1000,1000000))throw Error('invalid_agent_budget');
      if(!validBudget(timeoutMs,1000,7200000))throw Error('invalid_task_timeout');
      const workspaceMode=input.workspaceMode??'general';
      if(!['general','code','documents'].includes(workspaceMode))throw Error('invalid_workspace_mode');
      const inputFiles=workspaceMode==='code'?[]:(workspaceMode==='documents'?validateInputFiles:validateGeneralInputs)(root,input.inputFiles??[]);
      return {...assignment,...work,...execution,workspaceMode,inputFiles,kind:'agent',title:title.trim(),goal,constraints,timeoutMs,maxSteps,tokenBudget,cwd:this.workspace,artifacts:[],...(autoContinue?{autoContinue}:{})};
    }
    if(input.kind&&input.kind!=='command')throw Error('invalid_task_kind');
    const {title,command}=input;
    if(typeof title!=='string'||!title.trim()||title.length>160||typeof command!=='string'||!command.trim()||command.length>16000||command.includes('\0'))throw Error('invalid_task_command');
    const workdir=input.workdir??'.';
    if(typeof workdir!=='string'||!workdir||workdir.includes('\0'))throw Error('invalid_task_workdir');
    let cwd;try{cwd=realpathSync(resolve(root,workdir));}catch{throw Error('invalid_task_workdir');}
    const rel=relative(root,cwd);
    if(rel==='..'||rel.startsWith('../')||isAbsolute(rel)||!statSync(cwd).isDirectory())throw Error('invalid_task_workdir');
    const timeoutMs=input.timeoutMs??1800000;
    if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>7200000)throw Error('invalid_task_timeout');
    const artifacts=input.artifacts??[];
    if(!Array.isArray(artifacts)||artifacts.length>20||artifacts.some(p=>typeof p!=='string'||!p||p.length>1000||p.includes('\0')||isAbsolute(p)||p.split(/[\\/]/).includes('..')))throw Error('invalid_task_artifacts');
    if(plan.dependsOn.length)throw Error('task_dependencies_require_agent');
    return {...assignment,...work,title:title.trim(),command,cwd,timeoutMs,artifacts};
  }
  create(input,{requestId,source='web',check,managementReview}={}){
    if(this.closed)throw Error('host_stopping');
    const spec=this.spec(input,check?.workspace??this.workspace,check),id=input.id;
    if(!idOk(id))throw Error('invalid_task_id');
    const fingerprint=hash(JSON.stringify(spec));
    const old=this.db.prepare('SELECT body FROM background_task WHERE id=?').get(id);
    if(old){
      const task=JSON.parse(old.body);
      if(task.fingerprint!==fingerprint){
        // An acknowledgement lost before upgrade may retry an input that omitted
        // the old defaults. Only pre-upgrade records may use that normalization.
        const legacy=!task.budgetVersion&&this.spec({...input,managementTokenBudget:input.managementTokenBudget??600000,managementTimeBudgetMs:input.managementTimeBudgetMs??7200000,
          ...(input.kind==='agent'?{maxSteps:input.maxSteps??32,tokenBudget:input.tokenBudget??200000,timeoutMs:input.timeoutMs??1800000}:{})},check?.workspace??this.workspace,check);
        if(!legacy||task.fingerprint!==hash(JSON.stringify(legacy)))throw Error('task_id_conflict');
      }
      return this.detail(id);
    }
    this.assignments.validate(id,spec.dependsOn);
    if(this.all().filter(t=>live.has(t.status)).length>=100)throw Error('task_queue_full');
    const now=Date.now(),task={id,...spec,budgetVersion:2,teamReportVersion:1,createdBy:{kind:source==='assistant'||source==='supervisor'?'chief':'user',requestId},fingerprint,requestId,source,status:'queued',createdAt:now,updatedAt:now,unread:false};
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
    const employee=this.team?.snapshot(task);
    const budget=this.runBudget(task);if(budget)extra={...extra,executionBudget:{tokenBudget:capBudget(budget.tokenBudget,extra.executionBudget?.tokenBudget),timeoutMs:capBudget(budget.timeoutMs,extra.executionBudget?.timeoutMs)}};
    const run={employee,assignmentVersion:task.assignmentVersion,permission:task.permission,policyVersion:task.policyVersion,id:randomUUID(),taskId:task.id,number,status:'queued',createdAt:Date.now(),jobId:randomUUID(),instruction,...extra};
    const job={id:run.jobId,runId:run.id,taskId:task.id,status:'queued',cleanupConfirmed:true,createdAt:run.createdAt,kind:task.kind??'command'};
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
    return {task:this.summary(task),runs:runs.map(run=>{
      const job=this.row('job',run.jobId),directory=this.directory(job);
      return {...run,activity:this.activity(task,run,job),job:{...job,logPath:join(directory,'output.log')},...(task.kind==='agent'?{
        jobs:readSteps(directory),progress:readJson(join(directory,'progress.json')),result:job.agentResult??readJson(join(directory,'agent-result.json')),
      }:{})};
    }),teamReview:{...this.reports.view(task),...this.supervisor?.view(task)},...(task.kind==='agent'?{automation:this.automation.view(task),checks:this.all().filter(t=>t.parentTaskId===id).map(t=>this.summary(t)),workspace:readJson(join(this.agentHome(task),'workspace.json')),messages:this.messages(task),applications:Object.values(readJson(join(this.agentHome(task),'applications.json'),{}))}:{})};
  }
  review(body){if(!this.supervisor)throw Error('team_supervisor_unavailable');const decision=this.supervisor.userDecision(body);return {...this.detail(body.id),decision};}
  configureManagement(body){if(!this.supervisor)throw Error('team_supervisor_unavailable');this.supervisor.configure(body);return this.detail(body.id);}
  reassign(body){return this.assignments.reassign(body);}
  setDependencies(body){return this.assignments.set(body);}
  reportArtifact(body){return this.reports.artifact(body);}
  ruleCreate(body){this.automation.add(body);this.changed(this.row('task',body.taskId));return this.detail(body.taskId);}
  ruleToggle(body){const rule=this.automation.setEnabled(body);return this.detail(rule.taskId);}
  automationPause(body){this.automation.setPaused(body);return this.detail(body.id);}
  createCheck({taskId,runId,stepId,title,command,workdir='.',timeoutMs=600000}){
    if(!idOk(stepId))throw Error('invalid_task_id');
    const task=this.row('task',taskId);
    if(task.runId!==runId)throw Error('task_run_changed');
    if(task.kind!=='agent'||task.mode!=='edit'||task.status!=='running'||!this.automation.canCheck(taskId))throw Error('task_check_unavailable');
    if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000)throw Error('invalid_task_timeout');
    const remaining=this.runBudget(task);if(remaining)timeoutMs=capBudget(timeoutMs,remaining.timeoutMs);
    const workspace=readJson(join(this.agentHome(task),'workspace.json'));
    if(!workspace)throw Error('task_workspace_not_ready');
    const id='check-'+hash(runId+'\0'+stepId).slice(0,48);
    const existing=this.all().find(t=>t.parentRunId===runId&&t.id!==id);
    if(existing)throw Error('task_check_already_submitted');
    return this.create({id,assignedBotId:task.assignedBotId,title:title||'任务验证',command,workdir,timeoutMs},{source:'agent-check',check:{taskId,runId,workspace:workspace.path}});
  }
  stopChecks(task){for(const child of this.all().filter(t=>t.parentTaskId===task.id&&live.has(t.status)))this.cancel(child.id,child.runId);}
  agentHome(task){return join(this.root,'agents',hash(task.id+(task.assignmentVersion>1?'\0assignment:'+task.assignmentVersion:'')));}
  messages(task){
    const acks=readJson(join(this.agentHome(task),'delivered.json'),{});
    return this.db.prepare("SELECT body FROM background_message WHERE json_extract(body,'$.taskId')=? ORDER BY rowid").all(task.id).map(r=>JSON.parse(r.body)).map(m=>({...m,delivery:acks[m.id]?.status==='sending'&&(!live.has(task.status)||acks[m.id].runId!==task.runId)?{...acks[m.id],status:'unknown'}:acks[m.id]??{status:'pending'}}));
  }
  syncInbox(task){saveJson(join(this.agentHome(task),'inbox.json'),this.messages(task).map(({delivery,...m})=>m));}
  message({id,messageId,text}){
    if(this.closed)throw Error('host_stopping');const task=this.row('task',id);
    if(task.kind!=='agent'||!idOk(messageId)||typeof text!=='string'||!text.trim()||text.length>4000)throw Error('invalid_task_message');
    const old=this.db.prepare('SELECT body FROM background_message WHERE id=?').get(messageId);
    if(old){const m=JSON.parse(old.body);if(m.taskId!==id||m.text!==text)throw Error('task_id_conflict');return this.detail(id);}
    if(this.messages(task).length>=100)throw Error('task_message_limit');
    this.put('message',{id:messageId,taskId:id,text,source:'user',assignmentVersion:task.assignmentVersion??1,createdAt:Date.now()});this.syncInbox(task);this.changed(task);return this.detail(id);
  }
  pause({id,runId,handoffActionId}){
    const task=this.row('task',id);if(task.kind!=='agent')throw Error('not_agent_task');
    if(task.runId!==runId)throw Error('task_run_changed');
    if(task.handoff?.status==='stopping'&&handoffActionId!==task.handoff.actionId)task.handoff={...task.handoff,status:'cancelled',reason:'user_paused'};
    task.automationPaused=true;task.management={...task.management,paused:true};this.put('task',task);this.stopChecks(task);
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
  continue({id,runId,actionId,text=''}){
    if(this.closed)throw Error('host_stopping');if(this.applying)throw Error('task_workspace_busy');
    const task=this.row('task',id);
    if(!idOk(actionId)||typeof text!=='string'||text.length>4000)throw Error('invalid_task_message');
    if(task.lastContinueAction===actionId){if(task.lastContinueText!==text)throw Error('task_id_conflict');return this.detail(id);}
    if(task.runId!==runId)throw Error('task_run_changed');
    if(!this.summary(task).canContinue)throw Error('task_retry_unavailable');
    task.lastContinueAction=actionId;task.lastContinueText=text;delete task.stopIntent;
    this.atomic(()=>this.newRun(task,this.row('run',runId).number+1,text||'请继续完成原任务，先核对已有结果。',{instructionSource:{kind:'user',actionId,previousRunId:runId}}));
    this.changed(task);queueMicrotask(()=>this.tick());return this.detail(id);
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
    if(this.row('task',task.id).runId!==run.id)return;
    const finishedAt=result.finishedAt??Date.now();
    let agentResult=job.kind==='agent'?readJson(join(this.directory(job),'agent-result.json')):null;
    if(job.kind==='agent'){
      const research=readJson(join(this.directory(job),'research.json'));
      if(research?.runId===run.id&&research.taskId===task.id)agentResult={...agentResult,runId:run.id,taskId:task.id,sources:research.sources??[],research:research.research};
    }
    // The durable check receipt wins if HTTP delivery was lost after acceptance.
    // Interrupted Runs still require manual review; never replay uncertain work.
    const check=job.kind==='agent'&&this.all().find(t=>t.parentRunId===run.id);
    if(check&&result.cleanupConfirmed&&['completed','failed'].includes(result.status)&&agentResult?.status!=='waiting_input'){
      agentResult={...agentResult,runId:run.id,status:'waiting_event',awaiting:{taskId:check.id,runId:check.runId},text:agentResult?.text||'检查已提交，等待结果事件接续。'};
      result={...result,status:'completed'};
    }
    const status=task.stopIntent&&result.cleanupConfirmed?task.stopIntent:task.status==='cancelling'&&result.cleanupConfirmed?'cancelled':
      result.status==='completed'&&job.kind==='agent'?(agentResult?.runId===run.id&&['completed','waiting_input','waiting_event'].includes(agentResult.status)?agentResult.status:'failed'):result.status;
    if(job.kind==='agent'&&result.cleanupConfirmed)for(const step of readSteps(this.directory(job)).filter(s=>s.status==='running'||s.tool==='task_command')){
      const receipt=step.tool==='task_command'?readJson(join(this.directory(job),'commands',step.id,'result.json')):null;
      if(!receipt&&step.status!=='running')continue;
      saveJson(join(this.directory(job),'steps',step.id+'.json'),{...step,...(receipt??{status:'interrupted',error:'tool_outcome_unknown'}),id:step.id,finishedAt});
    }
    this.atomic(()=>{
      const finalJob={...job,...result,id:job.id,status,finishedAt,agentResult,artifacts:this.artifacts(task,job)};
      this.put('job',finalJob);
      const finalRun={...run,status,finishedAt};this.put('run',finalRun);
      task={...task,status,updatedAt:finishedAt,unread:true};this.put('task',task);
      this.automation.recordCompletion(task,{...run,status},{...job,...result,status});
      this.reports.capture(task,finalRun,finalJob);
    });
    this.changed(task);
  }
  artifacts(task,job){
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
    return files.map((path,index)=>{
      try{
        const absolute=realpathSync(resolve(root,path)),rel=relative(plainWorkspace(task)?root:this.workspace,absolute),stat=statSync(absolute);
        if(rel==='..'||rel.startsWith('../')||isAbsolute(rel)||!stat.isFile())throw Error();
        return {id:`${job.id}-${index}`,path:absolute,name:path,size:stat.size,mtimeMs:stat.mtimeMs,status:'available'};
      }catch{return {id:`${job.id}-${index}`,name:path,status:'missing'};}
    });
  }
  tick(){
    if(this.closed)return;
    try{
      for(const task of this.all()){
        const run=this.row('run',task.runId),job=this.row('job',run.jobId);
        if((live.has(task.status)&&!['queued','blocked'].includes(task.status))||job.cleanupConfirmed===false){
          const receipt=this.receipt(job);
          if(receipt&&(live.has(task.status)||receipt.cleanupConfirmed!==job.cleanupConfirmed||receipt.error!==job.error))this.finish(task,run,job,receipt);
        }
      }
      void this.outbox?.tick().catch(()=>{});
      this.automation.tick();this.supervisor?.tick();this.assignments.tick();this.lastError=null;
      // One active project command. Unconfirmed cleanup also holds the slot.
      if(this.applying||this.workers.size||this.all().some(t=>['running','pausing','cancelling'].includes(t.status)||this.row('job',this.row('run',t.runId).jobId).cleanupConfirmed===false))return;
      if(this.foregroundBusy?.())return;
      const priority={high:2,normal:1,low:0};
      const next=this.all().reverse().filter(t=>t.status==='queued').sort((a,b)=>Number(!!b.managementReview)-Number(!!a.managementReview)||(priority[b.priority]??1)-(priority[a.priority]??1)||(a.dueAt??Infinity)-(b.dueAt??Infinity)||this.row('run',a.runId).createdAt-this.row('run',b.runId).createdAt)[0];if(next)this.launch(next);
    }catch(error){this.lastError=String(error.message);}
  }
  launch(task){
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
        saveJson(specPath,{taskId:task.id,runId:run.id,runNumber:run.number,runDir:this.directory(job),agentHome:this.agentHome(task),source:task.cwd,
          employee:run.employee,assignmentVersion:run.assignmentVersion,workspaceMode:task.workspaceMode,inputFiles:task.inputFiles,
          sessionId:task.sessionId,goal:task.goal,constraints:task.constraints,acceptanceCriteria:task.acceptanceCriteria,managementReview:task.managementReview,transferInputs:task.transferInputs,dependencyInputs:task.dependencyInputs,mode:task.mode,permission:task.permission,policyVersion:task.policyVersion,maxSteps:task.maxSteps,tokenBudget:run.executionBudget?.tokenBudget??task.tokenBudget,
          timeoutMs:run.executionBudget?.timeoutMs??task.timeoutMs,instruction:run.instruction,eventContext:run.eventContext,checksEnabled:this.automation.canCheck(task.id),bridge,providerModule:this.agentProviderModule,agentPluginModule:this.agentPluginModule,researchConfig:this.agentResearchConfig});
        const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
        command=[process.execPath,fileURLToPath(new URL('./agent-runner.mjs',import.meta.url)),specPath].map(quote).join(' ');
      }
      child=this.spawnWorker(process.execPath,[worker,this.directory(job)],{cwd:task.cwd,detached:true,
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
      child.send({type:'start',spec:{jobId:job.id,runId:run.id,command,cwd:task.cwd,timeoutMs:run.executionBudget?.timeoutMs??task.timeoutMs,logLimit:MAX_LOG}},()=>{});
    }catch{
      this.workers.delete(job.id);this.finish(task,run,job,{status:'failed',cleanupConfirmed:!child?.pid,error:'worker_spawn_failed'});
    }
  }
  cancel(id,expectedRunId){
    const task=this.row('task',id),run=this.row('run',task.runId),job=this.row('job',run.jobId);
    if(expectedRunId&&expectedRunId!==task.runId)throw Error('task_run_changed');
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
      await this.outbox?.close();
      await this.automation.close();
      await Promise.all([...this.workers.values()].map(child=>new Promise(resolveDone=>{
        const timer=setTimeout(resolveDone,6500);child.once('exit',()=>{clearTimeout(timer);resolveDone();});
        if(child.connected){child.send({type:'stop',reason:'interrupted'},()=>{});child.disconnect();}
      })));
      for(const task of this.all())if(['running','pausing','cancelling'].includes(task.status)){
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
    ['background_task_management','按用户要求设置总管自动跟进；暂停不停止当前执行，需要停止用background_agent_pause。不得自行扩大返工次数或预算。',{id:{type:'string',required:true},runId:{type:'string',required:true},enabled:{type:'boolean'},paused:{type:'boolean'},maxReworks:{type:'integer'},tokenBudget:{type:'integer',description:'用户明确指定的累计Token上限，0表示不限制，有限值1000–3000000。'},timeBudgetMs:{type:'integer',description:'用户明确指定的累计执行时长上限，毫秒；0表示不限制，有限值最多8小时。'}},a=>{request();return tasks.configureManagement(a);}],
    ['background_task_reassign','仅用户明确要求改派时使用；先查询runId、assignmentVersion和员工ID。先清理旧执行，再以新会话交接摘要和指定成果。',{id:{type:'string',required:true},runId:{type:'string',required:true},assignmentVersion:{type:'integer',required:true},assignedBotId:{type:'string',required:true},summary:{type:'string',required:true},reportId:{type:'string'}},a=>tasks.reassign({...a,actionId:hash(request().id+'\0handoff\0'+JSON.stringify(a))})],
    ['background_task_dependencies','按用户明确要求配置尚未开始的Agent任务前置依赖；前置成果必须验收后才能放行。不猜测依赖关系。',{id:{type:'string',required:true},runId:{type:'string',required:true},dependsOn:{type:'array',items:{type:'string'},required:true},priority:{type:'string',enum:['low','normal','high']},dueAt:{type:'number'}},a=>{request();return tasks.setDependencies(a);}],
    ['background_agent_rule','只有用户明确要求时，为指定任务配置事件接续规则。type=check/task/file/github；source 必须按类型精确指定。默认停用，enabled=true 表示用户授权启用。',{taskId:{type:'string',required:true},type:{type:'string',enum:['check','task','file','github'],required:true},instruction:{type:'string',required:true},source:{type:'object',additionalProperties:false,properties:{taskId:{type:'string'},runId:{type:'string'},paths:{type:'array',items:{type:'string'}},repository:{type:'string'},number:{type:'integer'},authors:{type:'array',items:{type:'string'}}},description:'task: taskId/runId；file: paths；github: repository/number/authors（仅 /opennova 前缀评论）。'},maxRuns:{type:'number'},ttlHours:{type:'number'},enabled:{type:'boolean'}},a=>tasks.ruleCreate({...a,id:hash(request().id+'\0rule\0'+JSON.stringify(a))})],
    ['background_agent_automation','按用户要求暂停或恢复该任务的自动接续。暂停自动接续不停止已运行的轮次；要立即停止请用 background_agent_pause。',{id:{type:'string',required:true},paused:{type:'boolean',required:true}},a=>{request();return tasks.automationPause(a);}],
    ['background_agent_start','创建独立后台数字员工工作会话。默认 permission=full，可使用已接入的文件、命令、联网、浏览器工具；明确只读时用 read-only。workspaceMode仅决定目录准备：默认general、代码快照code、文本输入documents。需要的输入文件用inputFiles指定。提交后立即结束本轮等待，主对话仍可交流。',{
      acceptanceCriteria:{type:'string',description:'从用户目标提取的可验证交付标准，不添加用户未要求的工作。'},managementEnabled:{type:'boolean',description:'员工任务默认启用总管跟进；用户明确关闭时设false。'},maxReworks:{type:'integer',description:'默认最多两次自动返工，只有用户要求调整时填写，0–5。'},managementTokenBudget:{type:'integer',description:'可选累计Token预算，默认0表示不限制；只有用户明确要求设置上限时填写有限值。'},managementTimeBudgetMs:{type:'integer',description:'可选累计执行时长毫秒，默认0表示不限制；只有用户明确要求设置上限时填写有限值。'},dependsOn:{type:'array',items:{type:'string'},description:'用户明确指定的前置任务ID，等待其已验收成果。'},priority:{type:'string',enum:['low','normal','high']},dueAt:{type:'number',description:'用户明确的截止时间，Unix毫秒；用于排序提醒，独立于执行超时。'},
      assignedBotId:{type:'string',description:'team_list 返回的员工 ID；省略由总管负责。'},workspaceMode:{type:'string',enum:['general','code','documents'],description:'任务模板，默认general；code准备Git快照，documents复制文本资料。模板不限制工具权限。'},inputFiles:{type:'array',items:{type:'string'},description:'general/documents 模板复制的输入文件：项目内相对路径。general可省略，最多20个文件、每个20MiB；documents为文本文件，最多10个、每个64KiB。'},title:{type:'string',required:true},goal:{type:'string',required:true},constraints:{type:'string'},permission:{type:'string',enum:['full','read-only'],description:'执行权限，默认full；只有用户明确要求只读时选择read-only。完整执行使用已接入且已授权的工具，不新增外部账号。'},mode:{type:'string',enum:['analysis','edit'],description:'旧客户端兼容字段，优先使用permission；analysis对应read-only，edit对应full，不得冲突。'},timeoutMs:{type:'number',description:'每轮执行时限毫秒，默认0不限制；只有用户明确要求时设置有限值。'},maxSteps:{type:'number',description:'每轮模型步骤上限，默认0不限制；只有用户明确要求时设置有限值。'},tokenBudget:{type:'number',description:'每轮Token预算，默认0不限制；只有用户明确要求时设置有限值。'},autoContinue:{type:'number',description:'仅用户明确要求测试完成自动接续时设置，1–5 次；默认关闭。'},
    },a=>{const r=request(),input={...a,kind:'agent'};return tasks.create({...input,id:hash(r.id+'\0'+JSON.stringify(tasks.spec(input)))},{requestId:r.id,source:'assistant'});}],
    ['background_agent_message','向指定后台 Agent 任务补充要求。只表示消息已保存，不能声称正在执行的操作已经按新要求修改。',{id:{type:'string',required:true},text:{type:'string',required:true}},a=>tasks.message({...a,messageId:hash(request().id+'\0'+a.id+'\0'+a.text)})],
    ['background_agent_pause','暂停后台 Agent，停止模型和工具，保留工作区和会话供继续。先查询当前 runId。',{id:{type:'string',required:true},runId:{type:'string',required:true}},a=>{request();return tasks.pause(a);}],
    ['background_agent_continue','用户要求继续、回答任务问题或接着修改时，沿用同一任务会话和工作目录创建新 Run。',{id:{type:'string',required:true},runId:{type:'string',required:true},text:{type:'string'}},a=>tasks.continue({...a,actionId:hash(request().id+'\0'+a.id+'\0'+a.runId+'\0'+(a.text||''))})],
    ['background_agent_diff','查看已停止 Agent 任务的文件差异和版本，用于审阅或应用到原工程。',{id:{type:'string',required:true},runId:{type:'string',required:true}},a=>tasks.diff(a)],
    ['background_agent_apply','按用户明确要求将已检查的任务差异应用到原工程；必须使用刚查询的 revision，冲突时停止。',{id:{type:'string',required:true},runId:{type:'string',required:true},revision:{type:'string',required:true}},a=>tasks.applyChanges({...a,actionId:hash(request().id+'\0'+a.id+'\0'+a.revision)})],
    ['background_task_start','将明确的测试、构建或脚本交给后台执行，立即返回任务编号；随后结束本轮等待，用户可继续聊天。不要循环等待。命令在项目内目录运行，不能守护化；结束交流或停止播报不会取消任务。',{
      assignedBotId:{type:'string',description:'team_list 的员工 ID；省略由总管负责。'},title:{type:'string',required:true},command:{type:'string',required:true},workdir:{type:'string'},timeoutMs:{type:'number'},artifacts:{type:'array',items:{type:'string'},description:'需要展示的结果文件，相对执行目录；最多 20 项。'},
    },args=>{
      const request=getRequest();if(!request||request.cancelled||request.signal?.aborted)throw Error('bridge_request_required');
      return tasks.create({...args,id:hash(request.id+'\0'+JSON.stringify(tasks.spec(args)))},{requestId:request.id,source:'assistant'});
    }],
    ['background_task_list','查询后台任务的真实状态与结果；不执行或重跑命令。',{},()=>tasks.list({limit:30})],
    ['background_task_status','查询指定后台任务及每次执行的实际结果。',{id:{type:'string',required:true}},a=>tasks.detail(a.id)],
    ['background_task_log','读取后台任务日志，nextOffset 可用于继续读取。',{id:{type:'string',required:true},runId:{type:'string'},stepId:{type:'string',description:'Agent 命令步骤编号，可读取该步骤的实时日志。'},offset:{type:'number'}},a=>tasks.log(a)],
    ['background_task_cancel','用户要求取消指定后台任务时使用；取消中不代表进程已停止，也不撤销已保存文件。',{id:{type:'string',required:true}},a=>tasks.cancel(a.id)],
    ['background_task_retry','用户明确要求重试已停止的失败、取消或中断任务时，创建新的执行尝试。先查询当前 runId。',{id:{type:'string',required:true},runId:{type:'string',required:true}},a=>{
      const request=getRequest();if(!request||request.cancelled)throw Error('bridge_request_required');
      return tasks.retry({...a,actionId:hash(request.id+'\0'+a.id+'\0'+a.runId)});
    }],
  ];
}
