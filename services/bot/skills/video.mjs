/** Task-bound video tools and resumable remote jobs. Python owns media work. */
import {createHash} from 'node:crypto';
import {spawn as nodeSpawn} from 'node:child_process';
import {readFileSync,existsSync,realpathSync,statSync,createReadStream} from 'node:fs';
import {dirname,join,basename} from 'node:path';
import {ROOT} from '../../runtime/sources.mjs';
import {readJson} from '../tasks/agent-files.mjs';
import {resolveTaskPath,hasFullFilesystemAccess} from '../tasks/filesystem.mjs';
import {readPreviewBytes} from '../images/preview.mjs';
import {verifySkillSnapshot} from './bundle.mjs';

export const VIDEO_TOOL_NAMES=['video_validate','video_submit','video_status','video_wait','video_download','video_edit','video_generate'];
const remoteTools=new Set(['video_submit','video_status','video_wait','video_download','video_generate']);
const sparkModels=new Set(['minimax-h3-spark','minimax-h3-veda']);
const pendingStates=new Set(['submitted','queued','pending','running','processing']);
const terminalStates=new Set(['succeeded','failed','expired','cancelled']);
const idOk=value=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const copy=value=>JSON.parse(JSON.stringify(value));
const argumentKeys={video_generate:['config','config_path','output_dir','task_id','filename','poll_seconds','timeout_seconds'],video_validate:['config','config_path'],video_submit:['config','config_path','output_dir'],video_status:['task_id','output_dir'],video_wait:['task_id','output_dir','poll_seconds','timeout_seconds'],video_download:['task_id','output_dir','filename'],video_edit:['config','config_path','dry_run']};
const allowedResultKeys=new Set(['status','task_id','output_dir','path','size_bytes','metadata','settings','reference_count','video_reference_count','generation_mode','first_frame','asset_validation','plan','timed_out','phase','error','sha256']);
async function referenceDigest(config){
  const files=[...(config.reference_images??[]),...(config.reference_videos??[]),...(config.first_frame_path?[config.first_frame_path]:[])];
  if(!files.length)return null;
  const references=[];
  for(const file of new Set(files)){
    const stat=statSync(file),limit=config.reference_videos?.includes(file)?200:30;
    if(!stat.isFile()||!stat.size||stat.size>limit*1024*1024)throw Error('invalid_video_reference');
    const sha=createHash('sha256');
    for await(const chunk of createReadStream(file))sha.update(chunk);
    references.push([file,sha.digest('hex')]);
  }
  return hash(JSON.stringify(references));
}

const canonicalPath=path=>{let parent=path;const parts=[];while(!existsSync(parent)&&dirname(parent)!==parent){parts.unshift(basename(parent));parent=dirname(parent);}return join(realpathSync(parent),...parts);};

function harnessSchema(schema){
  const value=Object.fromEntries(['type','title','description','default','examples','enum','const'].filter(key=>Object.hasOwn(schema,key)).map(key=>[key,schema[key]]));
  const limits=['minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','minItems','maxItems','minLength','maxLength','pattern'].filter(key=>Object.hasOwn(schema,key)).map(key=>key+'='+JSON.stringify(schema[key]));
  if(limits.length)value.description=[value.description,limits.join('; ')].filter(Boolean).join(' ');
  if(schema.type==='object'){
    value.additionalProperties=schema.additionalProperties!==false;
    value.properties=Object.fromEntries(Object.entries(schema.properties??{}).map(([key,property])=>[key,{...harnessSchema(property),...schema.required?.includes(key)?{required:true}:{}}]));
  }
  if(schema.type==='array'&&schema.items)value.items=harnessSchema(schema.items);
  return value;
}

/** Harness parameters use required on each property, not a root required array. */
export function videoToolDefinitions(root=ROOT){
  return JSON.parse(readFileSync(join(root,'tools/video/tool-definitions.json'),'utf8')).map(({function:definition})=>{
    const parameters=Object.fromEntries(Object.entries(definition.parameters.properties).map(([name,value])=>[name,{...harnessSchema(value),...definition.parameters.required?.includes(name)&&name!=='output_dir'?{required:true}:{}}]));
    if(parameters.output_dir)parameters.output_dir={...parameters.output_dir,description:'本任务视频目录；提交时省略会按配置生成稳定目录。后续操作使用之前返回的 output_dir。'};
    if(definition.name==='video_wait')return [definition.name,'等待已有视频生成。先查询一次，未完成则登记后台跟进并让出执行位置；不会重新提交。',parameters];
    return [definition.name,definition.description,parameters];
  });
}

