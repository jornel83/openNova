/** Execution authority is issued by the host, never deserialized from model arguments. */
import {AsyncLocalStorage} from 'node:async_hooks';
export class TeamActors {
  constructor({team,tasks}){Object.assign(this,{team,tasks});this.grants=new WeakSet();this.context=new AsyncLocalStorage();}
  issue({kind,botId,taskId,runId,assignmentVersion,request}){
    if(!['user','supervisor','worker'].includes(kind))throw Error('invalid_actor');
    this.team.bot(botId);
    if(kind==='supervisor'&&botId!==this.team.chiefId)throw Error('actor_denied');
    const actor=Object.freeze({kind,botId,taskId,runId,assignmentVersion,request});this.grants.add(actor);return actor;
  }
  check(actor,taskId,{manage=false}={}){
    if(!this.grants.has(actor)||actor.request?.cancelled||actor.request?.signal?.aborted)throw Error('actor_denied');
    if(actor.kind==='user')return actor;
    if((actor.botId!==this.team.chiefId&&!this.team.enabled())||!this.team.profile(actor.botId).enabled)throw Error('actor_disabled');
    const own=this.tasks.row('task',actor.taskId);
    if(own.runId!==actor.runId||own.assignedBotId!==actor.botId||own.assignmentVersion!==actor.assignmentVersion||own.status!=='running')throw Error('actor_stale');
    if(actor.kind==='worker'&&(manage||taskId!==actor.taskId))throw Error('actor_denied');
    return actor;
  }
  run(actor,fn){this.check(actor,actor.taskId);return this.context.run(actor,fn);}
  request(){const actor=this.context.getStore();this.check(actor,actor?.taskId,{manage:true});return actor.request??{id:actor.runId,actor};}
  revoke(actor){this.grants.delete(actor);}
}
