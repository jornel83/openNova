/** Project metadata only: source bodies and task execution stay with their owners. */
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,realpathSync,statSync} from 'node:fs';
import {basename,extname,isAbsolute,join,resolve} from 'node:path';
import {nativeFileMime} from '../desktop/file-types.mjs';

export const DEFAULT_PROJECT_ID='project-opennova';
const ident=value=>typeof value==='string'&&/^[\w-]{1,128}$/.test(value);
const clone=value=>JSON.parse(JSON.stringify(value));
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,stable(value[key])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const clip=(value,max)=>typeof value==='string'?value.slice(0,max):'';
const has=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const text=(value,max,error,{empty=false}={})=>{
  if(typeof value!=='string'||value.length>max||value.includes('\0')||!empty&&!value.trim())throw Error(error);
  return value.trim();
};
const textExtensions=new Set(['.md','.txt','.json','.jsonl','.yaml','.yml','.toml','.ini','.cfg','.csv','.tsv','.js','.mjs','.cjs','.jsx','.ts','.tsx','.py','.sh','.zsh','.html','.css','.scss','.xml','.sql','.rs','.go','.java','.c','.h','.cpp','.vue','.svelte','.log']);
const referenceKinds=new Set(['file','directory','url','selection','artifact']);
const recordGroups={decision:'decisions',option:'options',question:'questions',next_step:'nextSteps'};
const recordTypes=new Set(Object.keys(recordGroups));
const tableNames=new Set(['opennova_project','opennova_project_state','opennova_project_reference','opennova_project_record']);
function fields(input,allowed,error='invalid_project_action'){
  if(!plain(input)||Object.keys(input).some(key=>!allowed.includes(key)))throw Error(error);
}
function metadata(value,error){
  if(value===undefined)return undefined;
  if(!plain(value)||JSON.stringify(value).length>4096)throw Error(error);
  return clone(value);
}
function absolutePath(path){return text(path,4096,'invalid_project_path')&&isAbsolute(path)?resolve(path):(()=>{throw Error('invalid_project_path');})();}
function directory(path){
  if(path===null||path==='')return null;
  const full=absolutePath(path);
  try{if(!statSync(full).isDirectory())throw Error();return realpathSync(full);}catch{throw Error('invalid_project_directory');}
}
function url(raw){
  try{const value=new URL(text(raw,8192,'invalid_project_url'));if(!['https:','http:'].includes(value.protocol)||value.username||value.password)throw Error();return value.href;}catch{throw Error('invalid_project_url');}
}
function diskVersion(path,kind){
  try{
    const stat=statSync(path),valid=kind==='directory'?stat.isDirectory():stat.isFile();
    if(!valid)return {availability:'invalid',version:null};
    const value={path:realpathSync(path),size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs,ino:stat.ino};
    return {availability:'available',version:{...value,fingerprint:hash(value)}};
  }catch(error){return {availability:error.code==='ENOENT'||error.code==='ENOTDIR'?'missing':'invalid',version:null};}
}

function contextRecord({id,type,text,sourceRequestId,source,revision,supersedes}){
  return {id,type,text:clip(text,700),textTruncated:text.length>700,sourceRequestId,source:{kind:source.kind,taskId:source.taskId,reportId:source.reportId},revision,supersedes};
}
function fitContext(result,maxChars,requestId){
  const {summary,references}=result;
  const arrays=[summary.reports,summary.options,references,summary.tasks,summary.nextSteps,summary.questions,summary.decisions];
  // Each group is newest first. Evict older background before a choice or
  // other record the user has just asked this worker to act on.
  const priority=group=>{
    if(!requestId||group.at(-1).sourceRequestId!==requestId)return 0;
    return group===summary.decisions?2:1;
  };
  while(JSON.stringify(result).length>maxChars){
    const candidates=arrays.filter(group=>group.length);
    if(!candidates.length)break;
    candidates.sort((a,b)=>priority(a)-priority(b)||JSON.stringify(b).length-JSON.stringify(a).length);
    candidates[0].pop();result.truncated=true;
  }
  if(JSON.stringify(result).length>maxChars){delete result.project.directory;delete result.project.workspace;result.omittedFields=['project.directory','project.workspace'];result.truncated=true;}
  return result;
}

