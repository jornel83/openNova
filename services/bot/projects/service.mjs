/** The host, not model tool arguments, commits a turn's project and workspace. */
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,realpathSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {documentReviewChoices,documentUndoChoices} from '../documents/decision-tool.mjs';
import {safeError} from '../../agent/errors.mjs';
import {projectRoutingFailure} from './routing-failure.mjs';

const frozen=value=>{if(value&&typeof value==='object'){for(const x of Object.values(value))frozen(x);Object.freeze(value);}return value;};
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,stable(value[key])])):value;
const same=(a,b)=>a.projectId===b.projectId&&a.focus===b.focus;
export class ProjectService {
  constructor({store,sessions,router,ops,context,voice,events}){Object.assign(this,{store,sessions,router,ops,context,voice,events});ops.db.exec('CREATE TABLE IF NOT EXISTS opennova_project_command (id TEXT PRIMARY KEY,input TEXT NOT NULL,body TEXT NOT NULL)');}
  state(){return this.store.state();}
  availability(project){try{return statSync(project.workspace).isDirectory()?'available':'unavailable';}catch(error){return ['ENOENT','ENOTDIR'].includes(error.code)?'missing':'unavailable';}}
  view(){return {...this.store.view(),projects:this.store.list().map(project=>({...project,availability:this.availability(project)}))};}
  detail(id){const detail=this.store.detail(id);return {...detail,project:{...detail.project,availability:this.availability(detail.project)}};}
  project(){return this.store.get(this.state().projectId);}
  async initialize(){
    let state=this.state();
    // SQLite is the durable selection. Repair a crash between the session save
    // and selection commit by restoring that selection before accepting work.
    const project=this.store.get(state.projectId);
    if(state.focus==='work'&&this.availability(project)!=='available'){
      await this.sessions.activate({project,focus:'daily'});
      this.store.select({projectId:project.id,focus:'daily',revision:state.revision,actionId:'directory-unavailable-'+state.revision+'-'+project.id});
      state=this.state();
    }else await this.sessions.activate({project,focus:state.focus});
    this.restoreContext(state);
  }
  validateExpected(expected){
    const state=this.state();
    if(expected!==undefined&&(!expected||expected.projectId!==state.projectId||expected.revision!==state.revision))throw Error('project_state_changed');
    return state;
  }
  admit({expectedProject}){
    const state=this.validateExpected(expectedProject);
    const context=this.context.capture();
    return frozen({entryProject:{...state,projectRevision:this.store.get(state.projectId).revision},entryContext:context,context});
  }
  saveContext(state=this.state()){
    if(state.focus==='work')this.ops.put({id:'project-context-'+state.projectId,kind:'project_context',projectId:state.projectId,value:this.context.capture()});
  }
  restoreContext(state){
    let value;try{value=this.ops.get('project-context-'+state.projectId).value;}catch{}
    this.context.restore(state.focus==='work'?value:null);
  }
  async transition({projectId,focus='work',revision=this.state().revision,actionId=randomUUID(),signal}){
    projectId??=this.state().projectId;
    const input={projectId,focus,revision,actionId};
    if(this.store.db.prepare('SELECT id FROM opennova_project_action WHERE id=?').get(actionId))return this.store.select(input);
    const before=this.validateExpected({projectId:this.state().projectId,revision});
    const project=this.store.get(projectId);
    if(focus==='work'&&project.status!=='active')throw Error('project_archived');
    if(focus==='work'&&this.availability(project)!=='available')throw Error('project_directory_unavailable');
    signal?.throwIfAborted();
    this.saveContext(before);
    const checkpoint=this.sessions.checkpoint?.();
    let result;
    try{
      await this.sessions.activate({project,focus,signal});signal?.throwIfAborted();
      result=this.store.select(input);
    }catch(error){
      if(checkpoint)await this.sessions.restore(checkpoint);
      else await this.sessions.activate({project:this.store.get(before.projectId),focus:before.focus});
      throw error;
    }
    this.restoreContext(this.state());
    this.notifications?.focusChanged();
    // Discard audio from the departed work turn. Neither microphone capture nor
    // running tasks are cancelled by a conversation topic transition.
    const speech=this.voice?.snapshot();
    if(before.projectId!==projectId&&speech?.connected&&speech.requestId&&speech.playback!=='idle'){
      try{this.voice.enqueue({id:randomUUID(),action:'stop',voiceInstanceId:speech.voiceInstanceId,generation:speech.generation,requestId:speech.requestId});}catch{}
    }
    this.events?.publish('project.updated',this.view());return result;
  }
  async action(input){
    const {id,...clean}=input,projectId=input.projectId??id;input={...clean,...(projectId?{projectId}:{})};
    if(input.action==='select')return this.transition({...input,projectId});
    if(this.store.db.prepare('SELECT id FROM opennova_project_action WHERE id=?').get(input.actionId))return this.store.mutate(input);
    const before=this.state(),previous=this.store.get(before.projectId);
    this.saveContext(before);
    const affectsCurrent=projectId===before.projectId;
    const checkpoint=affectsCurrent?this.sessions.checkpoint?.():null;
    let candidate=previous,focus=before.focus;
    if(affectsCurrent){
      this.store.expected(projectId,input.revision,{archived:true});
      if(input.action==='archive')focus='daily';
      if(input.action==='update'&&Object.hasOwn(input,'directory')){
        const workspace=input.directory?realpathSync(input.directory):join(this.store.home,'projects',projectId,'workspace');
        if(!input.directory)mkdirSync(workspace,{recursive:true,mode:0o700});
        candidate={...previous,workspace};
      }
    }
    try{
      if(affectsCurrent)await this.sessions.activate({project:candidate,focus});
      const result=this.store.mutate(input);
      if(affectsCurrent){this.restoreContext(this.state());this.notifications?.focusChanged();}
      return result;
    }catch(error){if(affectsCurrent){if(checkpoint)await this.sessions.restore(checkpoint);else await this.sessions.activate({project:previous,focus:before.focus});}throw error;}
  }
  reference(input){
    const signature=JSON.stringify(stable(input));
    const prior=this.ops.db.prepare('SELECT input,body FROM opennova_project_command WHERE id=?').get(input.actionId);
    if(prior){if(prior.input!==signature)throw Error('project_action_conflict');return {...this.view(),result:JSON.parse(prior.body),replayed:true};}
    const {id,expectedSelection,...clean}=input;
    if(input.kind==='selection'&&input.action==='add'){
      const current=this.context.capture();
      if(this.state().focus!=='work'||this.state().projectId!==input.projectId||current.kind!=='browser'||!current.selection||!expectedSelection||
        ['documentId','revision','text'].some(key=>current.selection[key]!==expectedSelection[key]))throw Error('context_changed');
      Object.assign(clean,{url:current.page.url,version:{documentId:current.selection.documentId,revision:current.selection.revision,selectionHash:createHash('sha256').update(current.selection.text).digest('hex')},source:{kind:'selection',quote:current.selection.text.slice(0,2000)}});
    }
    return this.store.transaction(()=>{
      const result=this.store.mutateReference({...clean,...(input.referenceId??id?{referenceId:input.referenceId??id}:{})});
      this.ops.db.prepare('INSERT INTO opennova_project_command VALUES (?,?,?)').run(input.actionId,signature,JSON.stringify(result.result));return result;
    });
  }
  record(input,request){
    const {id,...clean}=input;input={...clean,...(input.recordId??id?{recordId:input.recordId??id}:{})};
    const projectId=input.projectId??request?.projectId;
    if(request){
      if(request.projectId!==projectId||request.binding?.focus!=='work')throw Error('project_request_mismatch');
      return this.store.mutateRecord({...input,projectId,sourceRequestId:request.id,
        source:{kind:'user',quote:input.source?.quote??request.input.slice(0,2000)}});
    }
    // A panel form is an explicit user source, separate from a conversation turn.
    const actionId=input.actionId;
    if(typeof actionId!=='string'||!actionId)throw Error('invalid_project_action');
    const sourceId='project-edit-'+createHash('sha256').update(actionId).digest('hex').slice(0,40);
    let prior;try{prior=this.ops.request(sourceId);}catch{}
    const text=JSON.stringify({action:input.action,type:input.type,text:input.text,recordId:input.recordId??input.id,projectId});
    if(prior&&prior.input!==text)throw Error('project_action_conflict');
    if(!prior)this.ops.put({id:sourceId,kind:'request',source:'project-panel',projectId,input:text,status:'completed',createdAt:Date.now()});
    return this.store.mutateRecord({...input,projectId,sourceRequestId:sourceId,source:{kind:'user',quote:text.slice(0,2000)}});
  }
  recent(){
    return this.ops.list('request').filter(r=>r.source!=='project-panel'&&r.status==='completed'&&!projectRoutingFailure(r.routing)).slice(0,4).reverse().flatMap(r=>[
      {role:'user',text:r.input.slice(0,600)},...(r.binding?.focus==='clarify'?[{role:'assistant',text:(r.text??r.reply??'').slice(0,600)}]:[])]);
  }
  routingTasks(){
    if(!this.ops.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='background_task'").get())return [];
    return this.ops.db.prepare("SELECT body FROM background_task WHERE json_extract(body,'$.managementReview') IS NULL ORDER BY rowid DESC LIMIT 20").all().map(row=>{const t=JSON.parse(row.body);return {id:t.id,projectId:t.projectId,title:t.title?.slice(0,160),status:t.status};});
  }
  async bind(record,active){
    if(record.binding||active.binding||this.ops.request(record.id).binding)throw Error('project_already_bound');
    const entry=record.entryProject??this.state();
    this.validateExpected(entry);
    const documentReviews=documentReviewChoices(this.ops,entry);
    const current=record.entryContext??record.context;
    const documentUndos=documentUndoChoices(this.ops,entry,current?.kind==='file'?current.file:null);
    let route=await this.router.classify({record,active,projects:this.store.list(),context:{...entry,resumableProjectId:entry.projectId,tasks:this.routingTasks(),documentReviews,documentUndos},recent:this.recent()});
    active.signal.throwIfAborted();
    this.validateExpected(entry);
    if(route.focus==='work'&&this.availability(this.store.get(route.projectId))!=='available')route={focus:'clarify',projectId:null,reason:'project_directory_unavailable',question:'这个项目的目录暂时不可用。请在项目概览修正目录，或先继续其他话题。'};
    this.ops.finish(record.id,{routing:route});
    if(route.failure)throw safeError(route.failure,'routing');
    if(route.focus==='clarify'){
      active.binding=frozen({focus:'clarify',projectId:null});
      Object.assign(record,{binding:active.binding,projectId:null,context:{kind:'none'}});
      this.ops.finish(record.id,{binding:active.binding,projectId:null,context:{kind:'none'}});
      return {question:route.question||'这次要接着处理哪个项目或对象？'};
    }
    if(route.focus==='manage'){
      const project=this.store.get(route.projectId);
      if(route.action!=='restore'||project.status!=='archived')throw Error('invalid_project_management_route');
      active.managementSession=true;
      const session=await this.sessions.activate({project,focus:'manage',signal:active.signal});active.signal.throwIfAborted();
      const binding=frozen({...session,focus:'manage',action:'restore',projectId:project.id,revision:entry.revision,projectRevision:project.revision,context:{kind:'none'},projectContext:{project:{id:project.id,name:project.name,status:project.status,revision:project.revision}}});
      active.binding=binding;active.projectId=project.id;active.sessionId=session.sessionId;
      Object.assign(record,{projectId:project.id,binding,context:binding.context});this.ops.finish(record.id,{projectId:project.id,binding,context:binding.context});
      return {binding};
    }
    const projectId=route.focus==='daily'?entry.projectId:route.projectId;
    if(!projectId)throw Error('project_required');
    if(!same(entry,{projectId,focus:route.focus}))await this.transition({projectId,focus:route.focus,revision:entry.revision,actionId:'route-'+record.id,signal:active.signal});
    const project=this.store.get(projectId),session=this.sessions.capture();
    const binding=frozen({...session,focus:route.focus,projectId:route.focus==='work'?projectId:null,
      resumableProjectId:projectId,revision:this.state().revision,projectRevision:project.revision,
      context:route.focus==='work'?(entry.focus==='work'&&projectId===entry.projectId?record.entryContext??record.context:this.context.capture()):{kind:'none'},
      projectContext:route.focus==='work'?this.store.context(projectId):null,...(route.documentDecision?{documentDecision:route.documentDecision}:{})});
    active.binding=binding;active.projectId=binding.projectId;active.sessionId=binding.sessionId;
    Object.assign(record,{projectId:binding.projectId,binding,context:binding.context});
    this.ops.finish(record.id,{projectId:binding.projectId,binding,context:binding.context});
    return {binding};
  }
  taskBinding(requestId){
    if(requestId){
      const {binding}=this.ops.request(requestId);
      if(binding?.focus!=='work')throw Error('project_work_request_required');
      return {...binding,fileReferences:binding.projectContext?.references,projectContext:this.store.taskContext(requestId,binding.projectContext)};
    }
    const state=this.state();if(state.focus!=='work')throw Error('project_work_request_required');
    const project=this.store.get(state.projectId);if(project.status!=='active')throw Error('project_archived');if(this.availability(project)!=='available')throw Error('project_directory_unavailable');
    return {projectId:project.id,cwd:project.workspace,projectRevision:project.revision,projectContext:this.store.context(project.id),context:this.context?.capture()??{kind:'none'}};
  }
}
