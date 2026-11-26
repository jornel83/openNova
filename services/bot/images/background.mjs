/** Run-scoped media dispatch. A restarted host can read receipts but cannot re-submit a chargeable action. */
import {createHash} from 'node:crypto';
import {lstatSync,mkdirSync,readFileSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import {basename,dirname,extname,isAbsolute,join,relative,resolve} from 'node:path';
import {usesSparkImage,hasSparkImageJob,hasRemoteMediaJob} from './providers.mjs';
import {runImageGenerator} from './runner.mjs';
import {verifySkillSnapshot} from '../skills/bundle.mjs';
import {resolveProjectCharacter} from './characters.mjs';
import {checkedMediaFile,projectPath} from './generator.mjs';
import {readJson} from '../tasks/agent-files.mjs';
import {hasFullFilesystemAccess} from '../tasks/execution.mjs';

const limit=20*1024*1024,maxTotal=64*1024*1024;
const kinds=['image_generate','gif_generate','media_export','gif_review'];
const formats=new Map([['.png','png'],['.jpg','jpeg'],['.jpeg','jpeg'],['.webp','webp'],['.gif','gif'],['.mp4','mp4'],['.mov','mov']]);
const stills=new Set(['png','jpeg','webp']);
const gifFiles={gif:['animation.gif','gif'],firstFrame:['first-frame.png','png'],video:['source.mp4','mp4']};
const generationFields=['status','provider','model','route','taskId','requestId','remoteCalls','reason','category','httpStatus','errorCode','providerStatus'];
const remoteId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(id);
const idOk=id=>typeof id==='string'&&/^[\w-]{1,100}$/.test(id);
const sha=v=>createHash('sha256').update(v).digest('hex');
const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const stable=v=>Array.isArray(v)?v.map(stable):plain(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,stable(x)])):v;
const key=v=>sha(JSON.stringify(stable(v)));
const code=(v,fallback='task_media_failed')=>typeof v==='string'&&/^[a-z][a-z0-9_]{1,120}$/.test(v)?v:fallback;
const pathOk=v=>typeof v==='string'&&v.length>0&&v.length<=1024&&!/[\\:\x00-\x1f\x7f]/.test(v)&&v.split('/').every(s=>s&&!s.startsWith('.'));
const format=path=>formats.get(extname(path).toLowerCase());
const identity=path=>{const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(path)!==path)throw Error('task_media_directory_changed');return {dev:s.dev,ino:s.ino};};
const below=(root,path)=>{const rel=relative(root,path);return !!rel&&!rel.startsWith('../')&&rel!=='..'&&!isAbsolute(rel);};
const awaiting=row=>['pending','partial'].includes(row.status)&&!row.terminalStatus&&remoteId(row.generation?.taskId);

function shortPaths(input,max,validate){
  if(input===undefined)return [];
  if(!Array.isArray(input)||input.length>max||input.some(v=>!validate(v))||new Set(input).size!==input.length)throw Error('invalid_task_media');
  return [...input];
}
export function normalizeTaskMedia(config){
  if(config===undefined)return undefined;
  if(!plain(config)||Object.keys(config).some(k=>!['operation','characterIds','projectInputs','outputPath'].includes(k))||!kinds.includes(config.operation))
    throw Error('invalid_task_media');
  const characterIds=shortPaths(config.characterIds,4,x=>typeof x==='string'&&/^[a-z][a-z0-9-]{0,47}$/.test(x));
  const projectInputs=shortPaths(config.projectInputs,20,x=>pathOk(x)&&formats.has(extname(x).toLowerCase()));
  if(config.outputPath!==undefined&&(!pathOk(config.outputPath)||config.operation==='gif_review'))throw Error('invalid_task_media');
  return {operation:config.operation,characterIds,projectInputs,...(config.outputPath===undefined?{}:{outputPath:config.outputPath})};
}
export function freezeTaskMedia({workspace,projectId,projectRevision,config,inputSnapshot,projectContext}){
  if(config===undefined)return undefined;
  const media=normalizeTaskMedia(config);
  if(!projectId||projectRevision===undefined)throw Error('task_media_project_required');
  const root=realpathSync(workspace);
  const validate=(path,actual)=>{
    const reference=(projectContext?.references??[]).find(ref=>ref.path===path);
    const expected=reference?.version??reference;
    if(expected&&Object.entries({...actual.version,sha256:actual.sha256}).some(([k,v])=>expected[k]!==undefined&&expected[k]!==v))
      throw Error('task_media_input_changed');
  };
  const projectInputs=media.projectInputs.map(rel=>{
    const path=projectPath(root,rel),actual=checkedMediaFile(path,limit);
    validate(path,actual);
    return {path,relativePath:rel,sha256:actual.sha256,size:actual.version.size};
  });
  const characters=media.characterIds.map(id=>resolveProjectCharacter(root,id));
  if(media.outputPath!==undefined&&media.operation!=='gif_generate'&&!format(media.outputPath))throw Error('invalid_task_media');
  const planned=media.outputPath===undefined?{}:{outputPath:media.outputPath,outputParent:identity(dirname(projectPath(root,media.outputPath)))};
  return {schemaVersion:1,operation:media.operation,projectId,projectRevision,projectRoot:root,projectIdentity:identity(root),...planned,
    projectInputs,characters,taskInputs:(inputSnapshot?.files??[]).filter(file=>format(file.path)).map(({path,sha256,size})=>({path,sha256,size}))};
}

