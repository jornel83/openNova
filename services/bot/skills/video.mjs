/** Task-bound video tools and resumable remote jobs. Python owns media work. */
import {createHash} from 'node:crypto';
import {spawn as nodeSpawn} from 'node:child_process';
import {readFileSync,existsSync,realpathSync,statSync} from 'node:fs';
import {dirname,join,basename} from 'node:path';
import {ROOT} from '../../runtime/sources.mjs';
import {readJson} from '../tasks/agent-files.mjs';
import {resolveTaskPath,hasFullFilesystemAccess} from '../tasks/filesystem.mjs';
import {verifySkillSnapshot} from './bundle.mjs';

export const VIDEO_TOOL_NAMES=['video_validate','video_submit','video_status','video_wait','video_download','video_edit'];
const remoteTools=new Set(['video_submit','video_status','video_wait','video_download']);
const pendingStates=new Set(['submitted','queued','pending','running','processing']);
const terminalStates=new Set(['succeeded','failed','expired','cancelled']);
const idOk=value=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const copy=value=>JSON.parse(JSON.stringify(value));
const argumentKeys={video_validate:['config','config_path'],video_submit:['config','config_path','output_dir'],video_status:['task_id','output_dir'],video_wait:['task_id','output_dir','poll_seconds','timeout_seconds'],video_download:['task_id','output_dir','filename'],video_edit:['config','config_path','dry_run']};
const allowedResultKeys=new Set(['status','task_id','output_dir','path','size_bytes','metadata','settings','reference_count','video_reference_count','plan','timed_out','error']);
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
        if(code!==0||value.ok!==true){finish(Error(String(value.error||'video_tool_failed').replaceAll(credential||'\0','[redacted]').replace(/https?:\/\/[^\s"<>]+/g,'[remote URL]').slice(0,500)));return;}
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
      this.put('remote',{...record,remoteTaskId:disk?.id??record.remoteTaskId,remoteStatus:disk?.id?'submitted':'submission_not_confirmed',updatedAt:now()});
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
    const schema=binding.toolRoot===this.root?copy(this.schemas.get(name)):JSON.parse(readFileSync(join(binding.toolRoot,'tools/video/tool-definitions.json'),'utf8')).find(d=>d.function.name===name)?.function.parameters;
    if(!schema)throw Error('video_schema_unavailable');schema.required=(schema.required??[]).filter(k=>k!=='output_dir');validateSchema(input,schema);
    const args=copy(input),config={...binding.task,workspace:binding.workspace};
    if(['video_validate','video_submit','video_edit'].includes(name)){
      if(Object.hasOwn(args,'config')===Object.hasOwn(args,'config_path'))throw Error('invalid_video_arguments');
      if(args.config_path){
        const path=realpathSync(resolveTaskPath(config,args.config_path));if(statSync(path).size>128000)throw Error('video_config_too_large');
        const value=JSON.parse(readFileSync(path,'utf8'));validateSchema(value,schema.properties.config);args.config=value;delete args.config_path;
        for(const field of ['reference_images','reference_videos'])if(args.config[field])args.config[field]=args.config[field].map(p=>resolveTaskPath({...config,workspace:dirname(path)},p));
        if(args.config.clips)args.config.clips=args.config.clips.map(clip=>({...clip,path:resolveTaskPath({...config,workspace:dirname(path)},clip.path)}));
        if(args.config.output)args.config.output=resolveTaskPath({...config,workspace:dirname(path)},args.config.output);
      }else{
        for(const field of ['reference_images','reference_videos'])if(args.config[field])args.config[field]=args.config[field].map(p=>resolveTaskPath(config,p));
        if(args.config.clips)args.config.clips=args.config.clips.map(clip=>({...clip,path:resolveTaskPath(config,clip.path)}));
        if(args.config.output)args.config.output=resolveTaskPath(config,args.config.output);
      }
    }
    if(args.output_dir)args.output_dir=canonicalPath(resolveTaskPath(config,args.output_dir));
    if(name==='video_submit'&&!args.output_dir)args.output_dir=canonicalPath(join(binding.workspace,'output','video',hash(JSON.stringify(stable(args.config))).slice(0,16)));
    return args;
  }
  remoteFor(taskId,args){
    let records=this.db.prepare("SELECT body FROM task_video_remote WHERE json_extract(body,'$.taskId')=? ORDER BY rowid DESC").all(taskId).map(row=>JSON.parse(row.body));
    if(args.output_dir)records=records.filter(r=>r.outputDir===args.output_dir);
    if(args.task_id)records=records.filter(r=>r.remoteTaskId===args.task_id);
    if(records.length!==1)throw Error(records.length?'video_task_ambiguous':'video_task_not_owned');
    return records[0];
  }
  async key(name){if(!remoteTools.has(name))return '';const value=await this.credential();if(typeof value!=='string'||!value.trim())throw Error('video_credentials_unavailable');return value;}
  async execute({taskId,runId,stepId,name,args={},signal}){
    if(!idOk(stepId))throw Error('invalid_video_action');
    const binding=this.binding(taskId,runId),normalized=this.normalize(name,args,binding),fingerprint=hash(JSON.stringify(stable({name,args}))),id='video-action-'+hash([taskId,runId,stepId].join('\0'));
    const pending=this.inflight.get(id);if(pending){if(pending.fingerprint!==fingerprint)throw Error('video_action_conflict');return pending.promise;}
    const old=this.get('action',id);if(old){if(old.fingerprint!==fingerprint)throw Error('video_action_conflict');return copy(old.result);}
    const promise=this.perform({id,taskId,runId,stepId,name,args:normalized,fingerprint,binding,signal});this.inflight.set(id,{promise,fingerprint});
    try{return await promise;}finally{this.inflight.delete(id);}
  }
  async perform({id,taskId,runId,stepId,name,args,fingerprint,binding,signal}){
    const key=await this.key(name);this.binding(taskId,runId);signal?.throwIfAborted();
    let remote;
    if(name==='video_submit'){
      const directoryKey=hash(args.output_dir),stored=this.get('remote','video-'+directoryKey);
      if(stored){if(stored.taskId!==taskId)throw Error('video_task_not_owned');return {status:stored.remoteStatus,task_id:stored.remoteTaskId,output_dir:stored.outputDir,videoRecordId:stored.id,alreadySubmitted:true};}
      if(existsSync(join(args.output_dir,'task.json')))throw Error('video_directory_has_existing_task');
      remote={id:'video-'+directoryKey,taskId,runId,assignmentVersion:binding.task.assignmentVersion??1,outputDir:args.output_dir,remoteStatus:'submitting',following:false,createdAt:this.now(),updatedAt:this.now()};this.put('remote',remote);
    }else if(remoteTools.has(name)){
      remote=this.remoteFor(taskId,args);if(!remote.remoteTaskId)throw Error('video_submission_not_confirmed');
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
  evidence(taskId,runId){return this.db.prepare("SELECT body FROM task_video_action WHERE json_extract(body,'$.taskId')=? AND json_extract(body,'$.runId')=? ORDER BY rowid LIMIT 100").all(taskId,runId).map(row=>{const a=JSON.parse(row.body);return {id:a.id,stepId:a.stepId,tool:a.name,status:a.result?.status??a.status,result:a.result,createdAt:a.createdAt,finishedAt:a.finishedAt};});}
  artifacts(taskId,runId){
    const rows=this.db.prepare("SELECT body FROM task_video_action WHERE json_extract(body,'$.taskId')=? AND (? IS NULL OR json_extract(body,'$.runId')=?) ORDER BY rowid DESC LIMIT 100").all(taskId,runId??null,runId??null);
    return [...new Map(rows.flatMap(row=>JSON.parse(row.body).result?.artifacts??[]).map(artifact=>[artifact.path,artifact])).values()];
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
        if(!terminalStates.has(record.remoteStatus)&&!record.waitingTimedOut){
          const binding=this.binding(record.taskId,record.runId,{waiting:true});
          if(binding.task.status!=='waiting_event'){this.put('remote',{...record,nextPollAt:this.now()+(record.pollMs??this.pollMs)});continue;}
          if(record.followUntil&&this.now()>=record.followUntil)record={...record,waitingTimedOut:true,updatedAt:this.now()};
          else{
            const key=await this.key('video_status'),controller=new AbortController();this.controllers.add(controller);
            let result;try{result=safeResult(await this.transport({name:'video_status',args:{output_dir:record.outputDir,task_id:record.remoteTaskId},workspace:binding.workspace,toolRoot:binding.toolRoot,credential:key,signal:controller.signal}),key);}finally{this.controllers.delete(controller);}
            if(result.task_id&&result.task_id!==record.remoteTaskId)throw Error('video_response_task_mismatch');
            record={...record,remoteStatus:result.status??'unknown',lastError:null,updatedAt:this.now()};
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
