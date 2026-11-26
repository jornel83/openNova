import {mkdirSync,realpathSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {settleBot} from '../project.mjs';

const copy=value=>structuredClone(value);
const keyOf=(focus,project)=>focus==='daily'?'daily':`${focus==='manage'?'manage':'project'}:${project.id}`;
const sessionIds=scope=>[scope?.sessionId,...(scope?.segments??[]).map(part=>part.sessionId)].filter(Boolean);
function resolvedWorkspace(path) {
  try{return realpathSync(path);}
  catch(error){if(['ENOENT','ENOTDIR','EACCES','ELOOP'].includes(error.code))return null;throw error;}
}

/** Projects select saved conversations; native folder handoff would copy the old one. */
export class ProjectSessions {
  constructor({ctx,rt,bot,workspace,dailyWorkspace,provider='opennova-chatgpt',model='gpt-6.1-sol'}) {
    Object.assign(this,{ctx,rt,bot,workspace,provider,model});
    if(!dailyWorkspace&&!rt.home)throw Error('daily_workspace_required');
    this.dailyWorkspace=dailyWorkspace??join(rt.home,'daily-workspace');
    this.managementWorkspace=join(rt.home??dirname(this.dailyWorkspace),'management-workspace');
    rt.state.opennovaProjectSessions??={};
    this.state=rt.state.opennovaProjectSessions[bot.id]??={version:1,activeKey:null,scopes:{},legacy:{sessionId:rt.chatOf(bot.id),segments:copy(bot.segments??[]),cwd:bot.workDir??workspace}};
    if(this.state.version!==1||!this.state.scopes)throw Error('project_sessions_invalid');
    this.pending=false;
    this.checkpoints=new WeakMap();
  }

  capture() {
    const scope=this.state.scopes[this.state.activeKey];
    if(!scope)return null;
    const current=this.rt.chatOf(this.bot.id);
    if(this.bot.workDir!==scope.cwd)throw Error('project_session_workspace_changed');
    for(const [key,other] of Object.entries(this.state.scopes))if(key!==this.state.activeKey&&sessionIds(other).includes(current))throw Error('project_session_owner_changed');
    scope.sessionId=current;
    scope.segments=copy(this.bot.segments??[]);
    return copy({focus:scope.focus,projectId:scope.projectId,sessionId:scope.sessionId,cwd:resolvedWorkspace(scope.cwd)??scope.cwd});
  }

  async save(){const binding=this.capture();await this.rt.save();return binding;}

  checkpoint() {
    this.capture();
    const checkpoint=Object.freeze({});
    this.checkpoints.set(checkpoint,copy({state:this.state,projection:{sessionId:this.bot.sessionId,segments:this.bot.segments,workDir:this.bot.workDir,workspaceId:this.rt.state.workspaceId}}));
    return checkpoint;
  }

  async restore(checkpoint) {
    const snapshot=this.checkpoints.get(checkpoint);
    if(!snapshot)throw Error('project_session_checkpoint_invalid');
    if(this.pending)throw Error('project_session_busy');
    this.pending=true;
    try {
      await settleBot(this.rt,this.bot);
      const sessionId=snapshot.projection.sessionId??this.bot.id;
      const agent=await this.rt.resolveAgent(sessionId);
      if(agent.session.header?.cwd!==snapshot.projection.workDir)throw Error('project_session_workspace_changed');
      await agent.whenIdle();
      await this.rt.selectSessionModel(sessionId,{provider:this.provider,model:this.model});
      await this.rt.applyPermission({...this.bot,permission:this.bot.permission??'danger-full-access'},sessionId);
      const prior=copy({state:this.state,projection:{sessionId:this.bot.sessionId,segments:this.bot.segments,workDir:this.bot.workDir,workspaceId:this.rt.state.workspaceId}});
      const install=value=>{
        for(const key of Object.keys(this.state))delete this.state[key];
        Object.assign(this.state,copy(value.state));
        const {workspaceId,...bot}=copy(value.projection);Object.assign(this.bot,bot);this.rt.state.workspaceId=workspaceId;
      };
      install(snapshot);
      try {await this.rt.save();}
      catch(error){install(prior);await this.rt.save().catch(()=>{});throw error;}
      await this.rt.ensureCapabilities(sessionId);
      this.checkpoints.delete(checkpoint);
      return this.capture();
    } finally {this.pending=false;}
  }

  owns(sessionId,{activeOnly=false}={}) {
    const scopes=activeOnly?[this.state.scopes[this.state.activeKey]]:Object.values(this.state.scopes);
    if(activeOnly&&this.state.activeKey&&[this.rt.chatOf(this.bot.id),...(this.bot.segments??[]).map(part=>part.sessionId)].includes(sessionId))return true;
    return scopes.some(scope=>sessionIds(scope).includes(sessionId));
  }

  async activate({project=null,focus,signal}={}) {
    if(this.pending)throw Error('project_session_busy');
    if(!['daily','work','manage'].includes(focus))throw Error('project_focus_invalid');
    if(focus==='work'&&(!project||typeof project.id!=='string'||!project.id||typeof project.workspace!=='string'))throw Error('project_required');
    if(focus==='manage'&&(!project||typeof project.id!=='string'||!project.id))throw Error('project_required');
    if(focus==='work'&&(project.status==='archived'||project.archivedAt))throw Error('project_archived');
    this.pending=true;
    try {
      signal?.throwIfAborted();
      await settleBot(this.rt,this.bot,signal);
      this.capture();
      const key=keyOf(focus,project);
      if(focus!=='work')mkdirSync(focus==='daily'?this.dailyWorkspace:this.managementWorkspace,{recursive:true});
      const target=realpathSync(focus==='daily'?this.dailyWorkspace:focus==='manage'?this.managementWorkspace:project.workspace);
      let scope=this.state.scopes[key];
      const moved=scope&&scope.cwd!==target&&resolvedWorkspace(scope.cwd)!==target;
      if(moved&&focus!=='work')throw Error('project_session_workspace_changed');
      // Native session headers retain their creation path, even after a home rename.
      const cwd=scope&&!moved?scope.cwd:target;
      const workspace=await this.ctx.workspaceRegistry.resolveByPath(target)??await this.ctx.workspaceRegistry.create(target,focus==='daily'?'OpenNova · 日常交流':focus==='manage'?'OpenNova · 项目管理':project.name??'OpenNova');
      signal?.throwIfAborted();
      if(!scope||moved) {
        const {sessionId}=await this.ctx.sessionController.create({sessionId:`opennova-${randomUUID()}`,cwd});
        const segments=scope?[...copy(scope.segments),{sessionId:scope.sessionId,endedAt:Date.now(),cwd:scope.cwd}]:[];
        scope={focus,projectId:focus==='daily'?null:project.id,sessionId,segments,cwd,workspaceId:workspace.id};
      }
      const agent=await this.rt.resolveAgent(scope.sessionId);
      if(agent.session.header?.cwd!==cwd)throw Error('project_session_workspace_changed');
      await agent.whenIdle();
      await this.rt.selectSessionModel(scope.sessionId,{provider:this.provider,model:this.model});
      await this.rt.applyPermission({...this.bot,permission:this.bot.permission??'danger-full-access'},scope.sessionId);
      signal?.throwIfAborted();
      const prior={sessionId:this.bot.sessionId,segments:this.bot.segments,workDir:this.bot.workDir,workspaceId:this.rt.state.workspaceId,activeKey:this.state.activeKey,scope:this.state.scopes[key]};
      this.bot.sessionId=scope.sessionId;
      this.bot.segments=copy(scope.segments);
      this.bot.workDir=cwd;
      this.rt.state.workspaceId=workspace.id;
      this.state.scopes[key]={...scope,workspaceId:workspace.id};
      this.state.activeKey=key;
      try {await this.rt.save();}
      catch(error) {
        Object.assign(this.bot,{sessionId:prior.sessionId,segments:prior.segments,workDir:prior.workDir});
        this.rt.state.workspaceId=prior.workspaceId;
        this.state.activeKey=prior.activeKey;
        if(prior.scope)this.state.scopes[key]=prior.scope;else delete this.state.scopes[key];
        await this.rt.save().catch(()=>{});
        throw error;
      }
      await this.rt.ensureCapabilities(scope.sessionId);
      return this.capture();
    } finally {this.pending=false;}
  }
}