export class BackgroundMedia {
  constructor({home,ops,tasks,events,runner=runImageGenerator,reviewer,onReady,now=Date.now,pollMs=3000,maxFollowMs=20*60*1000}){
    Object.assign(this,{ops,tasks,events,runner,reviewer,onReady,now,pollMs,maxFollowMs});
    const root=join(realpathSync(home),'task-media');
    this.stateDir=join(root,'journal');this.evidenceRoot=join(root,'evidence');
    for(const path of [this.stateDir,this.evidenceRoot]){mkdirSync(path,{recursive:true,mode:0o700});identity(path);}
    this.controllers=new Map();this.inflight=new Map();this.closed=false;this.polling=null;this.lastScan=0;this.stopEpoch=new Map();
  }
  records(){return this.ops.list('task_media').reverse();}
  get(id){let row;try{row=this.ops.get(id);}catch(e){if(e.message!=='unknown_id')throw e;}return row?.kind==='task_media'?row:null;}
  put(row){const value=this.ops.put(row);this.events?.publish('task.media.updated',{id:value.taskId,operationId:value.id,status:value.status});return value;}
  rows(taskId,assignment){return this.records().filter(row=>row.taskId===taskId&&(assignment===undefined||row.assignmentVersion===assignment));}
  valid(task,run,{poll=false}={}){
    if(this.closed||this.tasks.closed)throw Error('task_media_closed');
    const current=this.tasks.row('task',task.id),bound=this.tasks.row('run',run.id);
    const states=poll?['running','waiting_event','interrupted']:['running'];
    if(current.runId!==bound.id||bound.taskId!==current.id||bound.assignmentVersion!==current.assignmentVersion||!states.includes(current.status)||
        !states.includes(bound.status)||current.assignedBotId!==task.assignedBotId||current.closure?.status)throw Error('task_media_actor_stale');
    this.tasks.assertOpen?.(current);
    if(!hasFullFilesystemAccess(current)||current.managementReview||current.parentTaskId||!current.media||!bound.media)
      throw Error('task_media_permission_denied');
    if(bound.media.projectId!==current.projectId||bound.projectId!==current.projectId||bound.media.projectRevision!==current.projectRevision||
      key(bound.media)!==key(current.media))throw Error('task_media_project_changed');
    if(this.tasks.team&&(!this.tasks.team.profile(current.assignedBotId).enabled||
      current.assignedBotId!==this.tasks.team.chiefId&&!this.tasks.team.enabled()))throw Error('task_media_actor_disabled');
    const snapshot=bound.skills?.find(skill=>skill?.name==='image-production');
    if(!snapshot)throw Error('image_production_skill_required');
    if(!poll)verifySkillSnapshot(snapshot);
    return {task:current,run:bound,snapshot,media:bound.media};
  }
  workspace(task){
    const root=realpathSync(this.tasks.agentHome(task)),path=readJson(join(root,'workspace.json'))?.path;
    if(!path||!below(root,path))throw Error('task_workspace_not_ready');
    identity(path);
    return path;
  }
  project(media){
    const path=media.projectRoot;if(key(identity(path))!==key(media.projectIdentity))throw Error('task_media_project_changed');
    return path;
  }
  snapshot(record){
    const original=this.tasks.row('run',record.runId),snapshot=original.skills?.find(skill=>skill?.name==='image-production'&&skill.version===record.skillVersion);
    if(!snapshot||original.taskId!==record.taskId||original.assignmentVersion!==record.assignmentVersion)throw Error('task_media_snapshot_missing');
    return snapshot;
  }
  enter(record,signal,perform){
    const controller=new AbortController();
    const effective=signal?AbortSignal.any([controller.signal,signal]):controller.signal;
    this.controllers.set(record.id,{taskId:record.taskId,controller});
    const work=Promise.resolve().then(()=>perform(effective)).finally(()=>{this.inflight.delete(record.id);this.controllers.delete(record.id);});
    this.inflight.set(record.id,work);return work;
  }
  public(record,{allowWait=false}={}){
    const {envelope,output,targetParent,source,requestHash,nextPollAt,followUntil,deliveredAt,stoppedAt,waitRunId,actions,...body}=record;
    return {...body,...(record.reviewSource?{source:record.reviewSource}:{}),...(stoppedAt?{localFollow:'stopped'}:{}),
      ...(allowWait&&awaiting(record)&&!stoppedAt?{waitingForMedia:true}:{})};
  }
  reportOnly(task){return !!task.media;}
  view(taskId){
    const task=this.tasks.row('task',taskId);
    const records=this.rows(taskId,task.assignmentVersion).filter(row=>!row.detached).map(row=>this.public(row));
    return {records,artifacts:[...new Map(records.flatMap(row=>Object.values(row.artifacts??{})).map(item=>[item.path,item])).values()]};
  }
  evidence(taskId,runId){
    const run=this.tasks.row('run',runId);
    return this.rows(taskId,run.assignmentVersion).filter(row=>!row.detached&&
      (row.runId===run.id||row.waitRunId===run.id||run.mediaResume?.operationId===row.id))
      .map(row=>this.public(row));
  }
  artifacts(taskId,runId){
    if(!runId)return this.view(taskId).artifacts;
    const rows=this.evidence(taskId,runId);
    return [...new Map(rows.flatMap(row=>Object.values(row.artifacts??{})).map(item=>[item.path,item])).values()];
  }
  matchInput(raw,binding,scope,rootForOutput){
    if(typeof raw!=='string'||!raw||!format(raw))throw Error('invalid_task_media_input');
    const root=this.workspace(binding.task),project=this.project(binding.media);
    const knownRows=this.rows(binding.task.id,binding.task.assignmentVersion).filter(row=>!row.detached);
    const candidates=[
      ...binding.media.projectInputs.map(item=>({...item,scope:'project'})),
      ...binding.media.characters.flatMap(character=>character.references.map(item=>({...item,relativePath:relative(project,item.path),scope:'project'}))),
      ...binding.media.taskInputs.map(item=>({...item,path:join(root,item.path),relativePath:item.path,scope:'task'})),
      ...knownRows.flatMap(row=>Object.values(row.artifacts??{})).filter(item=>item.scope!=='evidence').map(item=>({...item,relativePath:relative(item.scope==='task'?root:project,item.path)})),
    ];
    // Only declared assets, pinned profiles, or previous trusted artifacts. A
    // background worker cannot invent a path to a different project or task.
    const named=item=>isAbsolute(raw)?raw===item.path:pathOk(raw)&&raw===item.relativePath;
    const direct=candidates.find(item=>item.scope===(scope??'task')&&named(item));
    const value=direct??candidates.find(named);
    if(!value)throw Error('task_media_input_not_bound');
    if(scope==='project'&&value.scope!=='project')throw Error('task_media_project_output_requires_project_inputs');
    const actual=checkedMediaFile(value.path,limit);
    if(actual.sha256!==value.sha256||value.size!==undefined&&actual.version.size!==value.size)throw Error('task_media_input_changed');
    return {path:value.path,sha256:value.sha256,size:actual.version.size,format:format(value.path),copy:value.scope==='project'&&rootForOutput===root};
  }
  makeInput(ref,workspace,operationId){
    if(!ref.copy)return ref.path;
    const top=join(workspace,'.opennova-media-inputs'),stage=join(top,operationId);
    for(const path of [top,stage]){try{mkdirSync(path,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}identity(path);}
    const path=join(stage,ref.sha256+extname(ref.path).toLowerCase());
    const bytes=readFileSync(ref.path);
    if(bytes.length!==ref.size||sha(bytes)!==ref.sha256||realpathSync(ref.path)!==ref.path)throw Error('task_media_input_changed');
    try{writeFileSync(path,bytes,{mode:0o400,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
    if(checkedMediaFile(path,limit).sha256!==ref.sha256)throw Error('task_media_input_changed');
    return path;
  }
  prepare(name,input,binding,id){
    const {outputScope='task',characterId,...args}=input;
    const {media,task}=binding;
    if(!['task','project'].includes(outputScope))throw Error('invalid_task_media_scope');
    const workspace=outputScope==='project'?this.project(media):this.workspace(task);
    const field=name==='gif_generate'?'outputDir':'outputPath',requested=args[field];
    const rel=typeof requested==='string'&&isAbsolute(requested)&&below(workspace,requested)?relative(workspace,requested):requested;
    if(!pathOk(rel))throw Error('invalid_task_media_output');
    if(outputScope==='project'&&rel!==media.outputPath)throw Error('task_media_project_output_not_authorized');
    const output=projectPath(workspace,rel),targetParent=identity(dirname(output));
    if(outputScope==='project'&&key(targetParent)!==key(media.outputParent))throw Error('task_media_project_changed');
    if(field==='outputPath'&&!format(output))throw Error('invalid_task_media_output');
    try{lstatSync(output);throw Error('media_target_exists');}catch(error){if(error.code!=='ENOENT')throw error;}
    args[field]=output;
    const mapped=new Map();
    let size=0;
    const source=(path,still=false)=>{
      const ref=this.matchInput(path,binding,outputScope,workspace);
      if(still&&!stills.has(ref.format))throw Error('invalid_task_media_input');
      if(!mapped.has(ref.path)){size+=ref.size;if(size>maxTotal)throw Error('task_media_inputs_too_large');mapped.set(ref.path,{...ref,stagedPath:this.makeInput(ref,workspace,id)});}
      return mapped.get(ref.path).stagedPath;
    };
    let character;
    if(characterId!==undefined){
      character=media.characters.find(item=>item.id===characterId);
      if(!character||!['image_generate','gif_generate'].includes(name))throw Error('character_not_in_task');
      const promptKey=name==='image_generate'?'prompt':'motion';
      if(typeof args[promptKey]!=='string')throw Error('invalid_task_media_arguments');
      args[promptKey]+='\n已确认的角色视觉约束（只作身份参考）：'+JSON.stringify(character.constraints);
      for(const ref of character.references)this.matchInput(ref.path,binding,outputScope,workspace);
    }
    if(name==='image_generate'){
      if(args.references!==undefined&&(!Array.isArray(args.references)||args.references.length>10))throw Error('invalid_task_media_arguments');
      if(character&&args.mode!=='edit')throw Error('character_requires_edit');
      const refs=[...(args.references??[]),...(character?.references.map(r=>r.path)??[])];
      if(refs.length>10)throw Error('invalid_task_media_arguments');
      if(refs.length)args.references=[...new Set(refs.map(path=>source(path,true)))];
    }else if(name==='gif_generate'){
      args.sourcePath=source(args.sourcePath,true);
      for(const field of ['fixedOverlayPath','motionReferencePath'])if(args[field]!==undefined)args[field]=source(args[field],true);
      if(args.maxBytes===undefined)args.maxBytes=limit;
    }else{
      if(args.maxBytes!==undefined&&(!Number.isSafeInteger(args.maxBytes)||args.maxBytes<1||args.maxBytes>limit))throw Error('task_media_artifact_limit');
      args.maxBytes??=limit;
      if(args.frames!==undefined){
        if(!Array.isArray(args.frames)||args.frames.length>256)throw Error('invalid_task_media_arguments');
        args.frames=args.frames.map(frame=>({...frame,path:source(frame?.path,true)}));
      }
      if(args.sourcePath!==undefined)args.sourcePath=source(args.sourcePath);
      if(args.fixedOverlayPath!==undefined)args.fixedOverlayPath=source(args.fixedOverlayPath,true);
    }
    const inputs=[...mapped.values()].map(({path,sha256,size,stagedPath})=>({path,sha256,size,stagedPath}));
    const expectedReferenceHashes=Object.fromEntries(inputs.map(ref=>[ref.stagedPath,ref.sha256]));
    const envelope={tool:name,arguments:args,context:{operationId:id,workspace,stateDir:this.stateDir,
      binding:{projectId:task.projectId,taskId:task.id,runId:binding.run.id},expectedReferenceHashes,
      ...(name==='media_export'?{expectedOutputParentIdentity:[targetParent.dev,targetParent.ino]}:{})}};
    return {envelope,output,targetParent,scope:outputScope,inputs:inputs.map(({stagedPath,...ref})=>ref),character};
  }
  owned(task,operationId){
    if(operationId!==undefined&&!idOk(operationId))throw Error('invalid_task_media_operation');
    const rows=this.rows(task.id,task.assignmentVersion).filter(row=>!row.detached&&(!operationId||row.id===operationId));
    if(operationId&&!rows.length)throw Error('task_media_not_owned');
    return rows;
  }
  async status(binding,args,signal){
    if(Object.keys(args).some(k=>!['operationId','follow'].includes(k))||args.follow!==undefined&&typeof args.follow!=='boolean'||
       args.follow===true&&!args.operationId)throw Error('invalid_task_media_arguments');
    const {task,run}=binding,rows=this.owned(task,args.operationId);
    if(!args.operationId)return {status:'completed',operations:rows.map(row=>this.public(row))};
    let row=rows[0];
    if(row.status==='running'&&!this.inflight.has(row.id))row=await this.recover(row,signal);
    if(args.follow&&row.error==='task_media_follow_timeout'&&remoteId(row.generation?.taskId))
      row={...row,status:'pending',terminalStatus:undefined,error:undefined,finishedAt:undefined};
    if(args.follow&&awaiting(row)){
      if(!row.stoppedAt&&row.waitRunId&&row.waitRunId!==run.id)throw Error('task_media_follow_already_bound');
      signal?.throwIfAborted();
      row=this.put({...row,stoppedAt:undefined,deliveredAt:undefined,waitRunId:run.id,nextPollAt:this.now(),followUntil:this.now()+this.maxFollowMs});
      return this.public(row,{allowWait:true});
    }
    return this.public(row);
  }
  journal(record){
    try{
      const path=join(this.stateDir,record.id,'operation.json');
      if(realpathSync(path)!==path||statSync(path).size>1024*1024)return null;
      const saved=JSON.parse(readFileSync(path,'utf8'));
      return this.bound(record,saved)?saved:null;
    }catch{return null;}
  }
  bound(record,result){
    const b=result?.binding;
    return result?.tool===record.name&&result.operationId===record.id&&b?.projectId===record.projectId&&b?.taskId===record.taskId&&b?.runId===record.runId;
  }
  verified(path,value,record,role,scope,formatForSlot){
    if(!value||value.path!==path||value.format!==formatForSlot||typeof value.sha256!=='string')throw Error('invalid_task_media_receipt');
    const actual=checkedMediaFile(path,limit);
    if(actual.sha256!==value.sha256||actual.version.size!==value.bytes)throw Error('task_media_artifact_changed');
    const {width,height,frames,durationMs,loop,firstFrameValidation,fixedOverlay}=value;
    return {path,name:basename(path),size:actual.version.size,bytes:actual.version.size,sha256:actual.sha256,role,scope,operationId:record.id,
      format:formatForSlot,width,height,frames,durationMs,loop,firstFrameValidation,fixedOverlay};
  }
  storeReceipt(record,result){
    if(!this.bound(record,result)||!['completed','failed','cancelled','unknown','pending','partial'].includes(result.status))throw Error('invalid_task_media_receipt');
    const generation=Object.fromEntries(generationFields.filter(k=>result.generation?.[k]!==undefined).map(k=>[k,result.generation[k]]));
    const row={...record,phase:result.stage,status:result.status,generation,runtime:result.runtime,
      fileValidation:result.fileValidation,animationValidation:result.animationValidation,firstFrameValidation:result.firstFrameValidation,
      visualReview:result.visualReview??{status:'not_checked'},terminalStatus:result.terminalStatus,error:result.error?.code?code(result.error.code):undefined,
      finishedAt:this.now()};
    if(generation.taskId!==undefined&&!remoteId(generation.taskId)||record.generation?.taskId&&generation.taskId!==record.generation.taskId)
      throw Error('task_media_provider_id_changed');
    if(record.name==='gif_generate'){
      if((row.status==='completed'||['pending','partial'].includes(row.status)&&!row.terminalStatus)&&!remoteId(generation.taskId))throw Error('invalid_task_media_receipt');
      const entries=Object.entries(gifFiles).filter(([role])=>result.artifacts?.[role]!==undefined||row.status==='completed');
      row.artifacts=Object.fromEntries(entries.map(([role,[name,fmt]])=>[role,this.verified(join(record.output,name),result.artifacts?.[role],record,role,record.scope,fmt)]));
      if(row.status==='completed'&&(result.fileValidation?.status!=='passed'||result.firstFrameValidation?.status!=='passed'))
        throw Error('invalid_task_media_receipt');
    }else{
      const spark=record.name==='image_generate'&&usesSparkImage(record.envelope?.arguments);
      if(row.status==='partial'||row.status==='pending'&&!spark||
        spark&&(generation.taskId!==undefined||['completed','pending'].includes(row.status))&&!hasSparkImageJob(generation)||
        record.name==='media_export'&&generation.remoteCalls!==0)throw Error('invalid_task_media_receipt');
      row.artifacts=row.status==='completed'?{[record.name==='image_generate'?'image':'export']:
        this.verified(record.output,result.artifact,record,record.name==='image_generate'?'image':'export',record.scope,format(record.output))}:{};
      if(row.status==='completed'&&result.fileValidation?.status!=='passed')throw Error('invalid_task_media_receipt');
    }
    if(Object.values(row.artifacts).reduce((n,item)=>n+item.bytes,0)>maxTotal)throw Error('task_media_artifact_limit');
    if(awaiting(row)){row.nextPollAt=this.now()+this.pollMs;row.finishedAt=undefined;}
    return this.put(row);
  }
  performChecks(record,signal){
    signal?.throwIfAborted();
    const task=this.tasks.row('task',record.taskId);
    if(task.projectId!==record.projectId||task.assignmentVersion!==record.assignmentVersion||task.closure?.status)
      throw Error('task_media_actor_stale');
    if(['paused','pausing','cancelled','cancelling'].includes(task.status))throw Error('task_media_actor_stale');
    this.tasks.assertOpen?.(task);
    if(record.scope==='project')this.project(task.media);
    if(record.output&&key(identity(dirname(record.output)))!==key(record.targetParent))throw Error('task_media_directory_changed');
  }
  completeError(record,error,{candidate=true,recovering=false}={}){
    const saved=candidate?this.journal(record):null;
    if(saved&&saved.status!=='running'&&!(recovering&&awaiting(record)&&awaiting(saved))){
      try{return this.storeReceipt(record,saved);}catch(error2){error=error2;}
    }
    // A lost submit response may leave only the locally allocated Spark job ID.
    if(!recovering&&record.name==='image_generate'&&usesSparkImage(record.envelope?.arguments)&&
      saved?.stage==='submitting_spark'&&hasSparkImageJob(saved.generation))
      return this.storeReceipt(record,{...saved,status:'pending'});
    const errorCode=code(error.message);
    const uncertain=['image_generate','gif_generate'].includes(record.name)&&(saved?.stage==='submitting'||
      saved?.stage==='response_received'||!saved&&['invalid_image_executor_receipt','image_executor_receipt_missing','image_executor_interrupted','image_executor_timeout'].includes(errorCode));
    const known=record.generation?.taskId&&awaiting(record);
    const transient=['image_executor_interrupted','image_executor_timeout','image_executor_receipt_missing','operation_in_progress'].includes(errorCode);
    if(known&&recovering&&transient)
      return this.put({...record,nextPollAt:this.now()+this.pollMs,error:errorCode});
    const status=uncertain?'unknown':code(error.message)==='image_executor_interrupted'?'interrupted':'failed';
    return this.put({...record,status,error:uncertain?'task_media_submission_unknown':errorCode,
      ...(known?{terminalStatus:status}:{}),finishedAt:this.now()});
  }
  async runTool(record,snapshot,signal,{recovering=false}={}){
    try{
      this.performChecks(record,signal);
      const receipt=await this.runner(record.envelope,{signal,snapshot,recoverOnly:recovering&&record.name!=='media_export'});
      return this.storeReceipt(this.get(record.id)??record,receipt);
    }catch(error){return this.completeError(this.get(record.id)??record,error,{recovering});}
  }
  async recover(record,signal){
    if(this.inflight.has(record.id))return this.inflight.get(record.id);
    const saved=this.journal(record);
    if(saved&&saved.status!=='running'){
      try{return this.storeReceipt(record,saved);}catch(error){return this.completeError(record,error,{candidate:false});}
    }
    if(record.name==='image_generate'&&usesSparkImage(record.envelope?.arguments)&&
      ['submitting_spark','awaiting_provider'].includes(saved?.stage)&&hasSparkImageJob(saved.generation))
      return this.storeReceipt(record,{...saved,status:'pending'});
    const canFinish=saved&&((record.name==='image_generate'&&['receiving','delivering'].includes(saved.stage))||
      (record.name==='media_export'&&['prepared','rendered','publishing','committed'].includes(saved.stage)));
    if(canFinish&&record.envelope)return this.enter(record,signal,inner=>this.runTool(record,this.snapshot(record),inner,{recovering:true}));
    const uncertain=['image_generate','gif_generate'].includes(record.name)&&(!saved||['submitting','response_received'].includes(saved.stage));
    return this.put({...record,status:uncertain?'unknown':'interrupted',error:uncertain?'task_media_submission_unknown':'task_media_interrupted',finishedAt:this.now()});
  }
  review(args,binding,id){
    if(!this.reviewer)throw Error('task_media_reviewer_unavailable');
    if(Object.keys(args).some(k=>!['operationId','path','question'].includes(k))||[args.operationId,args.path].filter(v=>v!==undefined).length!==1||
      args.question!==undefined&&(typeof args.question!=='string'||!args.question.trim()||args.question.length>2000||args.question.includes('\0')))
      throw Error('invalid_task_media_arguments');
    const {task}=binding;
    let source;
    if(args.operationId){
      const [row]=this.owned(task,args.operationId);
      const artifact=row.artifacts?.gif??row.artifacts?.export;
      if(row.status!=='completed'||artifact?.format!=='gif')throw Error('task_media_review_source_unavailable');
      source={path:artifact.path,sha256:artifact.sha256,size:artifact.size,operationId:row.id};
    }else{
      source=this.matchInput(args.path,binding);
      if(source.format!=='gif')throw Error('task_media_review_source_unavailable');
    }
    const evidenceDir=join(this.evidenceRoot,id);
    mkdirSync(evidenceDir,{mode:0o700});
    const expected={sha256:source.sha256,size:source.size};
    return {source,evidenceDir,expected};
  }
  async execute({task,run,actionId,name,args={},signal}){
    if(!idOk(actionId)||!plain(args)||JSON.stringify(args).length>128000)throw Error('invalid_task_media_arguments');
    signal?.throwIfAborted();
    const binding=this.valid(task,run);
    if(name==='project_media_characters'){
      if(Object.keys(args).length)throw Error('invalid_task_media_arguments');
      return {status:'completed',projectId:task.projectId,characters:binding.media.characters.map(({id,name,version})=>({id,name,version}))};
    }
    if(name==='task_media_status')return this.status(binding,args,signal);
    if(name!==binding.media.operation&&!(name==='gif_review'&&binding.media.operation==='gif_generate'))throw Error('task_media_operation_not_authorized');
    if(!kinds.includes(name))throw Error('task_media_operation_not_authorized');
    const differentAssignment=this.rows(task.id).some(row=>row.assignmentVersion!==task.assignmentVersion&&row.name===name&&
      (row.status==='completed'||row.status==='running'||row.status==='unknown'||row.generation?.remoteCalls>0));
    if(differentAssignment&&['gif_generate','image_generate'].includes(name))throw Error('task_media_prior_operation_requires_review');
    const rows=this.owned(task);
    const requestHash=key([name,args]),action=rows.find(row=>row.actions?.includes(actionId));
    if(action&&action.requestHash!==requestHash)throw Error('task_media_action_conflict');
    const prior=action??rows.find(row=>row.requestHash===requestHash);
    if(prior){
      if(!prior.actions.includes(actionId))this.put({...prior,actions:[...prior.actions.slice(0,31),actionId]});
      const entry=this.inflight.get(prior.id)??(prior.status==='running'?this.recover(prior,signal):prior);
      const result=await entry;
      return this.public(result,{allowWait:(result.waitRunId??result.runId)===run.id});
    }
    if(rows.length>=12)throw Error('task_media_limit_exceeded');
    if(name==='gif_generate'&&rows.some(row=>row.name==='gif_generate')||
      ['gif_generate','image_generate'].includes(name)&&rows.some(row=>row.name===name&&['running','unknown','pending','partial','interrupted'].includes(row.status))||
      run.mediaResume&&['gif_generate','image_generate'].includes(name))throw Error('task_media_prior_operation_requires_review');
    const epoch=this.stopEpoch.get(task.id);
    const id='task-media-'+key([task.projectId,task.id,task.assignmentVersion,requestHash]).slice(0,40);
    const preliminary={id,operationId:id,kind:'task_media',operation:name,name,taskId:task.id,runId:run.id,assignmentVersion:task.assignmentVersion,
      projectId:task.projectId,projectRevision:binding.media.projectRevision,skillVersion:binding.snapshot.version,requestHash,actions:[actionId],
      status:'running',createdAt:this.now(),followUntil:this.now()+this.maxFollowMs};
    if(name==='gif_review'){
      const prepared=this.review(args,binding,id);
      this.valid(task,run);signal?.throwIfAborted();
      let record=this.put({...preliminary,reviewSource:prepared.source,scope:'evidence'});
      const value=await this.enter(record,signal,async inner=>{
        try{
          const result=await this.reviewer({path:prepared.source.path,expected:prepared.expected,question:args.question,
            snapshot:binding.snapshot,signal:inner,evidenceDir:prepared.evidenceDir,check:()=>{inner.throwIfAborted();this.valid(task,run);}});
          inner.throwIfAborted();
          const artifacts=result.artifacts?.length?{contactSheet:this.verified(join(prepared.evidenceDir,'gif-contact-sheet.png'),
            result.artifacts[0],record,'contactSheet','evidence','png')}:{};
          return this.put({...record,status:result.status==='completed'?'completed':'failed',error:result.error?code(result.error):undefined,
            visualReview:result.visualReview??{status:'not_checked'},runtime:result.runtime,artifacts,finishedAt:this.now()});
        }catch(error){return this.completeError(this.get(id)??record,error,{candidate:false});}
      });
      return this.public(value);
    }
    const {properties}=JSON.parse(readFileSync(join(binding.snapshot.archiveRoot,'tools/image/tool-definitions.json'),'utf8')).find(d=>d.function?.name===name)?.function?.parameters??{};
    if(!properties||Object.keys(args).some(k=>!Object.hasOwn(properties,k)&&k!=='outputScope'&&k!=='characterId'))throw Error('invalid_task_media_arguments');
    if(name==='media_export'&&!readFileSync(join(binding.snapshot.archiveRoot,'tools/image/tool.py'),'utf8').includes('expectedOutputParentIdentity'))
      throw Error('task_media_executor_upgrade_required');
    const prepared=this.prepare(name,args,binding,id);
    this.valid(task,run);signal?.throwIfAborted();
    const record=this.put({...preliminary,...prepared});
    const value=await this.enter(record,signal,inner=>this.runTool(record,binding.snapshot,inner));
    return this.public(value,{allowWait:epoch===this.stopEpoch.get(task.id)});
  }
  awaiting(taskId,runId){
    const task=this.tasks.row('task',taskId);
    return this.rows(taskId,task.assignmentVersion).filter(row=>{
      if(row.stoppedAt||row.deliveredAt||row.detached||(row.waitRunId??row.runId)!==runId)return false;
      return row.name==='gif_generate'||row.name==='image_generate'&&usesSparkImage(row.envelope?.arguments)&&
        (row.status==='running'||row.nextPollAt!==undefined);
    })
      .map(row=>{
        if(hasRemoteMediaJob(row))return row;
        const saved=this.journal(row);
        return saved&&hasRemoteMediaJob(row,saved.generation)?{...row,status:saved.status,generation:saved.generation}:null;
      }).find(Boolean);
  }
  stop(taskId){
    this.stopEpoch.set(taskId,(this.stopEpoch.get(taskId)??0)+1);
    for(const row of this.rows(taskId))if(!row.stoppedAt&&['running','pending','partial'].includes(row.status))this.put({...row,stoppedAt:this.now()});
    for(const {taskId:id,controller} of this.controllers.values())if(id===taskId)controller.abort(Error('task_media_stopped'));
  }
  tick(){
    if(this.closed)return Promise.resolve();
    if(this.polling)return this.polling;
    if(this.lastScan&&this.now()-this.lastScan<Math.min(this.pollMs,1000))return Promise.resolve();
    this.lastScan=this.now();
    return this.polling=this.poll().finally(()=>{this.polling=null;});
  }
  async poll(){
    const rows=this.records().filter(row=>!row.stoppedAt&&!row.deliveredAt&&!row.detached&&!this.inflight.has(row.id)&&
      (row.status==='running'||hasRemoteMediaJob(row)&&(row.name==='gif_generate'||row.nextPollAt!==undefined)&&
       (row.nextPollAt===undefined||row.nextPollAt<=this.now())&&(awaiting(row)||row.finishedAt)));
    await Promise.allSettled(rows.slice(0,4).map(async row=>{
      if(this.closed)return;
      const task=this.tasks.row('task',row.taskId),run=this.tasks.row('run',row.waitRunId??row.runId);
      if(task.assignmentVersion!==row.assignmentVersion){
        this.put({...row,detached:true});return;
      }
      if(task.runId!==run.id){
        const current=this.tasks.row('run',task.runId);
        this.put({...row,...(current.mediaResume?.operationId===row.id?{deliveredAt:this.now()}:{stoppedAt:this.now()})});return;
      }
      if(task.closure?.status||['paused','cancelled','pausing','cancelling'].includes(task.status)){this.stop(task.id);return;}
      if(!['waiting_event','running','interrupted'].includes(task.status)){this.put({...row,deliveredAt:this.now()});return;}
      try{this.valid(task,run,{poll:true});}catch(error){
        // A later skill opt-out does not substitute the snapshotted executable.
        // Disabled or no longer authorized assignments must stop following.
        if(task.status!=='interrupted')this.stop(task.id);
        return;
      }
      if(row.status==='running')row=await this.recover(row);
      if(awaiting(row)&&['waiting_event','interrupted'].includes(task.status)){
        if(row.followUntil<=this.now())row=this.put({...row,status:'interrupted',terminalStatus:'interrupted',error:'task_media_follow_timeout',finishedAt:this.now()});
        else row=await this.enter(row,undefined,signal=>this.runTool(row,this.snapshot(row),signal,{recovering:true}));
      }
      if(this.closed)return;
      const latest=this.get(row.id);
      if(latest&&!latest.stoppedAt&&!awaiting(latest)&&hasRemoteMediaJob(latest)&&
        latest.finishedAt&&this.onReady){
        const delivered=await this.onReady({...this.public(latest),originRunId:latest.runId,runId:latest.waitRunId??latest.runId});
        if(delivered===true||delivered?.delivered===true)this.put({...this.get(row.id),deliveredAt:this.now()});
      }
    }));
  }
  async close(){
    this.closed=true;
    for(const {controller} of this.controllers.values())controller.abort(Error('task_media_closed'));
    await Promise.allSettled([...this.inflight.values(),...(this.polling?[this.polling]:[])]);
  }
}
