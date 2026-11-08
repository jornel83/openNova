/** Coordinate Bot-owned bindings, durable skill drafts and ordinary task execution. */
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {SkillStore} from './store.mjs';
import {prepareReviewEvidence} from '../team/review.mjs';
import {readJson} from '../tasks/agent-files.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const idValid=value=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value);
const ended=new Set(['completed','failed','cancelled','interrupted','paused','waiting_input','waiting_event']);
export class SkillService {
  constructor({db,home,root,team,tasks,events}){
    Object.assign(this,{db,home,root,team,tasks,events});this.store=new SkillStore({db,home,root,team,tasks,events});
    db.exec("CREATE TABLE IF NOT EXISTS opennova_skill_learning (id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS skill_learning_status ON opennova_skill_learning(json_extract(body,'$.status')); CREATE TABLE IF NOT EXISTS opennova_skill_learning_action (id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS opennova_skill_sync (id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS skill_sync_status ON opennova_skill_sync(json_extract(body,'$.status'))");
    this.ticking=false;this.nextTick=0;
  }
  catalog(args){
    const value=this.store.catalog(args),items=this.syncRows().filter(item=>item.status!=='completed').map(({id,status,error,nextAttemptAt})=>({id,status,error,nextAttemptAt}));
    return {...value,sync:{pending:items.filter(item=>item.status==='pending').length,blocked:items.filter(item=>item.status==='blocked').length,items},
      problems:[...value.problems,...items.map(item=>({name:'技能同步',error:item.error??'skill_sync_pending',status:item.status})),...(this.syncFailure?[{name:'技能同步',error:this.syncFailure,status:'pending'}]:[])]};
  }
  get(id){const row=this.db.prepare('SELECT body FROM opennova_skill_learning WHERE id=?').get(id);return row?JSON.parse(row.body):null;}
  put(value){this.db.prepare('INSERT INTO opennova_skill_learning VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(value.id,JSON.stringify(value));return value;}
  async mirror(){
    for(const summary of this.store.catalog({includeDisabled:true}).skills){
      const skill=this.store.get(summary.name),body={name:skill.name,kind:'skill',description:skill.description,content:skill.content,
        enabled:skill.enabled,resourceBase:skill.resourceBase,skillVersion:skill.version,invocation:{modelInvocable:skill.invocation?.model!==false,userInvocable:skill.invocation?.user!==false}};
      const previous=this.team.rt.state.capabilities?.items?.[skill.name];
      if(previous&&previous.kind!=='skill')throw Error('skill_capability_conflict');
      if(!previous||Object.keys(body).some(key=>JSON.stringify(previous[key])!==JSON.stringify(body[key])))await this.team.rt.capabilitySave(body,{botId:this.team.chiefId});
    }
  }
  async initialize(){
    this.store.transaction(()=>{
      for(const op of this.store.pendingAssignments())this.queueSync('assignment-'+op.input.actionId,[op.input.actionId]);
      if(!this.store.row('chief-builtins')){
        const current=this.store.assignment(this.team.chiefId),names=[...new Set([...current.names,...this.store.catalog({}).skills.filter(skill=>skill.source==='bundled').map(skill=>skill.name)])];
        if(names.length){const body={action:'assign',actionId:'m5-initial-chief-skills',botId:this.team.chiefId,names,revision:current.revision};this.store.prepareAssignment(body);this.queueSync('initial-chief',[body.actionId]);}
        this.store.put('chief-builtins',{kind:'bootstrap',completed:true});
      }
      this.queueMirror();
    });
    await this.synchronize(true);
  }
  async applyAssignment(body){
    const operation=this.store.prepareAssignment(body);if(operation.status==='completed')return this.store.mutate(body);
    const committed=this.store.row('binding:'+body.botId);
    if(committed&&committed.revision>operation.selection.revision){this.store.put('action:'+body.actionId,{...operation,status:'superseded',error:'skill_assignment_changed'});return {superseded:true};}
    const current=this.store.assignment(body.botId).names;
    for(const name of operation.selection.names)if(!this.store.head(name).enabled&&!current.includes(name))throw Error('skill_not_available');
    const possible=new Set([...operation.selection.previous,...operation.selection.names]);
    if(current.some(name=>!possible.has(name))||operation.selection.previous.filter(name=>operation.selection.names.includes(name)).some(name=>!current.includes(name)))throw Error('skill_assignment_changed');
    for(const name of new Set([...current,...operation.selection.names])){
      const attached=operation.selection.names.includes(name);
      if(attached!==current.includes(name))await this.team.rt.capabilityEndpoint('bot-capability',{botId:body.botId,name,attached});
    }
    return this.store.mutate(body);
  }
  async assign(body){return this.mutate(body);}
  async mutate(body){
    if(this.syncing)await this.syncing;
    let replayed=false;
    const result=this.store.transaction(()=>{
      if(body.action==='assign'){
        const operation=this.prepareBinding(body);replayed=['completed','superseded'].includes(operation.status);
        if(!replayed)this.queueSync('assignment-'+body.actionId,[body.actionId]);
        return operation.result??operation.selection;
      }
      const value=this.store.mutate(body);replayed=!!value.replayed;
      if(!replayed)this.queueMutation(body,value.result);
      return value.result;
    });
    await this.synchronize(true);
    return {...this.catalog({includeDisabled:true}),result:this.store.row('action:'+body.actionId)?.result??result,...replayed?{replayed:true}:{}};
  }
  syncRows(){return this.db.prepare("SELECT body FROM opennova_skill_sync WHERE json_extract(body,'$.status') IN ('pending','blocked') ORDER BY rowid").all().map(row=>JSON.parse(row.body));}
  putSync(value){this.db.prepare('INSERT INTO opennova_skill_sync VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(value.id,JSON.stringify(value));return value;}
  queueSync(key,assignments=[]){const id='sync-'+hash(key),old=this.db.prepare('SELECT body FROM opennova_skill_sync WHERE id=?').get(id);if(old)return JSON.parse(old.body);return this.putSync({id,status:'pending',assignments,createdAt:Date.now(),nextAttemptAt:0});}
  queueMirror(){const state=this.store.catalog({includeDisabled:true}).skills.map(({name,version,enabled})=>({name,version,enabled}));return this.queueSync('mirror-'+hash(JSON.stringify(state)));}
  prepareBinding(body){
    const old=this.store.row('action:'+body.actionId),operation=this.store.prepareAssignment(body);
    if(!old)for(const pending of this.store.pendingAssignments())if(pending.input.botId===body.botId&&pending.input.actionId!==body.actionId)this.store.put('action:'+pending.input.actionId,{...pending,status:'superseded',supersededBy:body.actionId});
    for(const entry of this.syncRows())if(entry.status==='blocked'&&entry.assignments.length&&entry.assignments.every(id=>['completed','superseded'].includes(this.store.row('action:'+id)?.status)))this.putSync({...entry,status:'completed',error:undefined,finishedAt:Date.now()});
    return operation;
  }
  queueMutation(body,result){
    const assignments=[];
    if(['save','promote'].includes(body.action)&&result?.enabled){
      const botIds=new Set([this.team.chiefId]);
      if(body.action==='promote'){
        const candidate=this.store.row(body.candidateId),report=candidate&&this.tasks.reports.get(candidate.source.reportId);
        if(report?.assignedBotId)botIds.add(report.assignedBotId);
      }
      for(const botId of botIds){
        const actionId='default-'+hash(body.actionId+'\0'+botId),old=this.store.row('action:'+actionId);
        if(old){assignments.push(actionId);continue;}
        const current=this.store.assignment(botId),pending=this.store.pendingAssignments().filter(item=>item.input.botId===botId).at(-1),names=pending?.selection.names??current.names;
        if(names.includes(result.name))continue;
        const assignment={action:'assign',actionId,botId,names:[...names,result.name],revision:current.revision};
        this.prepareBinding(assignment);assignments.push(actionId);
      }
    }
    this.queueSync('mutation-'+body.actionId,assignments);
  }
  synchronize(force=false){
    if(this.syncing)return this.syncing;
    this.syncing=(async()=>{
      for(const entry of this.syncRows().filter(item=>item.status==='pending'&&(force||item.nextAttemptAt<=Date.now()))){
        if(this.tasks.closed)return;
        try{
          await this.mirror();
          for(const id of entry.assignments){if(this.tasks.closed)return;const action=this.store.row('action:'+id);if(!action)throw Error('skill_assignment_missing');if(action.status==='superseded')continue;await this.applyAssignment(action.input);}
          this.putSync({...entry,status:'completed',error:undefined,finishedAt:Date.now()});this.store.changed();
        }catch(error){
          const message=String(error.message).slice(0,200),status=['skill_assignment_changed','skill_not_available','unknown_team_member'].includes(message)?'blocked':'pending';
          this.putSync({...entry,status,error:message,nextAttemptAt:Date.now()+1000});
          if(entry.error!==message||entry.status!==status)this.store.changed();
        }
      }
      this.syncFailure=null;
    })().finally(()=>{this.syncing=null;});return this.syncing;
  }
  accepted(review){
    if(review.status!=='accepted')return;
    const task=this.tasks.row('task',review.taskId);if(task.managementReview||task.kind!=='agent'||['closing','closed'].includes(task.closure?.status))return;
    if(task.runId!==review.runId||(task.assignmentVersion??1)!==(review.assignmentVersion??1)||this.tasks.reports.currentId(task)!==review.reportId)return;
    const run=this.tasks.row('run',review.runId);
    if(run.skills?.length)this.store.recordUsage({taskId:task.id,runId:run.id,skills:run.skills,status:'accepted',reviewId:review.id});
    if(!this.store.policy().autoCandidate)return;
    const id='learn-'+hash(review.id);if(!this.get(id))this.put({id,source:{taskId:task.id,runId:review.runId,reportId:review.reportId,reviewId:review.id},status:'pending',createdAt:Date.now()});
  }
  candidate(body){
    const {taskId,runId,reportId,reviewId,actionId}=body;
    if(![taskId,runId,reportId,reviewId,actionId].every(idValid))throw Error('invalid_skill_candidate');
    const signature=hash(JSON.stringify([taskId,runId,reportId,reviewId])),receipt=this.db.prepare('SELECT body FROM opennova_skill_learning_action WHERE id=?').get(actionId);
    if(receipt){const old=JSON.parse(receipt.body);if(old.signature!==signature)throw Error('skill_action_conflict');const entry=this.get(old.learningId);return {candidate:this.store.row(entry?.candidateId),learning:entry,replayed:true};}
    const task=this.tasks.row('task',taskId),report=this.tasks.reports.get(reportId,{fresh:true}),review=this.tasks.supervisor.get(reviewId);
    if(task.runId!==runId)throw Error('task_run_changed');this.store.assertAccepted(task,report,review);
    const id='learn-'+hash(reviewId),previous=this.get(id);
    const learning=this.store.transaction(()=>{
      const value=previous?.status==='running'||previous?.status==='completed'?previous:this.put({...previous,id,source:{taskId,runId,reportId,reviewId},status:'pending',manual:true,lastActionId:actionId,attempt:(previous?.attempt??0)+1,error:undefined,finishedAt:undefined,createdAt:previous?.createdAt??Date.now()});
      this.db.prepare('INSERT INTO opennova_skill_learning_action VALUES (?,?)').run(actionId,JSON.stringify({signature,learningId:id,createdAt:Date.now()}));return value;
    });
    this.tick(true);return {candidate:this.store.row(this.get(id)?.candidateId),learning};
  }
  tick(force=false){
    if(this.ticking||this.syncing||!force&&Date.now()<this.nextTick||this.tasks.closed)return;
    this.nextTick=Date.now()+1000;this.ticking=true;
    try{
      const rows=this.db.prepare("SELECT body FROM opennova_skill_learning WHERE json_extract(body,'$.status') IN ('pending','running') ORDER BY rowid LIMIT 10").all();
      for(const row of rows){let entry=JSON.parse(row.body);
        try{
          const task=this.tasks.row('task',entry.source.taskId),report=this.tasks.reports.get(entry.source.reportId,{fresh:true}),review=this.tasks.supervisor.get(entry.source.reviewId);
          this.store.assertAccepted(task,report,review);
          if(entry.status==='pending'){
            const candidate=this.store.observeAccepted(task,report,review,{force:entry.manual});if(!candidate){this.put({...entry,status:'skipped'});continue;}
            const internalId='skill-draft-'+hash(entry.id+':'+(entry.attempt??0)).slice(0,40),directory=join(this.home,'skills','evidence',internalId);
            prepareReviewEvidence({task,report,directory});
            const managementReview={kind:'skill-extraction',candidateId:candidate.id,candidateRevision:candidate.revision,reviewId:review.id,reportId:report.id,targetTaskId:task.id,targetRunId:task.runId,assignmentVersion:task.assignmentVersion??1,evidenceDirectory:directory};
            entry=this.put({...entry,candidateId:candidate.id,internalId,managementReview,status:'running'});
            this.tasks.create({id:internalId,kind:'agent',assignedBotId:this.team.chiefId,title:'整理技能：'+task.title.slice(0,130),goal:'阅读 report.json 及必要成果，提炼可复用方法，并调用 skill_draft 提交参数化技能草稿。',
              constraints:'只读现有证据；不执行原业务、不修改来源、不重新生成视频。将具体名称和路径参数化，不保存凭据或原始私有内容。',workspaceMode:'general',permission:'read-only',managementEnabled:false},{source:'supervisor',managementReview});
            this.store.put(candidate.id,{...candidate,status:'refining',error:undefined});this.store.changed();
          }else{
            let internal;try{internal=this.tasks.row('task',entry.internalId);}catch{
              this.put({...entry,status:'pending'});continue;
            }
            if(!ended.has(internal.status))continue;
            const run=this.tasks.row('run',internal.runId),job=this.tasks.row('job',run.jobId);
            if(!job.cleanupConfirmed)continue;
            const receipt=readJson(join(this.tasks.directory(job),'skill-draft.json'));
            if(internal.status!=='completed'||receipt?.managementRunId!==run.id||receipt.candidateId!==entry.candidateId||receipt.candidateRevision!==entry.managementReview.candidateRevision||receipt.reportId!==entry.source.reportId||receipt.reviewId!==entry.source.reviewId||receipt.targetTaskId!==entry.source.taskId||receipt.targetRunId!==entry.source.runId||receipt.assignmentVersion!==entry.managementReview.assignmentVersion)throw Error('skill_draft_incomplete');
            this.store.transaction(()=>{
              const candidate=this.store.refineCandidate({candidateId:entry.candidateId,revision:entry.managementReview.candidateRevision,
                source:{...entry.source,assignmentVersion:entry.managementReview.assignmentVersion},actionId:'draft-'+hash(run.id),...receipt.draft});
              if(candidate.status==='promoted')this.queueMutation({action:'promote',actionId:'auto-'+hash(candidate.id+':'+candidate.revision),candidateId:candidate.id},this.store.head(candidate.skillName));
              this.put({...entry,status:'completed',finishedAt:Date.now()});
            });
          }
        }catch(error){
          if(entry.internalId)try{const internal=this.tasks.row('task',entry.internalId);if(['queued','blocked','running','pausing'].includes(internal.status))this.tasks.cancel(internal.id,internal.runId);}catch{}
          this.put({...entry,status:'failed',error:String(error.message).slice(0,200),finishedAt:Date.now()});
          const candidate=entry.candidateId&&this.store.row(entry.candidateId);if(candidate)this.store.put(candidate.id,{...candidate,status:'failed',error:String(error.message).slice(0,200)});
          this.store.changed();
        }
      }
    }finally{this.ticking=false;void this.synchronize(force).catch(error=>{this.syncFailure=String(error.message).slice(0,200);});}
  }
}
