/** Durable rules and deliveries. Event consumption and new Runs commit together. */
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {eventHash,fileObservation,watchedPaths,githubSource,githubComments} from './event-sources.mjs';
const idOk=v=>typeof v==='string'&&/^[\w-]{1,100}$/.test(v);
const active=new Set(['queued','running','pausing','cancelling']);
export class TaskEventEngine{
  constructor(tasks,{now=Date.now,fetcher=fetch,githubTokenPath}={}){
    Object.assign(this,{tasks,db:tasks.db,now,fetcher,githubTokenPath});this.controller=new AbortController();this.nextPoll=0;
    for(const kind of ['event','rule','delivery'])this.db.exec(`CREATE TABLE IF NOT EXISTS background_${kind} (id TEXT PRIMARY KEY, body TEXT NOT NULL)`);
    this.db.exec("CREATE INDEX IF NOT EXISTS delivery_task ON background_delivery(json_extract(body,'$.taskId')); CREATE INDEX IF NOT EXISTS delivery_pending ON background_delivery(json_extract(body,'$.status')); CREATE INDEX IF NOT EXISTS rule_task ON background_rule(json_extract(body,'$.taskId'))");
  }
  rows(kind){return this.db.prepare(`SELECT body FROM background_${kind} ORDER BY rowid`).all().map(r=>JSON.parse(r.body));}
  find(kind,id){const r=this.db.prepare(`SELECT body FROM background_${kind} WHERE id=?`).get(id);return r?JSON.parse(r.body):null;}
  put(kind,row){return this.tasks.put(kind,row);}
  rules(taskId){return this.db.prepare("SELECT body FROM background_rule WHERE json_extract(body,'$.taskId')=? ORDER BY rowid").all(taskId).map(r=>JSON.parse(r.body));}
  pending(){return this.db.prepare("SELECT body FROM background_delivery WHERE json_extract(body,'$.status')='pending' ORDER BY rowid").all().map(r=>JSON.parse(r.body));}
  usable(rule){return rule.enabled&&rule.usedRuns<rule.maxRuns&&rule.expiresAt>this.now()&&!rule.sourceStopped;}
  view(task){return {paused:!!task.automationPaused,rules:this.rules(task.id).map(r=>({...r,state:!r.enabled?'disabled':r.sourceStopped?'attention':r.expiresAt<=this.now()?'expired':r.usedRuns>=r.maxRuns?'exhausted':'enabled'})),deliveries:this.db.prepare("SELECT body FROM background_delivery WHERE json_extract(body,'$.taskId')=? ORDER BY rowid DESC LIMIT 50").all(task.id).map(r=>JSON.parse(r.body)).map(d=>({...d,event:this.find('event',d.eventId)}))};}
  validate(input){
    const {id,taskId,type,instruction,maxRuns=2,ttlHours=24,enabled=false}=input;
    const task=this.tasks.row('task',taskId);
    if(task.kind!=='agent'||!idOk(id)||!['check','task','file','github'].includes(type)||typeof instruction!=='string'||!instruction.trim()||instruction.length>4000||typeof enabled!=='boolean')throw Error('invalid_event_rule');
    if(!Number.isInteger(maxRuns)||maxRuns<1||maxRuns>5||!Number.isInteger(ttlHours)||ttlHours<1||ttlHours>168)throw Error('invalid_event_budget');
    let source={};
    if(type==='check'){if(task.mode!=='edit')throw Error('event_check_requires_edit');}
    if(type==='task'){
      const from=this.tasks.row('task',input.source?.taskId),run=this.tasks.row('run',input.source?.runId);
      if(from.id===taskId||from.kind==='agent'||run.taskId!==from.id||from.parentTaskId)throw Error('invalid_event_source');
      source={taskId:from.id,runId:run.id};
    }
    if(type==='file')source={paths:watchedPaths(input.source?.paths)};
    if(type==='github')source=githubSource(input.source);
    return {id,taskId,type,instruction:instruction.trim(),maxRuns,ttlHours,enabled,source};
  }
  add(input,{atomic=true}={}){
    if(this.tasks.closed)throw Error('host_stopping');
    const spec=this.validate(input),fingerprint=eventHash(JSON.stringify(spec)),old=this.find('rule',spec.id);
    if(old){if(old.fingerprint!==fingerprint)throw Error('task_id_conflict');return old;}
    if(this.rules(spec.taskId).length>=50||spec.enabled&&(this.rules(spec.taskId).filter(r=>r.enabled).length>=10||this.rows('rule').filter(r=>r.enabled).length>=100))throw Error('event_rule_limit');
    if(spec.type==='check'&&spec.enabled&&this.rules(spec.taskId).some(r=>r.type==='check'&&r.enabled))throw Error('event_check_rule_exists');
    const at=this.now(),rule={...spec,fingerprint,createdAt:at,expiresAt:at+spec.ttlHours*3600000,revision:1,usedRuns:0,eventCount:0,sourceState:{since:at,nextPollAt:at}};
    if(spec.type==='file')rule.sourceState={baseline:fileObservation(this.tasks.workspace,spec.source.paths).digest};
    const save=()=>{this.put('rule',rule);if(spec.enabled&&spec.type==='task')this.importCompletion(rule);};
    if(atomic)this.tasks.atomic(save);else save();
    return rule;
  }
  setEnabled({id,enabled,revision}){
    if(typeof enabled!=='boolean')throw Error('invalid_event_rule');const rule=this.tasks.row('rule',id);
    if(rule.revision!==revision)throw Error('event_rule_changed');
    if(rule.enabled===enabled)return rule;
    if(enabled&&(this.rules(rule.taskId).filter(r=>r.enabled).length>=10||this.rows('rule').filter(r=>r.enabled).length>=100))throw Error('event_rule_limit');
    if(enabled&&rule.type==='check'&&this.rules(rule.taskId).some(r=>r.id!==id&&r.type==='check'&&r.enabled))throw Error('event_check_rule_exists');
    if(enabled&&(rule.usedRuns>=rule.maxRuns||rule.expiresAt<=this.now()))throw Error('event_rule_exhausted');
    const baseline=enabled&&rule.type==='file'?fileObservation(this.tasks.workspace,rule.source.paths).digest:null;
    this.tasks.atomic(()=>{
      Object.assign(rule,{enabled,revision:rule.revision+1,error:null,sourceStopped:false});
      if(enabled)rule.sourceState=rule.type==='file'?{baseline}:{since:this.now(),nextPollAt:this.now()};
      this.put('rule',rule);
      if(!enabled)for(const d of this.pending().filter(d=>d.ruleId===id))this.put('delivery',{...d,status:'cancelled',reason:'rule_disabled'});
      if(enabled&&rule.type==='task')this.importCompletion(rule);
    });
    const task=this.tasks.row('task',rule.taskId),run=this.tasks.row('run',task.runId);
    if(!enabled&&task.status==='queued'&&run.trigger?.ruleId===id)this.tasks.pause({id:task.id,runId:run.id});
    this.tasks.changed(this.tasks.row('task',rule.taskId));return rule;
  }
  setPaused({id,paused}){
    if(typeof paused!=='boolean')throw Error('invalid_event_rule');const task=this.tasks.row('task',id);if(task.kind!=='agent')throw Error('not_agent_task');
    task.automationPaused=paused;this.tasks.put('task',task);
    if(paused&&task.status==='queued'&&this.tasks.row('run',task.runId).trigger)this.tasks.pause({id,runId:task.runId});
    this.tasks.changed(this.tasks.row('task',id));return this.tasks.row('task',id);
  }
  canCheck(id){return this.rules(id).some(r=>r.type==='check'&&this.usable(r))&&!this.tasks.row('task',id).automationPaused;}
  importCompletion(rule){
    const run=this.tasks.row('run',rule.source.runId),job=this.tasks.row('job',run.jobId);
    if(job.cleanupConfirmed&&['completed','failed'].includes(run.status)){
      const task=this.tasks.row('task',rule.source.taskId);this.recordCompletion({...task,runId:run.id},run,job,[rule]);
    }
  }
  recordCompletion(task,run,job,rules=this.rows('rule')){
    if(task.kind==='agent'||!job.cleanupConfirmed||!['completed','failed'].includes(run.status))return;
    const id=eventHash('command.finished\0'+run.id),old=this.find('event',id);let event=old;
    if(!event){let output='';try{output=readFileSync(join(this.tasks.directory(job),'output.log'),'utf8').slice(-6000);}catch(e){if(e.code!=='ENOENT')throw e;}
      event={id,type:'command.finished',createdAt:this.now(),data:{taskId:task.id,runId:run.id,title:task.title,cwd:task.cwd,status:run.status,exitCode:job.exitCode,error:job.error,parentTaskId:task.parentTaskId,parentRunId:task.parentRunId,output}};this.put('event',event);
    }
    for(const rule of rules){
      const match=rule.type==='check'?task.parentTaskId===rule.taskId:rule.type==='task'&&rule.source.taskId===task.id&&rule.source.runId===run.id;
      if(match&&this.usable(rule))this.deliver(rule,event);
    }
  }
  deliver(rule,event){
    const id=eventHash(rule.id+'\0'+event.id);if(this.find('delivery',id))return;
    this.put('delivery',{id,ruleId:rule.id,eventId:event.id,taskId:rule.taskId,status:'pending',createdAt:this.now()});
  }
  publishSource(rule,data,key){
    if(!this.usable(rule))return;
    const id=eventHash(rule.type+'\0'+rule.id+'\0'+key);if(this.find('event',id))return;
    if(rule.eventCount>=200){rule.sourceStopped=true;rule.error='event_source_limit';return;}
    if(rule.type==='file')for(const d of this.pending().filter(d=>d.ruleId===rule.id))this.put('delivery',{...d,status:'ignored',reason:'superseded'});
    const event={id,type:rule.type==='file'?'file.changed':'github.comment',createdAt:this.now(),data};
    this.put('event',event);this.deliver(rule,event);rule.eventCount++;
  }
  dispatch(){
    if(this.tasks.closed||this.tasks.applying)return;
    for(const delivery of this.pending()){
      const rule=this.tasks.row('rule',delivery.ruleId),task=this.tasks.row('task',delivery.taskId),event=this.tasks.row('event',delivery.eventId);
      if(!this.usable(rule)){this.put('delivery',{...delivery,status:'ignored',reason:rule.enabled?'rule_exhausted':'rule_disabled'});continue;}
      if(rule.type==='check'&&event.data.parentRunId!==task.runId){this.put('delivery',{...delivery,status:'ignored',reason:'source_run_superseded'});continue;}
      let reason;
      if(task.automationPaused)reason='automation_paused';
      else if(active.has(task.status))reason='task_busy';
      else if(!['completed','waiting_event','paused'].includes(task.status))reason='manual_continuation_required';
      else if(!this.tasks.summary(task).canContinue)reason='cleanup_unconfirmed';
      else if(this.tasks.all().filter(t=>active.has(t.status)).length>=100)reason='queue_full';
      if(reason){if(delivery.reason!==reason)this.put('delivery',{...delivery,reason});continue;}
      this.tasks.atomic(()=>{
        const previousRunId=task.runId;delete task.stopIntent;
        this.tasks.newRun(task,this.tasks.row('run',previousRunId).number+1,rule.instruction,{trigger:{ruleId:rule.id,eventId:event.id,deliveryId:delivery.id,previousRunId},eventContext:event});
        this.put('rule',{...rule,usedRuns:rule.usedRuns+1,lastTriggeredAt:this.now()});
        this.put('delivery',{...delivery,status:'dispatched',reason:null,runId:task.runId,dispatchedAt:this.now()});
      });
      this.tasks.changed(task);
    }
  }
  tick(){
    this.dispatch();
    if(!this.polling&&this.now()>=this.nextPoll){this.nextPoll=this.now()+1000;this.polling=this.poll().finally(()=>{this.polling=null;});this.polling.catch(()=>{});}
  }
  async poll(){
    for(const original of this.rows('rule').filter(r=>this.usable(r)&&['file','github'].includes(r.type))){
      if(this.controller.signal.aborted)return;
      let rule=this.tasks.row('rule',original.id);
      if(rule.type==='github'&&rule.sourceState.nextPollAt>this.now())continue;
      try{
        if(rule.type==='file'){
          const observation=fileObservation(this.tasks.workspace,rule.source.paths),state=rule.sourceState;
          if(observation.digest===state.baseline){if(state.candidate)delete state.candidate;else continue;}
          else if(state.candidate?.digest!==observation.digest)state.candidate={digest:observation.digest,since:this.now()};
          else if(this.now()-state.candidate.since>=2000){
            this.tasks.atomic(()=>{this.publishSource(rule,{files:observation.files,workspace:this.tasks.workspace},String(rule.eventCount)+':'+observation.digest);rule.sourceState={baseline:observation.digest};if(!rule.sourceStopped)rule.error=null;this.put('rule',rule);});continue;
          }
          this.put('rule',rule);
        }else{
          const started=this.now();
          const comments=await githubComments(rule.source,{since:rule.sourceState.since,tokenPath:this.githubTokenPath,workspace:this.tasks.workspace,fetcher:this.fetcher,signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(15000)])});
          if(this.controller.signal.aborted)return;
          const current=this.tasks.row('rule',rule.id);if(current.revision!==rule.revision||!this.usable(current))continue;rule=current;
          this.tasks.atomic(()=>{for(const comment of comments)this.publishSource(rule,{...comment,repository:rule.source.repository,number:rule.source.number},String(comment.id));rule.sourceState={since:Math.max(rule.createdAt,started-1000),nextPollAt:this.now()+60000};if(!rule.sourceStopped)rule.error=null;this.put('rule',rule);});
        }
      }catch(error){
        if(this.controller.signal.aborted)return;
        const current=this.tasks.row('rule',rule.id);if(current.revision!==rule.revision||!this.usable(current))continue;rule=current;
        rule.error=/^(github_|event_|invalid_github_)/.test(String(error.message))?error.message:'event_source_unavailable';
        rule.sourceState.failures=(rule.sourceState.failures||0)+1;
        rule.sourceState.nextPollAt=this.now()+Math.min(3600000,Math.max(error.retryAfterMs||0,60000*2**Math.min(6,rule.sourceState.failures-1)));
        if(rule.type==='file')rule.sourceStopped=true;this.put('rule',rule);
      }
    }
  }
  async close(){this.controller.abort();await this.polling?.catch(()=>{});}
}