function validateSchema(value,schema){
  if(schema.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_video_arguments');
    if(schema.additionalProperties===false&&Object.keys(value).some(k=>!Object.hasOwn(schema.properties??{},k)))throw Error('invalid_video_arguments');
    for(const key of schema.required??[])if(!Object.hasOwn(value,key))throw Error('invalid_video_arguments');
    for(const [key,item] of Object.entries(value))if(schema.properties?.[key])validateSchema(item,schema.properties[key]);
  }else if(schema.type==='array'){
    if(!Array.isArray(value)||value.length<(schema.minItems??0)||value.length>(schema.maxItems??10000))throw Error('invalid_video_arguments');
    for(const item of value)validateSchema(item,schema.items??{});
  }else if(schema.type==='string'){
    if(typeof value!=='string'||value.includes('\0')||value.length<(schema.minLength??0)||value.length>(schema.maxLength??64000)||schema.pattern&&!new RegExp(schema.pattern).test(value))throw Error('invalid_video_arguments');
  }else if(schema.type==='number'||schema.type==='integer'){
    if(typeof value!=='number'||!Number.isFinite(value)||schema.type==='integer'&&!Number.isInteger(value)||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity)||schema.exclusiveMinimum!==undefined&&value<=schema.exclusiveMinimum||schema.multipleOf&&value%schema.multipleOf!==0)throw Error('invalid_video_arguments');
  }else if(schema.type==='boolean'&&typeof value!=='boolean')throw Error('invalid_video_arguments');
  if(schema.enum&&!schema.enum.includes(value))throw Error('invalid_video_arguments');
  if(Object.hasOwn(schema,'const')&&value!==schema.const)throw Error('invalid_video_arguments');
}

// Older frozen catalogs also have a local first_frame_path, but only declare P2.
function catalogModelRules(schema,id){
  return (schema.allOf??[]).filter(rule=>{
    const model=rule.if?.properties?.model;
    return model?.const===id||model?.enum?.includes(id);
  });
}

function validateGenerationMode(config,schema,extended){
  if(sparkModels.has(config.model)){
    const supported=['model','prompt','duration','ratio','seed','first_frame_path'];
    const rules=catalogModelRules(schema,config.model);
    if(!rules.length||Object.keys(config).some(key=>!supported.includes(key))||(config.ratio??'9:16')!=='9:16')throw Error('invalid_video_arguments');
    // Apply the frozen catalog's common, model-specific and first-frame duration limits.
    const duration=config.duration??4;
    for(const {then:profile} of rules){
      if(profile.required?.includes('first_frame_path')&&!config.first_frame_path)throw Error('invalid_video_arguments');
      validateSchema(duration,{type:'integer',...profile.properties?.duration});
      if(config.first_frame_path&&profile.if?.required?.includes('first_frame_path')){
        validateSchema(duration,{type:'integer',...profile.then.properties?.duration});
      }
    }
    return;
  }
  const localFrame=Object.hasOwn(config,'first_frame_path');
  if(Object.hasOwn(config,'seed')||localFrame&&(!extended||!config.first_frame_path||Object.hasOwn(config,'first_frame')))throw Error('invalid_video_arguments');
  if(!Object.hasOwn(config,'first_frame')&&!localFrame)return;
  // Asset identifiers are provider references, never local paths. Keep this
  // check before dispatch/reservation, including when config came from a file.
  if(!localFrame&&(typeof config.first_frame!=='string'||!/^asset:\/\/asset-[A-Za-z0-9_-]+$/.test(config.first_frame)||config.first_frame!==config.first_frame.trim())||
    (!localFrame||Object.hasOwn(config,'model'))&&(typeof config.model!=='string'||!config.model.trim())||config.reference_images?.length||config.reference_videos?.length||Object.hasOwn(config,'omni_reference_task_type'))throw Error('invalid_video_arguments');
  const model=config.model??'doubao-seedance-2-5-260628';
  if(model.startsWith('doubao-seedance-2-0-')&&(config.duration??10)>15||
    model.startsWith('doubao-seedance-2-0-fast-')&&!['480p','720p'].includes(config.resolution??'720p')||
    model.startsWith('doubao-seedance-2-5-')&&(config.ratio??'adaptive')!=='adaptive')throw Error('invalid_video_arguments');
}