export class ProjectStore {
  constructor({ops,home,workspace,events,now=Date.now}){
    if(!ops?.db)throw Error('project_database_required');
    Object.assign(this,{ops,db:ops.db,home:resolve(home),workspace:directory(workspace),events,now,sequence:0});
    this.db.exec(`CREATE TABLE IF NOT EXISTS opennova_project (id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS opennova_project_state (id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS opennova_project_reference (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS opennova_project_reference_scope ON opennova_project_reference(project_id,status);
      CREATE TABLE IF NOT EXISTS opennova_project_record (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS opennova_project_record_scope ON opennova_project_record(project_id,status);
      CREATE INDEX IF NOT EXISTS opennova_project_record_type ON opennova_project_record(project_id,status,json_extract(body,'$.type'),json_extract(body,'$.updatedAt') DESC);
      CREATE TABLE IF NOT EXISTS opennova_project_history (entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(entity_type,entity_id,revision));
      CREATE TABLE IF NOT EXISTS opennova_project_action (id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS opennova_record_actions_by_request ON opennova_project_action(json_extract(body,'$.sourceRequestId'))
        WHERE json_type(body,'$.type') IS NOT NULL`);
    this.transaction(()=>{
      if(!this.row('opennova_project',DEFAULT_PROJECT_ID))this.put('opennova_project',{id:DEFAULT_PROJECT_ID,name:'OpenNova',goal:'',directory:this.workspace,legacyWorkspace:this.workspace,workspace:this.workspace,managedWorkspace:false,status:'active',revision:1,createdAt:now(),updatedAt:now()});
      if(!this.row('opennova_project_state','selection'))this.put('opennova_project_state',{id:'selection',projectId:DEFAULT_PROJECT_ID,focus:'work',revision:1,updatedAt:now()});
    });
    this.migrateLegacy();
  }
  row(table,id){if(!tableNames.has(table))throw Error('invalid_project_table');const row=this.db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(id);return row?JSON.parse(row.body):null;}
  put(table,value){
    if(!tableNames.has(table))throw Error('invalid_project_table');
    if(['opennova_project_reference','opennova_project_record'].includes(table))this.db.prepare(`INSERT INTO ${table} (id,project_id,status,body) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,status=excluded.status,body=excluded.body`).run(value.id,value.projectId,value.status,JSON.stringify(value));
    else this.db.prepare(`INSERT INTO ${table} (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(value.id,JSON.stringify(value));
    return value;
  }
  transaction(fn){
    const point='project_'+(++this.sequence);this.db.exec('SAVEPOINT '+point);
    try{const result=fn();this.db.exec('RELEASE '+point);return result;}
    catch(error){this.db.exec('ROLLBACK TO '+point);this.db.exec('RELEASE '+point);throw error;}
  }
  remember(type,value){this.db.prepare('INSERT OR IGNORE INTO opennova_project_history VALUES (?,?,?,?)').run(type,value.id,value.revision,JSON.stringify(value));}
  history(type,id){
    if(!['project','reference','record'].includes(type)||!ident(id))throw Error('invalid_project_history');
    return this.db.prepare('SELECT body FROM opennova_project_history WHERE entity_type=? AND entity_id=? ORDER BY revision DESC').all(type,id).map(row=>JSON.parse(row.body));
  }
  changed(result){this.events?.publish('projects.updated',{state:this.state(),projectId:result.projectId??result.id??null,revision:result.revision});}
  action(kind,input,fn){
    if(!ident(input?.actionId))throw Error('invalid_project_action_id');
    const signature=hash({kind,input}),existing=this.db.prepare('SELECT fingerprint,body FROM opennova_project_action WHERE id=?').get(input.actionId);
    if(existing){if(existing.fingerprint!==signature)throw Error('project_action_conflict');return {...this.view(),result:JSON.parse(existing.body),replayed:true};}
    const result=this.transaction(()=>{
      const value=fn();this.db.prepare('INSERT INTO opennova_project_action VALUES (?,?,?)').run(input.actionId,signature,JSON.stringify(value));return value;
    });
    this.changed(result);return {...this.view(),result:clone(result)};
  }
  get(id){if(!ident(id))throw Error('unknown_project');const project=this.row('opennova_project',id);if(!project)throw Error('unknown_project');return project;}
  active(id){const project=this.get(id);if(project.status!=='active')throw Error('project_archived');return project;}
  expected(id,revision,{archived=false}={}){
    const project=archived?this.get(id):this.active(id);
    if(!Number.isSafeInteger(revision)||project.revision!==revision)throw Error('project_changed');return project;
  }
  list({includeArchived=true}={}){return this.db.prepare('SELECT body FROM opennova_project ORDER BY rowid').all().map(row=>JSON.parse(row.body)).filter(p=>includeArchived||p.status==='active');}
  state(){const {id,updatedAt,...state}=this.row('opennova_project_state','selection');return state;}
  view(){return {state:this.state(),projects:this.list()};}
  touch(project){this.remember('project',project);return this.put('opennova_project',{...project,revision:project.revision+1,updatedAt:this.now()});}
  /** Prepare the frontend session first; commit this selection only after that succeeds. */
  select(input){
    fields(input,['actionId','projectId','focus','revision']);
    return this.action('select',input,()=>{
      const current=this.state();if(input.revision!==current.revision)throw Error('project_state_changed');
      if(!['work','daily'].includes(input.focus))throw Error('invalid_project_focus');
      const projectId=input.projectId===undefined?current.projectId:input.projectId;
      if(input.focus==='work')this.active(projectId);else if(projectId!==null)this.get(projectId);
      return this.put('opennova_project_state',{id:'selection',projectId,focus:input.focus,revision:current.revision+1,updatedAt:this.now()});
    });
  }
  mutate(input){
    fields(input,['action','actionId','projectId','revision','name','goal','directory']);
    if(!['create','update','archive','restore'].includes(input.action))throw Error('invalid_project_action');
    return this.action('project',input,()=>{
      if(input.action==='create'){
        if(input.projectId!==undefined||input.revision!==undefined&&input.revision!==0)throw Error('invalid_project_action');
        const id='project-'+randomUUID(),name=text(input.name,160,'invalid_project_name'),goal=text(input.goal??'',2000,'invalid_project_goal',{empty:true}),external=directory(input.directory??null),workspace=external??join(this.home,'projects',id,'workspace');
        if(!external)mkdirSync(workspace,{recursive:true,mode:0o700});
        return this.put('opennova_project',{id,name,goal,directory:external,workspace,managedWorkspace:external===null,status:'active',revision:1,createdAt:this.now(),updatedAt:this.now()});
      }
      const project=this.expected(input.projectId,input.revision,{archived:true});
      if(input.action==='update'&&project.status!=='active')throw Error('project_archived');
      if(input.action==='archive'&&project.status!=='active'||input.action==='restore'&&project.status!=='archived')throw Error('invalid_project_status');
      let next={...project};
      if(input.action==='update'){
        if(has(input,'name'))next.name=text(input.name,160,'invalid_project_name');
        if(has(input,'goal'))next.goal=text(input.goal,2000,'invalid_project_goal',{empty:true});
        if(has(input,'directory')){
          next.directory=directory(input.directory);next.managedWorkspace=next.directory===null;next.workspace=next.directory??join(this.home,'projects',project.id,'workspace');
          if(next.managedWorkspace)mkdirSync(next.workspace,{recursive:true,mode:0o700});
          const selected=this.state();
          if(next.workspace!==project.workspace&&selected.projectId===project.id)this.put('opennova_project_state',{id:'selection',...selected,revision:selected.revision+1,updatedAt:this.now()});
        }
      }else{
        if(['name','goal','directory'].some(key=>has(input,key)))throw Error('invalid_project_action');
        next.status=input.action==='archive'?'archived':'active';
        if(next.status==='archived'){
          next.archivedAt=this.now();const selected=this.state();
          if(selected.projectId===project.id&&selected.focus==='work')this.put('opennova_project_state',{id:'selection',...selected,focus:'daily',revision:selected.revision+1,updatedAt:this.now()});
        }else next.archivedAt=null;
      }
      this.remember('project',project);return this.put('opennova_project',{...next,revision:project.revision+1,updatedAt:this.now()});
    });
  }
  observed(reference){
    // Capability is runtime metadata, including for references saved before A2.
    // Updating it never marks content read or rewrites the user's stored version.
    if(reference.kind==='file'&&reference.path)reference={...reference,readCapability:textExtensions.has(extname(reference.path).toLowerCase())?'text_file':nativeFileMime(reference.path)?'native_file':'metadata_only'};
    if(!reference.path||reference.status==='removed')return reference;
    const current=diskVersion(reference.path,reference.kind),availability=current.availability==='available'&&reference.version?.fingerprint&&reference.version.fingerprint!==current.version.fingerprint?'changed':current.availability;
    return {...reference,availability,observedVersion:current.version,readStatus:availability==='changed'&&reference.readStatus==='read'?'stale':reference.readStatus};
  }
  references(projectId,{includeRemoved=false,limit}={}){
    if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<1||limit>1000))throw Error('invalid_project_reference_limit');
    this.get(projectId);return this.db.prepare(`SELECT body FROM opennova_project_reference WHERE project_id=?${includeRemoved?'':" AND status='active'"} ORDER BY rowid DESC${limit?' LIMIT ?':''}`).all(projectId,...(limit?[limit]:[])).map(row=>this.observed(JSON.parse(row.body)));
  }
  reference(id){if(!ident(id))throw Error('unknown_project_reference');const value=this.row('opennova_project_reference',id);if(!value)throw Error('unknown_project_reference');return this.observed(value);}
  referenceValue(input,old){
    const kind=input.kind??old?.kind;if(!referenceKinds.has(kind))throw Error('invalid_project_reference_kind');
    const value={...old,kind,title:has(input,'title')?text(input.title,240,'invalid_project_reference_title',{empty:true}):old?.title??'',purpose:has(input,'purpose')?text(input.purpose,1000,'invalid_project_reference_purpose',{empty:true}):old?.purpose??'',readStatus:input.readStatus??old?.readStatus??'unread'};
    if(!['unread','read','stale'].includes(value.readStatus))throw Error('invalid_project_reference_read_status');
    if(has(input,'sourceRequestId')){if(!ident(input.sourceRequestId))throw Error('invalid_project_reference_source');value.sourceRequestId=input.sourceRequestId;}
    if(has(input,'source'))value.source=metadata(input.source,'invalid_project_reference_source');
    if(has(input,'version'))value.version=metadata(input.version,'invalid_project_reference_version');
    if(has(input,'availability')){
      if(!['available','missing','changed','invalid','unknown'].includes(input.availability))throw Error('invalid_project_reference_availability');value.availability=input.availability;
    }
    if(['file','directory','artifact'].includes(kind)){
      value.path=absolutePath(input.path??old?.path);delete value.url;
      const recapture=!old||input.action==='refresh'||input.action==='restore'||value.path!==old.path||kind!==old.kind;
      if(recapture){const current=diskVersion(value.path,kind);value.version=current.version;value.availability=current.availability;value.readStatus=input.readStatus??'unread';}
      value.readCapability=kind==='directory'?'directory_listing':kind==='artifact'?'artifact':textExtensions.has(extname(value.path).toLowerCase())?'text_file':nativeFileMime(value.path)?'native_file':'metadata_only';
      if(!value.title)value.title=basename(value.path);
    }else{
      delete value.path;value.url=url(input.url??old?.url);value.readCapability=kind==='selection'?'selection':'web_page';
      if(old&&(value.url!==old.url||kind!==old.kind)){
        value.version=metadata(input.version,'invalid_project_reference_version');value.readStatus=input.readStatus??'unread';value.availability=input.availability??'unknown';
      }
      value.version=value.version??{fingerprint:hash([kind,value.url])};value.availability=value.availability??'unknown';
      if(kind==='selection'&&!['documentRevision','revision','selectionHash'].some(key=>has(value.version,key)))throw Error('invalid_project_selection_version');
      if(!value.title)value.title=new URL(value.url).hostname;
    }
    return value;
  }
  mutateReference(input){
    fields(input,['action','actionId','projectId','revision','referenceId','kind','path','url','title','purpose','source','sourceRequestId','version','readStatus','availability','targetProjectId','targetRevision'],'invalid_project_reference_action');
    if(!['add','update','remove','restore','move','refresh'].includes(input.action))throw Error('invalid_project_reference_action');
    return this.action('reference',input,()=>{
      const project=this.expected(input.projectId,input.revision),old=input.action==='add'?null:this.row('opennova_project_reference',input.referenceId??'');
      if(input.action!=='add'&&(!old||old.projectId!==project.id))throw Error('unknown_project_reference');
      if(old?.status==='removed'&&input.action!=='restore')throw Error('project_reference_removed');
      if(input.action==='restore'&&old.status!=='removed')throw Error('invalid_project_reference_status');
      let value;
      if(['add','update','refresh','restore'].includes(input.action))value=this.referenceValue(input,old);
      else value={...old};
      if(old)this.remember('reference',old);
      value={...value,id:old?.id??'reference-'+randomUUID(),projectId:project.id,status:input.action==='remove'?'removed':'active',revision:(old?.revision??0)+1,createdAt:old?.createdAt??this.now(),updatedAt:this.now()};
      if(input.action==='move'){
        if(input.targetProjectId===project.id)throw Error('invalid_project_reference_target');
        const target=this.expected(input.targetProjectId,input.targetRevision);value.projectId=target.id;this.touch(target);
      }
      this.touch(project);return this.put('opennova_project_reference',value);
    });
  }
  records(projectId,{includeRetired=false}={}){
    this.get(projectId);return this.db.prepare(`SELECT body FROM opennova_project_record WHERE project_id=?${includeRetired?'':" AND status='active'"} ORDER BY rowid DESC`).all(projectId).map(row=>JSON.parse(row.body));
  }
  recordSource(input,projectId,type){
    if(!ident(input.sourceRequestId)||!plain(input.source)||!['user','tool','assistant'].includes(input.source.kind))throw Error('invalid_project_record_source');
    const raw=this.hasTable('records')?this.db.prepare("SELECT body FROM records WHERE id=? AND kind='request'").get(input.sourceRequestId):null;
    const request=raw?JSON.parse(raw.body):null,binding=request&&has(request,'projectId')?request.projectId:request?.executionContext?.projectId??request?.binding?.projectId;
    if(!request||binding!==projectId)throw Error('project_record_source_mismatch');
    if(type==='decision'&&input.source.kind!=='user')throw Error('project_decision_requires_user_source');
    return {sourceRequestId:input.sourceRequestId,source:metadata(input.source,'invalid_project_record_source')};
  }
  mutateRecord(input){
    fields(input,['action','actionId','projectId','revision','recordId','type','text','sourceRequestId','source','supersedes'],'invalid_project_record_action');
    if(!['add','update','retire','supersede'].includes(input.action))throw Error('invalid_project_record_action');
    return this.action('record',input,()=>{
      const project=this.expected(input.projectId,input.revision),old=input.action==='add'?null:this.row('opennova_project_record',input.recordId??'');
      if(input.action!=='add'&&(!old||old.projectId!==project.id))throw Error('unknown_project_record');
      if(old&&old.status!=='active')throw Error('project_record_retired');
      const type=input.type??old?.type;if(!recordTypes.has(type))throw Error('invalid_project_record_type');
      const provenance=this.recordSource(input,project.id,input.action==='retire'?null:type),valueText=input.action==='retire'?old.text:text(input.text??old?.text,4000,'invalid_project_record_text');
      if(old)this.remember('record',old);
      let value={...old,id:input.action==='supersede'||!old?'record-'+randomUUID():old.id,projectId:project.id,type,text:valueText,...provenance,status:input.action==='retire'?'retired':'active',revision:input.action==='supersede'||!old?1:old.revision+1,createdAt:input.action==='supersede'||!old?this.now():old.createdAt,updatedAt:this.now()};
      const replaced=input.action==='supersede'?old:input.supersedes?this.row('opennova_project_record',input.supersedes):null;
      if(input.supersedes&&!replaced)throw Error('unknown_project_record');
      if(replaced){
        if(replaced.projectId!==project.id||replaced.status!=='active'||replaced.id===value.id)throw Error('invalid_project_record_replacement');
        this.remember('record',replaced);this.put('opennova_project_record',{...replaced,status:'superseded',supersededBy:value.id,revision:replaced.revision+1,updatedAt:this.now()});value.supersedes=replaced.id;
      }
      this.touch(project);return this.put('opennova_project_record',value);
    });
  }
  hasTable(table){return !!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);}
  taskViews(projectId,limit=20){
    if(!this.hasTable('background_task'))return [];
    return this.db.prepare("SELECT body FROM background_task WHERE json_extract(body,'$.projectId')=? AND json_extract(body,'$.managementReview') IS NULL ORDER BY rowid DESC LIMIT ?").all(projectId,limit).map(row=>{
      const task=JSON.parse(row.body);return {id:task.id,projectId:task.projectId,title:task.title,status:task.status,cwd:task.cwd,runId:task.runId,requestId:task.requestId,parentTaskId:task.parentTaskId,createdAt:task.createdAt,updatedAt:task.updatedAt,closure:task.closure};
    });
  }
  reportViews(projectId,limit=10){
    if(!this.hasTable('team_report')||!this.hasTable('background_task'))return [];
    // Derive scope from the immutable task binding, including reports produced before A1.
    return this.db.prepare("SELECT r.body FROM team_report r JOIN background_task t ON t.id=json_extract(r.body,'$.taskId') WHERE json_extract(t.body,'$.projectId')=? AND json_extract(t.body,'$.managementReview') IS NULL ORDER BY r.rowid DESC LIMIT ?").all(projectId,limit).map(row=>{
      const report=JSON.parse(row.body);return {id:report.id,projectId,taskId:report.taskId,runId:report.runId,version:report.version,status:report.status,summary:clip(report.summary,1200),createdAt:report.createdAt,artifacts:(report.artifacts??[]).slice(0,10).map(a=>({id:a.id,name:a.name,path:a.path,status:a.status,sha256:a.sha256}))};
    });
  }
  summary(projectId){
    const project=this.get(projectId),tasks=this.taskViews(projectId,21),reports=this.reportViews(projectId,11),groups={};
    for(const type of recordTypes)groups[type]=this.db.prepare("SELECT body FROM opennova_project_record WHERE project_id=? AND status='active' AND json_extract(body,'$.type')=? ORDER BY json_extract(body,'$.updatedAt') DESC,rowid DESC LIMIT 9").all(projectId,type).map(row=>JSON.parse(row.body));
    return {revision:project.revision,decisions:groups.decision.slice(0,8),options:groups.option.slice(0,8),questions:groups.question.slice(0,8),nextSteps:groups.next_step.slice(0,8),tasks:tasks.slice(0,20),reports:reports.slice(0,10),truncated:Object.values(groups).some(rows=>rows.length>8)||tasks.length>20||reports.length>10};
  }
  detail(projectId){const project=this.get(projectId),summary=this.summary(projectId);return {project,references:this.references(projectId),records:this.records(projectId),tasks:summary.tasks,reports:summary.reports,summary};}
  context(projectId,{maxChars=16000}={}){
    const project=this.active(projectId);if(!Number.isSafeInteger(maxChars)||maxChars<2000||maxChars>64000)throw Error('invalid_project_context_limit');
    const summary=this.summary(projectId),allRefs=this.references(projectId,{limit:13}),references=allRefs.slice(0,12).map(({id,kind,title,purpose,path,url,version,availability,readCapability,readStatus,revision})=>({id,kind,title:clip(title,160),purpose:clip(purpose,240),path,url,version,availability,readCapability,readStatus,revision}));
    for(const group of Object.values(recordGroups))summary[group]=summary[group].map(contextRecord);
    summary.tasks=summary.tasks.slice(0,10);summary.reports=summary.reports.slice(0,3).map(({artifacts,...report})=>({...report,summary:clip(report.summary,500),artifacts:artifacts.map(({id,name,status})=>({id,name,status}))}));
    return fitContext({project:{id:project.id,name:project.name,goal:clip(project.goal,500),directory:project.directory,workspace:project.workspace,revision:project.revision},references,summary,truncated:summary.truncated||allRefs.length>references.length},maxChars);
  }
  taskContext(requestId,context){
    if(!context?.summary)return context;
    // A turn can record a choice and dispatch it in the same breath. Overlay only
    // its committed receipts on ingress, even if a panel changes the project later.
    const rows=this.db.prepare(`SELECT body FROM opennova_project_action WHERE json_extract(body,'$.sourceRequestId')=?
      AND json_type(body,'$.type') IS NOT NULL AND json_extract(body,'$.projectId')=? ORDER BY rowid`).all(requestId,context.project.id);
    if(!rows.length)return context;
    const result=structuredClone(context),{summary}=result;
    for(const row of rows){
      const record=JSON.parse(row.body);
      for(const group of Object.values(recordGroups))summary[group]=summary[group].filter(item=>item.id!==record.id&&item.id!==record.supersedes);
      if(record.status==='active')summary[recordGroups[record.type]].unshift(contextRecord(record));
    }
    for(const group of Object.values(recordGroups)){
      if(summary[group].length>8){summary[group].length=8;summary.truncated=true;result.truncated=true;}
    }
    return fitContext(result,16000,requestId);
  }
  /** Only durable, explicit workspace/task ancestry is migration evidence. No chat or memory guesses. */
  migrateLegacy(){
    if(!this.hasTable('background_task'))return {tasks:0,related:0};
    return this.transaction(()=>{
      this.db.exec("CREATE INDEX IF NOT EXISTS background_task_project ON background_task(json_extract(body,'$.projectId'))");
      const original=this.get(DEFAULT_PROJECT_ID).legacyWorkspace??this.workspace,rows=this.db.prepare("SELECT id,body FROM background_task WHERE json_type(body,'$.projectId') IS NULL").all(),bound=new Set(),result={tasks:0,related:0};
      const known=this.db.prepare("SELECT id FROM background_task WHERE json_extract(body,'$.projectId')=?").all(DEFAULT_PROJECT_ID);for(const row of known)bound.add(row.id);
      const pending=rows.map(row=>JSON.parse(row.body));let changed=true;
      while(changed){
        changed=false;
        for(const task of pending){
          if(bound.has(task.id))continue;
          const explicit=[task.cwd,task.workspace].some(path=>typeof path==='string'&&isAbsolute(path)&&resolve(path)===resolve(original));
          const parent=task.parentTaskId??task.managementReview?.targetTaskId;
          if(!explicit&&(!parent||!bound.has(parent)))continue;
          this.db.prepare('UPDATE background_task SET body=? WHERE id=?').run(JSON.stringify({...task,projectId:DEFAULT_PROJECT_ID}),task.id);bound.add(task.id);result.tasks++;changed=true;
        }
      }
      for(const table of ['background_run','background_job','background_message','team_report','team_review'])if(this.hasTable(table)){
        this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_project_task ON ${table}(json_extract(body,'$.taskId'),json_extract(body,'$.projectId'))`);
        result.related+=this.db.prepare(`UPDATE ${table} SET body=json_set(body,'$.projectId',?) WHERE json_extract(body,'$.projectId') IS NULL AND json_extract(body,'$.taskId') IN (SELECT id FROM background_task WHERE json_extract(body,'$.projectId')=?)`).run(DEFAULT_PROJECT_ID,DEFAULT_PROJECT_ID).changes;
      }
      if(this.hasTable('records')){
        this.db.exec("CREATE INDEX IF NOT EXISTS records_project_notification_task ON records(json_extract(body,'$.taskId')) WHERE kind='task_notification'");
        result.related+=this.db.prepare("UPDATE records SET body=json_set(body,'$.projectId',?) WHERE kind='task_notification' AND json_extract(body,'$.projectId') IS NULL AND json_extract(body,'$.taskId') IN (SELECT id FROM background_task WHERE json_extract(body,'$.projectId')=?)").run(DEFAULT_PROJECT_ID,DEFAULT_PROJECT_ID).changes;
      }
      return result;
    });
  }
}
