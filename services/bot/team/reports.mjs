/** Immutable deliverables and their event/outbox records share task completion. */
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,renameSync,realpathSync,lstatSync,existsSync,openSync,readSync,fstatSync,closeSync,copyFileSync,chmodSync,rmSync,constants} from 'node:fs';
import {join,resolve,relative,isAbsolute,basename,extname} from 'node:path';
import {readJson,saveJson,readSteps} from '../tasks/agent-files.mjs';
import {enqueueTeamEvent,ensureDeliveryTables} from './outbox.mjs';
import {builtinChecks} from './candidate-profile.mjs';
import {candidateIndexClean,candidatePatch} from './candidate-patch.mjs';
import {captureCandidateEvidence} from './candidate-evidence.mjs';
import {captureTaskContext} from './task-context.mjs';
import {hasFullFilesystemAccess} from '../tasks/execution.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const terminal=new Set(['completed','failed','interrupted','cancelled','paused','waiting_input','waiting_event']);
const inside=(root,path)=>{const p=relative(root,path);return p!=='..'&&!p.startsWith('../')&&!isAbsolute(p);};
const clipped=(value,n=16000)=>typeof value==='string'?value.slice(0,n):'';
const readLog=path=>{try{const bytes=readFileSync(path);return {log:bytes.subarray(Math.max(0,bytes.length-16000)).toString('utf8'),logHash:hash(bytes),logTruncated:bytes.length>16000};}catch{return {log:'',logMissing:true};}};
const signature=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
function fileHash(path){
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const before=fstatSync(fd);if(!before.isFile())throw Error('artifact_path_invalid');
    const digest=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let length;
    while((length=readSync(fd,buffer,0,buffer.length,null))>0)digest.update(buffer.subarray(0,length));
    if(signature(before)!==signature(fstatSync(fd)))throw Error('artifact_changed_during_capture');
    return digest.digest('hex');
  }finally{closeSync(fd);}
}
function fileStatus(path,sha256){try{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())return 'changed';return fileHash(path)===sha256?'available':'changed';}catch(error){return error.code==='ENOENT'?'missing':'changed';}}
const mediaExtensions=new Set(['.mp4','.mov','.m4v','.webm','.mkv','.avi']);
const generatedFormats=new Map([['.png','png'],['.jpg','jpeg'],['.jpeg','jpeg'],['.webp','webp'],['.gif','gif'],['.mp4','mp4']]);
export class TeamReports {
  constructor(tasks,{now=Date.now,maxFileBytes=20*1024*1024,maxTotalBytes=64*1024*1024,maxMediaFileBytes=512*1024*1024,maxMediaTotalBytes=1024*1024*1024}={}){
    Object.assign(this,{tasks,db:tasks.db,now,maxFileBytes,maxTotalBytes,maxMediaFileBytes,maxMediaTotalBytes});this.fileCache=new Map();this.candidateCache=new Map();this.root=join(tasks.root,'reports');mkdirSync(this.root,{recursive:true,mode:0o700});
    this.db.exec(`CREATE TABLE IF NOT EXISTS team_report (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_report_task_version ON team_report(json_extract(body,'$.taskId'),json_extract(body,'$.version') DESC);
      CREATE INDEX IF NOT EXISTS team_report_current ON team_report(json_extract(body,'$.taskId'),json_extract(body,'$.runId'),json_extract(body,'$.assignmentVersion'),json_extract(body,'$.version') DESC)`);ensureDeliveryTables(this.db);
  }
  raw(id){const row=this.db.prepare('SELECT body FROM team_report WHERE id=?').get(id);if(!row)throw Error('unknown_team_report');return JSON.parse(row.body);}
  fileStatus(path,sha256,fresh=false){
    if(!path)return 'missing';let currentSignature;try{currentSignature=signature(lstatSync(path));}catch{return 'missing';}
    const key=path+'\0'+sha256,cached=this.fileCache.get(key);
    if(!fresh&&cached?.signature===currentSignature)return cached.status;
    const status=fileStatus(path,sha256);this.fileCache.set(key,{signature:currentSignature,status,at:this.now()});return status;
  }
  get(id,{fresh=false}={}){const report=this.raw(id),delivery=this.db.prepare('SELECT body FROM team_outbox WHERE id=?').get(report.eventId);
    return {...report,delivery:delivery?JSON.parse(delivery.body).status:'pending',artifacts:report.artifacts.map(a=>({...a,
      status:a.status==='available'?this.fileStatus(a.path,a.sha256,fresh):a.status,
      sourceStatus:a.sourcePath?(a.sha256?this.fileStatus(a.sourcePath,a.sha256,fresh):'unverified'):'available'}))};
  }
  history(taskId){return this.db.prepare("SELECT id FROM team_report WHERE json_extract(body,'$.taskId')=? ORDER BY json_extract(body,'$.version') DESC").all(taskId).map(r=>this.get(r.id));}
  currentId(task){return this.db.prepare("SELECT id FROM team_report WHERE json_extract(body,'$.taskId')=? AND json_extract(body,'$.runId')=? AND json_extract(body,'$.assignmentVersion')=? ORDER BY json_extract(body,'$.version') DESC LIMIT 1").get(task.id,task.runId,task.assignmentVersion??1)?.id??null;}
  current(task){const id=this.currentId(task);return id?this.get(id):null;}
  view(task){
    const current=this.current(task),gate=current?.evidence?.candidateReview;
    if(gate?.patchSha256)gate.patchCurrent=this.candidatePatchCurrent(task,current);
    return {current,history:this.history(task.id)};
  }
  isDelivered(id){const report=this.raw(id),row=this.db.prepare('SELECT body FROM team_outbox WHERE id=?').get(report.eventId);return !!row&&JSON.parse(row.body).status==='delivered';}
  candidatePatchCurrent(task,report,{fresh=false}={}){
    const gate=report.evidence?.candidateReview;
    if(!gate?.patchSha256)return true;
    try{
      const workspace=readJson(join(this.tasks.agentHome(task),'workspace.json'));
      if(workspace?.path!==gate.workspacePath||workspace.base!==gate.workspaceBase)return false;
      const cached=this.candidateCache.get(report.id);
      if(!fresh&&cached?.base===workspace.base&&cached.path===workspace.path&&this.now()-cached.at<60000&&candidateIndexClean(workspace,cached.index))return cached.sha256===gate.patchSha256;
      const {sha256,index}=candidatePatch(workspace,{keepIndex:true});
      if(index.length<=4*1024*1024){
        if(this.candidateCache.size>=8)this.candidateCache.delete(this.candidateCache.keys().next().value);
        this.candidateCache.set(report.id,{sha256,index,path:workspace.path,base:workspace.base,at:this.now()});
      }
      return sha256===gate.patchSha256;
    }catch{return false;}
  }
  assertCurrent(task,reportId,{verifyCandidate=true}={}){
    const current=this.tasks.row('task',task.id),report=this.get(reportId,{fresh:verifyCandidate||!task.candidateReview});
    if(current.runId!==task.runId||report.taskId!==task.id||report.runId!==current.runId||report.assignmentVersion!==(current.assignmentVersion??1)||this.currentId(current)!==report.id)throw Error('team_report_stale');
    if(task.candidateReview&&!report.evidence.candidateReview)throw Error('candidate_review_evidence_missing');
    if(report.evidence.captureIncomplete||report.artifacts.some(a=>a.status!=='available'||a.sourceStatus!=='available')||report.evidence.codeChanges?.some(c=>c.deleted&&existsSync(c.path))||
      verifyCandidate&&!this.candidatePatchCurrent(task,report,{fresh:true}))throw Error('team_report_artifact_changed');
    return report;
  }
  artifact({id,reportId,artifactId}){
    const report=this.get(reportId,{fresh:true});if(report.taskId!==id)throw Error('team_report_stale');
    const item=report.artifacts.find(a=>a.id===artifactId);if(!item||item.status!=='available')throw Error('team_report_artifact_changed');return {...item,reportId};
  }
  capture(task,run,job){
    if(task.teamReportVersion!==1||task.managementReview||task.parentTaskId||!terminal.has(job.status))return null;
    if(run.taskId!==task.id||job.taskId!==task.id||job.runId!==run.id||task.runId!==run.id||(run.assignmentVersion??1)!==(task.assignmentVersion??1)||run.employee?.botId&&run.employee.botId!==task.assignedBotId)throw Error('team_report_binding_mismatch');
    const id='report-'+hash(JSON.stringify([task.id,run.id,task.assignmentVersion??1,job.status,job.cleanupConfirmed,job.exitCode,job.error,job.agentResult?.question]));
    if(this.db.prepare('SELECT id FROM team_report WHERE id=?').get(id))return this.get(id);
    const directory=join(this.root,id),manifest=join(directory,'report.json');mkdirSync(join(directory,'artifacts'),{recursive:true,mode:0o700});
    let report=readJson(manifest);
    if(!report){
      let total=0,mediaTotal=0;const artifacts=[],jobDir=this.tasks.directory(job),workspace=readJson(join(this.tasks.agentHome(task),'workspace.json'));
      const allowedRoot=workspace?.path??task.cwd;
      // Both views are host-owned, persisted receipts scoped to this exact task and Run.
      const videoEvidence=this.tasks.video?.evidence(task.id,run.id)??[],videoArtifacts=this.tasks.video?.artifacts(task.id,run.id)??[];
      const media=new Map(videoArtifacts.filter(file=>typeof file.path==='string'&&isAbsolute(file.path)&&Number.isSafeInteger(file.size)&&file.size>0&&mediaExtensions.has(extname(file.path).toLowerCase())&&videoEvidence.some(action=>['video_download','video_edit','video_generate'].includes(action.tool)&&['succeeded','completed'].includes(action.status)&&!action.result?.error&&action.result?.path===file.path&&action.result?.size_bytes===file.size)).map(file=>[file.path,file]));
      const managedEvidence=this.tasks.media?.evidence(task.id,run.id)??[],managedArtifacts=this.tasks.media?.artifacts(task.id,run.id)??[];
      const managed=new Map(managedArtifacts.filter(file=>typeof file.path==='string'&&isAbsolute(file.path)&&
        Number.isSafeInteger(file.size)&&file.size>0&&generatedFormats.get(extname(file.path).toLowerCase())===file.format&&
        /^[a-f0-9]{64}$/.test(file.sha256??'')&&['task','project','evidence'].includes(file.scope)&&typeof file.operationId==='string').map(file=>[file.path,file]));
      const mediaOnly=!!this.tasks.media?.reportOnly?.(task,run);
      const documents=new Map();
      if(task.documentResearch)for(const file of job.artifacts??[])if(file.documentArtifactId){
        let a;try{a=this.tasks.ops.get(file.documentArtifactId);}catch{}
        if(a?.kind==='document_artifact'&&a.projectId===task.projectId&&a.taskId===task.id&&a.assignmentVersion===task.assignmentVersion&&
          a.path===file.path&&(a.path===task.documentOutputPath||inside(allowedRoot,a.path)))documents.set(a.path,a);
      }
      const snapshot=(name,sourcePath,bytes)=>{
        const artifactId='artifact-'+hash((sourcePath?'file:':'generated:')+name),path=join(directory,'artifacts',artifactId+'-'+basename(name).slice(0,80));
        const record={id:artifactId,name,sourcePath,status:'available'};
        try{
          let sha256,size,sourceSignature,isMedia=false;
          if(sourcePath){
            const actual=realpathSync(sourcePath),root=realpathSync(allowedRoot),rel=relative(resolve(allowedRoot),resolve(sourcePath)),before=lstatSync(sourcePath),receipt=media.get(sourcePath),generation=managed.get(sourcePath);
            isMedia=!!receipt&&actual===sourcePath&&before.size===receipt.size;
            const generationRoot=generation?.scope==='project'?(hasFullFilesystemAccess(task)?task.sourceWorkspace:undefined):generation?.scope==='evidence'?this.tasks.media?.evidenceRoot:allowedRoot;
            if(generation&&(!generationRoot||actual!==sourcePath||before.size!==generation.size||!inside(realpathSync(generationRoot),actual)))throw Error('artifact_changed_during_capture');
            const document=documents.get(sourcePath);
            if(document&&(actual!==sourcePath||before.size!==document.size))throw Error('artifact_changed_during_capture');
            if(!before.isFile()||before.isSymbolicLink()||(!inside(root,actual)||actual!==resolve(root,rel))&&!(isMedia&&hasFullFilesystemAccess(task))&&!generation&&!document)throw Error('artifact_path_invalid');
            if(receipt&&!isMedia)throw Error('artifact_changed_during_capture');
            record.sourcePath=actual;size=before.size;sourceSignature=signature(before);
            if(size>(isMedia?this.maxMediaFileBytes:this.maxFileBytes)||(isMedia?mediaTotal+size>this.maxMediaTotalBytes:total+size>this.maxTotalBytes))throw Error('artifact_too_large');
            sha256=fileHash(sourcePath);if(receipt?.sha256&&sha256!==receipt.sha256||generation&&sha256!==generation.sha256||document&&sha256!==document.sha256)throw Error('artifact_changed_during_capture');
            if(document)record.documentArtifactId=document.id;
            copyFileSync(sourcePath,path+'.tmp',constants.COPYFILE_FICLONE);chmodSync(path+'.tmp',0o600);
            if(generation)Object.assign(record,{mediaRole:generation.role,mediaOperationId:generation.operationId});
            if(realpathSync(sourcePath)!==actual||signature(lstatSync(sourcePath))!==sourceSignature||fileHash(sourcePath)!==sha256||fileHash(path+'.tmp')!==sha256||signature(lstatSync(sourcePath))!==sourceSignature||realpathSync(sourcePath)!==actual)throw Error('artifact_changed_during_capture');
          }else{
            size=bytes.length;if(size>this.maxFileBytes||total+size>this.maxTotalBytes)throw Error('artifact_too_large');
            sha256=hash(bytes);writeFileSync(path+'.tmp',bytes,{mode:0o600});
          }
          renameSync(path+'.tmp',path);if(isMedia)mediaTotal+=size;else total+=size;
          Object.assign(record,{path,size,sha256,...isMedia?{media:true}: {}});
          this.fileCache.set(path+'\0'+sha256,{signature:signature(lstatSync(path)),status:'available',at:this.now()});
          if(record.sourcePath)this.fileCache.set(record.sourcePath+'\0'+sha256,{signature:sourceSignature,status:'available',at:this.now()});
        }catch(error){rmSync(path+'.tmp',{force:true});record.status=error.message==='artifact_too_large'?'too_large':error.code==='ENOENT'?'missing':'changed';record.error=error.code??error.message;}
        artifacts.push(record);return record;
      };
      const candidates=new Map((mediaOnly?[]:(job.artifacts??[])).map(a=>[a.name,a.path]));
      const codeChanges=[];let codeError,patchArtifact,candidateReview;
      if(!mediaOnly&&task.kind==='agent'&&workspace?.base&&workspace.path){
        const git=args=>{const r=spawnSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:workspace.path,encoding:'utf8',timeout:5000,maxBuffer:8*1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}});if(r.status!==0)throw Error('report_git_unavailable');return r.stdout;};
        try{
          const candidate=task.candidateReview?candidatePatch(workspace):undefined;
          const names=candidate?.names??new Set([...git(['diff','--name-only','-z','--no-ext-diff',workspace.base,'--','.']).split('\0'),...git(['ls-files','--others','--exclude-standard','-z']).split('\0')].filter(Boolean));
          for(const name of names){const path=resolve(workspace.path,name);if(!inside(workspace.path,path))continue;const deleted=!existsSync(path);codeChanges.push({name,path,deleted});if(!deleted)candidates.set(name,path);}
          const patch=candidate?.bytes??git(['diff','--binary','--no-ext-diff',workspace.base,'--','.']);
          if(patch?.length){let name='changes.patch',index=2;while(candidates.has(name))name='changes-'+(index++)+'.patch';patchArtifact=snapshot(name,undefined,Buffer.from(patch));}
        }catch(error){codeError=error.message;}
      }
      for(const [path,file] of media){
        const existing=[...candidates].find(([,candidate])=>{try{return realpathSync(candidate)===path;}catch{return false;}});
        if(existing)candidates.set(existing[0],path);
        else{let name=inside(allowedRoot,path)?relative(allowedRoot,path):file.name||basename(path),index=2;while(candidates.has(name))name='video-'+(index++)+'-'+basename(path);candidates.set(name,path);}
      }
      for(const [path,file] of managed){
        if([...candidates.values()].includes(path))continue;
        let name=file.name||basename(path),index=2;
        while(candidates.has(name))name='media-'+(index++)+'-'+basename(path);
        candidates.set(name,path);
      }
      if(task.candidateReview){
        const binding={reportId:id,taskId:task.id,runId:run.id,assignmentVersion:task.assignmentVersion??1,workspacePath:workspace?.path,workspaceBase:workspace?.base};
        try{
          if(!patchArtifact?.sha256)throw Error('candidate_patch_missing');
          const result=captureCandidateEvidence({task,run,job,jobDir,workspace,patchSha256:patchArtifact.sha256,snapshot});
          if(result.taskId!==binding.taskId||result.runId!==binding.runId||result.assignmentVersion!==binding.assignmentVersion||result.patchSha256!==patchArtifact.sha256)throw Error('candidate_evidence_binding_mismatch');
          candidateReview={...result,...binding,patchArtifactId:patchArtifact.id,requiredChecks:[...builtinChecks,...task.candidateReview.regressions.map(r=>r.check)]};
        }catch(error){
          candidateReview={...binding,status:'incomplete',reason:error.message,patchSha256:patchArtifact?.sha256,patchArtifactId:patchArtifact?.id,coveredStepIds:[],checks:[],artifactIds:[]};
        }
      }
      const remainingArtifacts=Math.max(0,50-artifacts.length);
      const selected=[...candidates].sort((a,b)=>Number(managed.has(b[1])||media.has(b[1]))-Number(managed.has(a[1])||media.has(a[1])));
      for(const [name,path] of selected.slice(0,remainingArtifacts))if(typeof path==='string')snapshot(name,path);else artifacts.push({id:'artifact-'+hash(name),name,status:'missing'});
      const rawSteps=readSteps(jobDir),steps=rawSteps.map(s=>({id:s.id,tool:s.tool,status:s.status,exitCode:s.exitCode,output:clipped(s.output),error:clipped(s.error,500)}));
      const commands=rawSteps.filter(s=>s.tool==='task_command').map(s=>({stepId:s.id,status:s.status,exitCode:s.exitCode,
        command:clipped(s.arguments?.command),workdir:clipped(s.arguments?.workdir||'.',1000),...readLog(join(jobDir,'commands',s.id,'output.log'))}));
      if(task.kind!=='agent')commands.push({status:job.status,exitCode:job.exitCode,command:clipped(task.command),workdir:clipped(task.cwd,2000),cwd:clipped(task.cwd,2000),...readLog(join(jobDir,'output.log'))});
      const checks=this.tasks.all().filter(t=>t.parentTaskId===task.id&&t.parentRunId===run.id).map(t=>{const r=this.tasks.row('run',t.runId),j=this.tasks.row('job',r.jobId);return {taskId:t.id,runId:r.id,status:t.status,exitCode:j.exitCode,cleanupConfirmed:j.cleanupConfirmed,command:clipped(t.command),workdir:clipped(t.cwd,2000),cwd:clipped(t.cwd,2000),...readLog(join(this.tasks.directory(j),'output.log'))};});
      const research=readJson(join(jobDir,'research.json'));
      const sources=research?.runId===run.id&&research.taskId===task.id?(research.sources??[]).filter(s=>typeof s.url==='string'&&/^https?:\/\//.test(s.url)&&(!s.status||s.status==='completed')&&(s.statusCode===undefined||s.statusCode>=200&&s.statusCode<300)):[];
      const version=(this.db.prepare("SELECT MAX(json_extract(body,'$.version')) AS version FROM team_report WHERE json_extract(body,'$.taskId')=?").get(task.id).version??0)+1,createdAt=this.now();
      report={id,eventId:'event-'+id,taskId:task.id,projectId:task.projectId,sourceWorkspace:task.sourceWorkspace,runId:run.id,assignmentVersion:task.assignmentVersion??1,assignedBotId:task.assignedBotId,recipientBotId:task.reportTo??task.supervisorBotId??this.tasks.team?.chiefId,
        version,status:job.status,error:job.error,createdAt,goal:task.goal??task.command,constraints:task.constraints,acceptanceCriteria:task.acceptanceCriteria,
        summary:clipped(job.agentResult?.text||job.agentResult?.failureText||job.agentResult?.error||job.error||`${task.title}：${job.status}${job.exitCode===undefined?'':'，退出码 '+job.exitCode}`),question:job.agentResult?.question,
        taskContext:captureTaskContext(this.tasks,task,run,job),artifacts,evidence:{execution:{status:job.status,exitCode:job.exitCode,cleanupConfirmed:job.cleanupConfirmed,error:job.agentResult?.error??job.error,diagnostic:job.agentResult?.diagnostic,failurePhase:job.agentResult?.failurePhase,completedCommands:job.agentResult?.completedCommands},steps,commands,checks,codeChanges,video:videoEvidence,...(candidateReview?{candidateReview}:{}),
          ...(managedEvidence.length||mediaOnly?{media:managedEvidence}:{}),captureIncomplete:!!codeError||artifacts.length>50||candidates.size>remainingArtifacts||managed.size!==managedArtifacts.length,...codeError?{codeError}:{}},sources};
      if(run.summaryRecovery){
        const previous=this.get(run.summaryRecovery.reportId,{fresh:true});
        if(previous.taskId!==task.id||previous.runId!==run.summaryRecovery.sourceRunId||previous.projectId!==task.projectId||previous.assignmentVersion!==task.assignmentVersion)throw Error('team_report_binding_mismatch');
        report.recovery={kind:'summary_only',reportId:previous.id,runId:previous.runId,execution:previous.evidence.execution};
        report.artifacts=previous.artifacts;report.sources=previous.sources;
        report.evidence={...previous.evidence,execution:report.evidence.execution,
          ...(candidateReview||previous.evidence.candidateReview?{candidateReview:{reportId:id,taskId:task.id,runId:run.id,assignmentVersion:task.assignmentVersion??1,status:'incomplete',reason:'candidate_requires_current_run_evidence',coveredStepIds:[],artifactIds:[],checks:[]}}:{}),
          steps:[...previous.evidence.steps.map(s=>({...s,originRunId:s.originRunId??previous.runId})),...steps],
          commands:previous.evidence.commands.map(c=>({...c,originRunId:c.originRunId??previous.runId})),checks:previous.evidence.checks};
      }
      saveJson(manifest,report);
    }
    if(report.taskId!==task.id||report.runId!==run.id||report.assignmentVersion!==(task.assignmentVersion??1))throw Error('team_report_binding_mismatch');
    this.db.prepare('INSERT INTO team_report VALUES (?,?)').run(id,JSON.stringify(report));
    enqueueTeamEvent(this.db,{id:report.eventId,type:'task.report',reportId:id,taskId:task.id,projectId:report.projectId,runId:run.id,assignmentVersion:report.assignmentVersion,version:report.version,assignedBotId:report.assignedBotId,recipientBotId:report.recipientBotId,status:report.status,createdAt:report.createdAt});
    return this.get(id);
  }
}