function safeResult(value,key=''){
  const clean=text=>String(text).replaceAll(key||'\0','[redacted]').replace(/https?:\/\/[^\s"<>]+/g,'[remote URL]').slice(0,2000);
  const visit=item=>typeof item==='string'?clean(item):Array.isArray(item)?item.slice(0,100).map(visit):item&&typeof item==='object'?Object.fromEntries(Object.entries(item).filter(([name])=>!/(secret|token|credential|api.?key|authorization|download_url|video_url)/i.test(name)).slice(0,80).map(([name,v])=>[name,visit(v)])):item;
  const result=Object.fromEntries(Object.entries(value??{}).filter(([name])=>allowedResultKeys.has(name)).map(([name,item])=>[name,visit(item)]));
  if(Buffer.byteLength(JSON.stringify(result))>64000)throw Error('video_result_too_large');
  return result;
}

/** Spawn only the bundled CLI; credentials are process environment, never JSON. */
export function createVideoTransport({root=ROOT,spawn=nodeSpawn,python=process.env.OPENNOVA_PYTHON||'python3',timeoutMs=120000}={}){
  return ({name,args,workspace,credential='',signal,toolRoot=root})=>new Promise((resolveDone,reject)=>{
    const controller=new AbortController(),combined=AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);
    if(combined.aborted){reject(Error('video_cancelled'));return;}
    let child,stdout='',bytes=0,settled=false,killTimer;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(killTimer);combined.removeEventListener('abort',abort);error?reject(error):resolveDone(result);};
    const kill=signal=>{try{if(child?.pid&&process.platform!=='win32')process.kill(-child.pid,signal);else child?.kill(signal);}catch(error){if(error.code!=='ESRCH')child?.kill(signal);}};
    const abort=()=>{kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),1000);killTimer.unref();};
    try{
      const env={...process.env};delete env.ARK_API_KEY;if(credential)env.ARK_API_KEY=credential;
      child=spawn(python,[join(toolRoot,'tools/video/tool.py'),'--request','-'],{cwd:workspace,env,shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
      combined.addEventListener('abort',abort,{once:true});
      child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024*1024){controller.abort();return;}stdout+=chunk.toString('utf8');});
      // stderr can contain provider diagnostics; it is intentionally not surfaced.
      child.stderr.on('data',()=>{});child.on('error',()=>finish(Error('video_process_unavailable')));
      child.stdin.on('error',()=>{});
      child.on('close',code=>{
        // FFmpeg belongs to the same group; a cancelled Python parent must not leave it behind.
        if(combined.aborted)kill('SIGKILL');
        if(combined.aborted){finish(Error(bytes>1024*1024?'video_result_too_large':'video_cancelled'));return;}
        let value;try{value=JSON.parse(stdout);}catch{finish(Error('video_invalid_response'));return;}
        if(code!==0||value.ok!==true){
          const failure=Error(String(value.error||'video_tool_failed').replaceAll(credential||'\0','[redacted]').replace(/https?:\/\/[^\s"<>]+/g,'[remote URL]').slice(0,500));
          // The CLI reserves its on-disk operation before contacting the provider.
          failure.beforeSubmit=name==='video_generate'&&args.config&&value.ok===false&&
            !existsSync(join(args.output_dir,'generate.json'))&&!existsSync(join(args.output_dir,'task.json'));
          finish(failure);return;
        }
        finish(null,value.result);
      });
      child.stdin.end(JSON.stringify({...args,action:name.slice(6)}));
    }catch{finish(Error('video_process_unavailable'));}
  });
}

export class VideoService {
  constructor({db,home,root=ROOT,tasks,events,credential=()=>process.env.ARK_API_KEY,transport,spawn,python,onReady,now=Date.now,pollMs=15000}={}){
    Object.assign(this,{db,home,root,tasks,events,credential,onReady,now,pollMs});
    this.transport=transport??createVideoTransport({root,spawn,python});this.inflight=new Map();this.controllers=new Set();this.closed=false;this.polling=null;
    this.schemas=new Map(JSON.parse(readFileSync(join(root,'tools/video/tool-definitions.json'),'utf8')).map(d=>[d.function.name,d.function.parameters]));
    db.exec(`CREATE TABLE IF NOT EXISTS task_video_action (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_video_remote (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_video_action_task ON task_video_action(json_extract(body,'$.taskId'),json_extract(body,'$.runId'));
      CREATE INDEX IF NOT EXISTS task_video_remote_task ON task_video_remote(json_extract(body,'$.taskId'));
      CREATE INDEX IF NOT EXISTS task_video_remote_follow ON task_video_remote(json_extract(body,'$.following'),json_extract(body,'$.nextPollAt'))`);
    for(const row of db.prepare("SELECT body FROM task_video_action WHERE json_extract(body,'$.status')='running'").all()){
      const action=JSON.parse(row.body);this.put('action',{...action,status:'settled',finishedAt:now(),result:{status:'unknown',error:'video_host_restarted_after_dispatch'}});
    }
    for(const row of db.prepare("SELECT body FROM task_video_remote WHERE json_extract(body,'$.remoteStatus')='submitting'").all()){
      const record=JSON.parse(row.body),disk=this.diskState(record.outputDir);
      const remoteTaskId=disk?.id??record.remoteTaskId;
      this.put('remote',{...record,remoteTaskId,remoteStatus:remoteTaskId?'submitted':'submission_not_confirmed',
        following:!!(remoteTaskId&&record.autoGenerate&&record.resumeIntent),updatedAt:now()});
    }
  }
  get(kind,id){const row=this.db.prepare(`SELECT body FROM task_video_${kind} WHERE id=?`).get(id);return row?JSON.parse(row.body):null;}
  put(kind,value){this.db.prepare(`INSERT INTO task_video_${kind} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(value.id,JSON.stringify(value));return value;}
  changed(taskId){this.events?.publish('task.updated',{id:taskId});}
  diskState(directory){try{const path=join(directory,'task.json');if(statSync(path).size>65536)return null;const value=readJson(path);return idOk(value?.id)?{id:value.id,status:value.status}:null;}catch{return null;}}
  binding(taskId,runId,{waiting=false}={}){
    if(this.closed)throw Error('video_service_closed');
    if(!idOk(taskId)||!idOk(runId))throw Error('invalid_video_binding');
    const task=this.tasks.row('task',taskId),run=this.tasks.row('run',runId),statuses=waiting?['running','waiting_event']:['running'];
    if(task.runId!==runId||run.taskId!==taskId||!statuses.includes(task.status)||!statuses.includes(run.status)||(task.assignmentVersion??1)!==(run.assignmentVersion??1)||task.closure?.status||task.managementReview)throw Error('video_actor_stale');
    if(!hasFullFilesystemAccess(task))throw Error('video_permission_denied');
    const skills=run.skills??run.employee?.skills??[],skill=skills.find(skill=>(typeof skill==='string'?skill:skill.name)==='video-production');
    if(!skill)throw Error('video_skill_required');
    // The root is selected from the host-owned Run snapshot, never tool arguments.
    // Trusted test adapters and legacy stubs may omit an archive; new Runs pin one.
    const toolRoot=skill.archiveRoot?verifySkillSnapshot(skill).archiveRoot:this.root;
    if(this.tasks.team&&(!this.tasks.team.profile(task.assignedBotId).enabled||task.assignedBotId!==this.tasks.team.chiefId&&!this.tasks.team.enabled()))throw Error('video_actor_disabled');
    const workspace=readJson(join(this.tasks.agentHome(task),'workspace.json'))?.path;
    if(!workspace)throw Error('task_workspace_not_ready');
    return {task,run,workspace:realpathSync(workspace),toolRoot};
  }
  normalize(name,input,binding){
    if(!VIDEO_TOOL_NAMES.includes(name)||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!argumentKeys[name].includes(k)))throw Error('invalid_video_arguments');
    if(Buffer.byteLength(JSON.stringify(input))>128000)throw Error('invalid_video_arguments');
    const catalog=binding.toolRoot===this.root?this.schemas:new Map(JSON.parse(readFileSync(join(binding.toolRoot,'tools/video/tool-definitions.json'),'utf8')).map(d=>[d.function.name,d.function.parameters]));
    if(!catalog.has(name))throw Error('video_schema_unavailable');
    const schema=copy(catalog.get(name));schema.required=(schema.required??[]).filter(k=>k!=='output_dir');validateSchema(input,schema);
    const args=copy(input),config={...binding.task,workspace:binding.workspace};
    const hasConfig=Object.hasOwn(args,'config')||Object.hasOwn(args,'config_path');
    if(name==='video_generate'&&(args.task_id&&hasConfig||!hasConfig&&!args.output_dir&&!args.task_id))throw Error('invalid_video_arguments');
    if(['video_validate','video_submit','video_edit'].includes(name)||name==='video_generate'&&hasConfig){
      if(Object.hasOwn(args,'config')===Object.hasOwn(args,'config_path'))throw Error('invalid_video_arguments');
      let frameBase=config;
      if(args.config_path){
        const path=realpathSync(resolveTaskPath(config,args.config_path));if(statSync(path).size>128000)throw Error('video_config_too_large');
        frameBase={...config,workspace:dirname(path)};
        const value=JSON.parse(readFileSync(path,'utf8'));validateSchema(value,schema.properties.config);args.config=value;delete args.config_path;
        for(const field of ['reference_images','reference_videos'])if(args.config[field])args.config[field]=args.config[field].map(p=>resolveTaskPath({...config,workspace:dirname(path)},p));
        if(args.config.clips)args.config.clips=args.config.clips.map(clip=>({...clip,path:resolveTaskPath({...config,workspace:dirname(path)},clip.path)}));
        if(args.config.output)args.config.output=resolveTaskPath({...config,workspace:dirname(path)},args.config.output);
      }else{
        for(const field of ['reference_images','reference_videos'])if(args.config[field])args.config[field]=args.config[field].map(p=>resolveTaskPath(config,p));
        if(args.config.clips)args.config.clips=args.config.clips.map(clip=>({...clip,path:resolveTaskPath(config,clip.path)}));
        if(args.config.output)args.config.output=resolveTaskPath(config,args.config.output);
      }
      if(name==='video_edit'&&schema.properties.config.properties.aesthetic_timeline){
        if(Object.hasOwn(args.config,'clips')===Object.hasOwn(args.config,'aesthetic_timeline'))throw Error('invalid_video_arguments');
        if(args.config.aesthetic_timeline){
          for(const field of ['template','before','after','wrap','tape','card'])
            args.config.aesthetic_timeline[field]=resolveTaskPath(frameBase,args.config.aesthetic_timeline[field]);
        }
      }
      if(name!=='video_edit'){
        const generationSchema=schema.properties.config;
        const skills=binding.run.skills??binding.run.employee?.skills??[];
        const aesthetic=skills.some(skill=>(typeof skill==='string'?skill:skill.name)==='aesthetic-video-workflow');
        if(aesthetic&&catalogModelRules(generationSchema,'minimax-h3-veda').length){
          if(!Object.hasOwn(args.config,'model'))args.config.model='doubao-seedance-2-0-fast-260128';
          if(!args.config.model?.trim())throw Error('invalid_video_arguments');
        }
        validateGenerationMode(args.config,generationSchema,catalog.has('video_generate'));
      }
      if(args.config.first_frame_path){
        if(args.config.first_frame_path.includes('://'))throw Error('invalid_video_arguments');
        args.config.first_frame_path=resolveTaskPath(frameBase,args.config.first_frame_path);
      }
    }
    if(args.output_dir)args.output_dir=canonicalPath(resolveTaskPath(config,args.output_dir));
    if((name==='video_submit'||name==='video_generate'&&hasConfig)&&!args.output_dir)args.output_dir=canonicalPath(join(binding.workspace,'output','video',hash(JSON.stringify(stable(args.config))).slice(0,16)));
    return args;
  }
  remoteFor(taskId,args){
    let records=this.db.prepare("SELECT body FROM task_video_remote WHERE json_extract(body,'$.taskId')=? ORDER BY rowid DESC").all(taskId).map(row=>JSON.parse(row.body));
    if(args.output_dir)records=records.filter(r=>r.outputDir===args.output_dir);
    if(args.task_id)records=records.filter(r=>r.remoteTaskId===args.task_id);
    if(records.length!==1)throw Error(records.length?'video_task_ambiguous':'video_task_not_owned');
    return records[0];
  }
  async key(name,provider){if(!remoteTools.has(name)||sparkModels.has(provider))return '';const value=await this.credential();if(typeof value!=='string'||!value.trim())throw Error('video_credentials_unavailable');return value;}
  async execute({taskId,runId,stepId,name,args={},signal}){
    if(!idOk(stepId))throw Error('invalid_video_action');
    const binding=this.binding(taskId,runId),normalized=this.normalize(name,args,binding),fingerprint=hash(JSON.stringify(stable({name,args}))),id='video-action-'+hash([taskId,runId,stepId].join('\0'));
    const pending=this.inflight.get(id);if(pending){if(pending.fingerprint!==fingerprint)throw Error('video_action_conflict');return pending.promise;}
    const old=this.get('action',id);if(old){if(old.fingerprint!==fingerprint)throw Error('video_action_conflict');return copy(old.result);}
    const input={id,taskId,runId,stepId,name,args:normalized,fingerprint,binding,signal};
    const promise=name==='video_generate'?this.generate(input):this.perform(input);this.inflight.set(id,{promise,fingerprint});
    try{return await promise;}finally{this.inflight.delete(id);}
  }
  generationReceipt(record,result){
    if(!idOk(result.task_id)||record.remoteTaskId&&record.remoteTaskId!==result.task_id)throw Error('video_response_task_mismatch');
    if(!pendingStates.has(result.status)&&!terminalStates.has(result.status))throw Error('video_response_status_invalid');
    delete result.timed_out;
    if(result.status==='succeeded'){
      if(result.path!==join(record.outputDir,record.filename)||!Number.isSafeInteger(result.size_bytes)||result.size_bytes<=0||!/^[a-f0-9]{64}$/.test(result.sha256??''))throw Error('video_artifact_invalid');
      result.artifacts=[{name:record.filename,path:result.path,size:result.size_bytes,sha256:result.sha256}];
    }
    return {...result,task_id:result.task_id,output_dir:record.outputDir,videoRecordId:record.id};
  }
  async generate({id,taskId,runId,stepId,name,args,fingerprint,binding,signal}){
    const configHash=args.config&&hash(JSON.stringify(stable(args.config)));
    const frameDigest=args.config&&await referenceDigest(args.config);
    const operationId=args.config?'video-'+hash(args.output_dir):this.remoteFor(taskId,args).id;
    const previous=this.get('remote',operationId);
    if(previous&&previous.taskId!==taskId)throw Error('video_task_not_owned');
    const provider=args.config?(sparkModels.has(args.config.model)?args.config.model:'ark'):previous.provider;
    const localReplay=previous?.autoGenerate&&previous.remoteStatus==='succeeded'&&previous.artifact?.sha256&&
      previous.artifact.path===join(previous.outputDir,previous.filename)&&existsSync(previous.artifact.path);
    const credential=localReplay?'':await this.key(name,provider);
    this.binding(taskId,runId);signal?.throwIfAborted();
    let record=this.get('remote',operationId);
    const fresh=!record,filename=args.filename??record?.filename??'video.mp4';
    if(filename!==basename(filename)||!filename.endsWith('.mp4'))throw Error('invalid_video_arguments');
    if(record){
      if(record.taskId!==taskId)throw Error('video_task_not_owned');
      if((record.provider??'ark')!==(provider??'ark'))throw Error('video_output_provider_mismatch');
      if(configHash&&(configHash!==record.configHash||frameDigest!==(record.referenceDigest??null))||record.filename&&filename!==record.filename)throw Error('video_output_config_conflict');
      if(!idOk(record.remoteTaskId))throw Error('video_submission_not_confirmed');
    }else{
      if(existsSync(join(args.output_dir,'task.json')))throw Error('video_directory_has_existing_task');
      record={id:operationId,taskId,provider,configHash,referenceDigest:frameDigest,model:args.config.model,outputDir:args.output_dir,remoteStatus:'submitting',createdAt:this.now()};
    }
    const pollMs=args.poll_seconds===undefined?this.pollMs:args.poll_seconds*1000;
    const shouldFollow=args.timeout_seconds!==0;
    Object.assign(record,{runId,assignmentVersion:binding.task.assignmentVersion??1,autoGenerate:true,generationActionId:id,filename,
      pollMs,followUntil:this.now()+(args.timeout_seconds??900)*1000,nextPollAt:this.now()+pollMs,waitingTimedOut:false,
      deliveredAt:null,stoppedAt:null,following:false,resumeIntent:shouldFollow,updatedAt:this.now()});
    this.put('remote',record);
    const action={id,taskId,runId,stepId,name,fingerprint,assignmentVersion:record.assignmentVersion,status:'running',createdAt:this.now()};
    this.put('action',action);
    const controller=new AbortController(),combined=AbortSignal.any([controller.signal,...signal?[signal]:[]]);
    this.controllers.add(controller);
    const watch=setInterval(()=>{try{this.binding(taskId,runId);}catch(error){controller.abort(error);}},100);watch.unref();
    let result,beforeSubmit=false;
    try{
      const callArgs={output_dir:record.outputDir,filename,timeout_seconds:0,...fresh?{config:args.config}:{task_id:record.remoteTaskId}};
      const raw=await this.transport({name,args:callArgs,workspace:binding.workspace,toolRoot:binding.toolRoot,credential,signal:combined});
      result=this.generationReceipt(record,safeResult(raw,credential));
      record.remoteTaskId=result.task_id;record.remoteStatus=result.status;record.lastError=result.error??null;
      if(result.artifacts)record.artifact=result.artifacts[0];
    }catch(error){
      const remoteId=record.remoteTaskId??this.diskState(record.outputDir)?.id;
      const message=safeResult({error:error.message},credential).error;
      beforeSubmit=fresh&&!remoteId&&error.beforeSubmit===true;
      record.remoteTaskId=remoteId;
      record.lastError=message;
      if(beforeSubmit){
        result={status:'failed',error:message};
      }else{
        // A verified local replay only reads the saved receipt and file. A broken
        // copy cannot become successful by repeatedly polling the upstream task.
        record.remoteStatus=localReplay?'failed':remoteId?'running':'submission_not_confirmed';
        if(localReplay)delete record.artifact;
        result={status:localReplay?'failed':remoteId?'running':'unknown',output_dir:record.outputDir,videoRecordId:record.id};
        if(remoteId)result.task_id=remoteId;
        if(!remoteId||localReplay)result.error=message;
      }
    }finally{clearInterval(watch);this.controllers.delete(controller);}
    if(shouldFollow&&pendingStates.has(record.remoteStatus)&&!combined.aborted){
      try{this.binding(taskId,runId);record.following=true;result.waitingForVideo=true;}catch{record.stoppedAt=this.now();}
      if(result.error){record.lastError=result.error;delete result.error;}
    }
    if(beforeSubmit)this.db.prepare('DELETE FROM task_video_remote WHERE id=?').run(record.id);
    else this.put('remote',record);
    this.put('action',{...action,status:'settled',result,finishedAt:this.now()});
    this.changed(taskId);
    return copy(result);
  }
  async perform({id,taskId,runId,stepId,name,args,fingerprint,binding,signal}){
    let remote=remoteTools.has(name)&&name!=='video_submit'?this.remoteFor(taskId,args):null;
    const provider=name==='video_submit'?(sparkModels.has(args.config.model)?args.config.model:'ark'):remote?.provider;
    const key=await this.key(name,provider);this.binding(taskId,runId);signal?.throwIfAborted();
    if(name==='video_submit'){
      const directoryKey=hash(args.output_dir),stored=this.get('remote','video-'+directoryKey);
      if(stored){
        if(stored.taskId!==taskId)throw Error('video_task_not_owned');
        if((stored.provider??'ark')!==provider)throw Error('video_output_provider_mismatch');
        return {status:stored.remoteStatus,task_id:stored.remoteTaskId,output_dir:stored.outputDir,videoRecordId:stored.id,alreadySubmitted:true};
      }
      if(existsSync(join(args.output_dir,'task.json')))throw Error('video_directory_has_existing_task');
      remote={id:'video-'+directoryKey,taskId,runId,provider,configHash:hash(JSON.stringify(stable(args.config))),...(args.config.model?{model:args.config.model}:{}),assignmentVersion:binding.task.assignmentVersion??1,outputDir:args.output_dir,remoteStatus:'submitting',following:false,createdAt:this.now(),updatedAt:this.now()};this.put('remote',remote);
    }else if(remote){
      if(!remote.remoteTaskId)throw Error('video_submission_not_confirmed');
      args={...args,output_dir:remote.outputDir,task_id:remote.remoteTaskId};
    }
    const controller=new AbortController(),combined=AbortSignal.any([controller.signal,...signal?[signal]:[]]);this.controllers.add(controller);
    const action={id,taskId,runId,stepId,assignmentVersion:binding.task.assignmentVersion??1,name,fingerprint,status:'running',createdAt:this.now()};this.put('action',action);
    const watch=setInterval(()=>{try{this.binding(taskId,runId);}catch(error){controller.abort(error);}},100);watch.unref();
    let result;
    try{
      const callName=name==='video_wait'?'video_status':name,callArgs=name==='video_wait'?{output_dir:remote.outputDir,task_id:remote.remoteTaskId}:args;
      result=safeResult(await this.transport({name:callName,args:callArgs,workspace:binding.workspace,toolRoot:binding.toolRoot,credential:key,signal:combined}),key);
      if(remote){
        if(name==='video_submit'&&!idOk(result.task_id))throw Error('video_submission_not_confirmed');
        if(result.task_id&&remote.remoteTaskId&&result.task_id!==remote.remoteTaskId)throw Error('video_response_task_mismatch');
        remote={...remote,remoteTaskId:result.task_id??remote.remoteTaskId,remoteStatus:result.status??'unknown',updatedAt:this.now(),...result.path?{artifact:{name:basename(result.path),path:result.path,size:result.size_bytes}}:{}};
        if(name==='video_wait'&&pendingStates.has(remote.remoteStatus)){
          const pollMs=args.poll_seconds===undefined?this.pollMs:args.poll_seconds*1000;
          this.binding(taskId,runId);remote={...remote,runId,assignmentVersion:binding.task.assignmentVersion??1,following:true,resumeIntent:true,waitingTimedOut:false,stoppedAt:null,deliveredAt:null,pollMs,followUntil:this.now()+(args.timeout_seconds??60)*1000,nextPollAt:this.now()+pollMs};
          result={...result,waitingForVideo:true,videoRecordId:remote.id};
        }
        this.put('remote',remote);result={...result,output_dir:remote.outputDir,videoRecordId:remote.id};
      }
      if(result.path)result.artifacts=[{name:basename(result.path),path:result.path,size:result.size_bytes}];
    }catch(error){
      result={status:name==='video_submit'?'unknown':combined.aborted?'cancelled':'failed',error:String(error.message).replaceAll(key||'\0','[redacted]').replace(/https?:\/\/[^\s"<>]+/g,'[remote URL]').slice(0,500)};
      if(remote&&name==='video_submit'){
        const disk=this.diskState(remote.outputDir);remote={...remote,remoteTaskId:disk?.id,remoteStatus:disk?.id?'submitted':'submission_not_confirmed',updatedAt:this.now()};this.put('remote',remote);
        Object.assign(result,{videoRecordId:remote.id,output_dir:remote.outputDir,...disk?.id?{task_id:disk.id}: {}});
      }
    }finally{clearInterval(watch);this.controllers.delete(controller);}
    this.put('action',{...action,status:'settled',result,finishedAt:this.now()});this.changed(taskId);return copy(result);
  }
  /** Returns task-local records and receipts, excluding prompts and credentials. */
  view(taskId){
    if(!idOk(taskId))throw Error('invalid_video_binding');
    const records=this.db.prepare("SELECT body FROM task_video_remote WHERE json_extract(body,'$.taskId')=? ORDER BY rowid DESC LIMIT 100").all(taskId).map(row=>JSON.parse(row.body));
    return {records:records.map(r=>({...r,localStatus:r.following?'following':r.deliveredAt?'delivered':r.stoppedAt?'stopped':'idle'})),artifacts:this.artifacts(taskId)};
  }
  async preview(taskId,recordId){
    if(!idOk(taskId)||!idOk(recordId))throw Error('invalid_video_binding');
    const record=this.get('remote',recordId);
    if(!record||record.taskId!==taskId)throw Error('video_task_not_owned');
    const artifact=record.artifact;
    if(!record.autoGenerate||record.remoteStatus!=='succeeded'||!artifact?.sha256||artifact.path!==join(record.outputDir,record.filename))throw Error('video_preview_unavailable');
    return {bytes:await readPreviewBytes(artifact,'video_artifact_changed'),contentType:'video/mp4'};
  }
  // A continuation may report the file delivered by the immediately preceding video event.
  generationActionForEvent(taskId,runId){
    if(!runId)return null;
    const run=this.tasks.row('run',runId),event=run.eventContext;
    if(run.taskId!==taskId||event?.kind!=='video'||!event.recordId)return null;
    const remote=this.get('remote',event.recordId);
    if(!remote?.autoGenerate||!remote.artifact||remote.taskId!==taskId||remote.runId!==run.instructionSource?.previousRunId||remote.assignmentVersion!==(run.assignmentVersion??1))return null;
    const action=this.get('action',remote.generationActionId);
    return action?.result?.status==='succeeded'&&action.result.path===remote.artifact.path?action:null;
  }
  evidence(taskId,runId){
    const rows=this.db.prepare("SELECT body FROM task_video_action WHERE json_extract(body,'$.taskId')=? AND json_extract(body,'$.runId')=? ORDER BY rowid LIMIT 100").all(taskId,runId);
    const actions=rows.map(row=>JSON.parse(row.body)),delivered=this.generationActionForEvent(taskId,runId);
    if(delivered)actions.push(delivered);
    return actions.map(a=>({id:a.id,stepId:a.stepId,tool:a.name,status:a.result?.status??a.status,result:a.result,createdAt:a.createdAt,finishedAt:a.finishedAt}));
  }
  artifacts(taskId,runId){
    const rows=this.db.prepare("SELECT body FROM task_video_action WHERE json_extract(body,'$.taskId')=? AND (? IS NULL OR json_extract(body,'$.runId')=?) ORDER BY rowid DESC LIMIT 100").all(taskId,runId??null,runId??null);
    const artifacts=rows.flatMap(row=>JSON.parse(row.body).result?.artifacts??[]);
    artifacts.push(...this.generationActionForEvent(taskId,runId)?.result.artifacts??[]);
    return [...new Map(artifacts.map(artifact=>[artifact.path,artifact])).values()];
  }
  stop(taskId){for(const {body} of this.db.prepare("SELECT body FROM task_video_remote WHERE json_extract(body,'$.taskId')=? AND json_extract(body,'$.following')=1").all(taskId)){const r=JSON.parse(body);this.put('remote',{...r,following:false,stoppedAt:this.now(),updatedAt:this.now()});}this.changed(taskId);return this.view(taskId);}
  tick(){if(this.closed)return Promise.resolve();return this.polling??=(this.poll().finally(()=>{this.polling=null;}));}
  async poll(){
    const rows=this.db.prepare("SELECT body FROM task_video_remote WHERE json_extract(body,'$.following')=1 AND coalesce(json_extract(body,'$.nextPollAt'),0)<=? ORDER BY coalesce(json_extract(body,'$.nextPollAt'),0),id LIMIT 4").all(this.now());
    for(const {body} of rows){
      if(this.closed)return;let record=JSON.parse(body);
      const task=this.tasks.row('task',record.taskId);
      if(task.closure?.status||['paused','cancelled','cancelling','pausing'].includes(task.status)||task.automationPaused){this.stop(record.taskId);continue;}
      try{
        if((!terminalStates.has(record.remoteStatus)||record.autoGenerate&&record.remoteStatus==='succeeded'&&!record.artifact?.sha256)&&!record.waitingTimedOut){
          const binding=this.binding(record.taskId,record.runId,{waiting:true});
          if(binding.task.status!=='waiting_event'){this.put('remote',{...record,nextPollAt:this.now()+(record.pollMs??this.pollMs)});continue;}
          if(record.followUntil&&this.now()>=record.followUntil){
            record={...record,waitingTimedOut:true,updatedAt:this.now()};
            if(record.autoGenerate){
              const action=this.get('action',record.generationActionId);
              const result={status:record.remoteStatus,timed_out:true,task_id:record.remoteTaskId,output_dir:record.outputDir,videoRecordId:record.id};
              if(action)this.put('action',{...action,result,status:'settled',finishedAt:this.now()});
            }
          }else{
            const key=await this.key('video_status',record.provider),controller=new AbortController();this.controllers.add(controller);
            const name=record.autoGenerate?'video_generate':'video_status';
            const args={output_dir:record.outputDir,task_id:record.remoteTaskId,...record.autoGenerate?{filename:record.filename,timeout_seconds:0}:{}};
            let result;try{result=safeResult(await this.transport({name,args,workspace:binding.workspace,toolRoot:binding.toolRoot,credential:key,signal:controller.signal}),key);}finally{this.controllers.delete(controller);}
            if(result.task_id&&result.task_id!==record.remoteTaskId)throw Error('video_response_task_mismatch');
            if(record.autoGenerate){
              result=this.generationReceipt(record,result);
              if(result.artifacts)record.artifact=result.artifacts[0];
              if(terminalStates.has(result.status)){
                const action=this.get('action',record.generationActionId);
                if(action)this.put('action',{...action,result,status:'settled',finishedAt:this.now()});
              }
            }
            record={...record,remoteStatus:result.status??'unknown',lastError:result.error??null,updatedAt:this.now()};
          }
        }
        const current=this.get('remote',record.id);
        record={...record,...current?.following===false?{following:false,stoppedAt:current.stoppedAt,deliveredAt:current.deliveredAt}:{},nextPollAt:this.now()+(record.pollMs??this.pollMs)};this.put('remote',record);this.changed(record.taskId);
        if(!record.following)continue;
        if((terminalStates.has(record.remoteStatus)||record.waitingTimedOut)&&record.resumeIntent&&this.onReady){
          const delivered=await this.onReady(copy(record));
          if(delivered===true||delivered?.delivered===true)this.put('remote',{...record,following:false,deliveredAt:this.now(),updatedAt:this.now()});
        }
      }catch(error){const current=this.get('remote',record.id);this.put('remote',{...record,...current?.following===false?{following:false,stoppedAt:current.stoppedAt,deliveredAt:current.deliveredAt}:{},nextPollAt:this.now()+this.pollMs,lastError:/credential/.test(error.message)?'video_credentials_unavailable':'video_followup_retry',updatedAt:this.now()});}
    }
  }
  async close(){this.closed=true;for(const controller of this.controllers)controller.abort(Error('video_service_closed'));await Promise.allSettled([...this.inflight.values()].map(v=>v.promise).concat(this.polling?[this.polling]:[]));}
}
