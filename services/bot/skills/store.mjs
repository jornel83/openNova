/** Skill versions live beside private task data; Bot remains the member binding owner. */
import {readdirSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {captureBundle,editedBundle,archiveBundle,verifySkillSnapshot,skillNameValid,skillDocument,digest} from './bundle.mjs';
import {experienceCandidate} from './experience.mjs';
import {saveJson} from '../tasks/agent-files.mjs';

const idValid=value=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value);
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const fingerprint=body=>digest(JSON.stringify(stable(body))??'undefined');
const clone=value=>JSON.parse(JSON.stringify(value));
const statusValid=new Set(['queued','running','completed','failed','interrupted','cancelled','paused','waiting_input','waiting_event','accepted','changes_requested','needs_user']);
export const SKILL_DEFAULTS={revision:1,autoCandidate:true,autoEnable:false};

export class SkillStore {
  constructor({db,home,root,events,team,tasks,now=Date.now}){
    Object.assign(this,{db,home,root,events,team,tasks,now});this.problems=[];this.sequence=0;
    db.exec(`CREATE TABLE IF NOT EXISTS opennova_skill_record (id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS opennova_skill_kind ON opennova_skill_record(json_extract(body,'$.kind'));
      CREATE INDEX IF NOT EXISTS opennova_skill_candidate_source ON opennova_skill_record(json_extract(body,'$.kind'),json_extract(body,'$.source.reportId'),json_extract(body,'$.source.reviewId'));
      CREATE INDEX IF NOT EXISTS opennova_skill_version ON opennova_skill_record(json_extract(body,'$.kind'),json_extract(body,'$.name'),json_extract(body,'$.createdAt'));
      CREATE INDEX IF NOT EXISTS opennova_skill_usage ON opennova_skill_record(json_extract(body,'$.kind'),json_extract(body,'$.taskId'),json_extract(body,'$.runId'))`);
    if(!this.row('policy'))this.put('policy',{kind:'policy',...SKILL_DEFAULTS});
    mkdirSync(join(home,'skills','personal'),{recursive:true,mode:0o700});
    this.refresh();
  }
  row(id){const row=this.db.prepare('SELECT body FROM opennova_skill_record WHERE id=?').get(id);return row?JSON.parse(row.body):null;}
  put(id,value){this.db.prepare('INSERT INTO opennova_skill_record VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id,JSON.stringify(value));return value;}
  rows(kind){return this.db.prepare("SELECT body FROM opennova_skill_record WHERE json_extract(body,'$.kind')=? ORDER BY rowid").all(kind).map(row=>JSON.parse(row.body));}
  transaction(fn){const savepoint='skill_'+(++this.sequence);this.db.exec('SAVEPOINT '+savepoint);try{const value=fn();this.db.exec('RELEASE '+savepoint);return value;}catch(error){this.db.exec('ROLLBACK TO '+savepoint);this.db.exec('RELEASE '+savepoint);throw error;}}
  changed(){this.events?.publish('skills.updated',{});}
  policy(){return this.row('policy');}
  head(name){if(!skillNameValid(name))throw Error('invalid_skill_name');const head=this.row('head:'+name);if(!head)throw Error('unknown_skill');return head;}
  version(name,version){const value=this.row('version:'+name+':'+version);if(!value)throw Error('unknown_skill_version');return value;}
  get(name,{version}={}){const head=this.head(name),value=this.version(name,version??head.version);return {...value,revision:head.revision,enabled:head.enabled,currentVersion:head.version};}
  history(name){const head=this.head(name);return {name,revision:head.revision,versions:this.rows('version').filter(value=>value.name===name).reverse()};}

  refresh(){
    this.problems=[];
    for(const [directory,source] of [[join(this.root,'skills'),'bundled'],[join(this.home,'skills','personal'),'personal']]){
      if(!existsSync(directory))continue;
      for(const entry of readdirSync(directory,{withFileTypes:true}).filter(entry=>!entry.name.startsWith('.'))){
        if(!entry.isDirectory()||entry.isSymbolicLink())continue;
        try{
          const bundle=captureBundle(join(directory,entry.name),{root:this.root,source}),value=archiveBundle(this.home,bundle),old=this.row('head:'+value.name);
          if(old&&old.source!==source)continue;
          this.transaction(()=>{
            this.saveVersion(value);
            if(!old)this.put('head:'+value.name,{kind:'head',name:value.name,version:value.version,lastImportedVersion:value.version,source,enabled:true,revision:1,createdAt:this.now(),updatedAt:this.now()});
            else if(old.lastImportedVersion!==value.version)this.put('head:'+value.name,{...old,version:old.version===old.lastImportedVersion?value.version:old.version,lastImportedVersion:value.version,revision:old.revision+1,updatedAt:this.now()});
          });
        }catch(error){this.problems.push({name:entry.name,error:String(error.code??error.message)});}
      }
    }
    return this.catalog({includeDisabled:true});
  }
  saveVersion(value,provenance){const key='version:'+value.name+':'+value.version;if(!this.row(key))this.put(key,{...value,kind:'version',createdAt:this.now(),...(provenance?{provenance}:{} )});return this.row(key);}

  bot(id){if(!idValid(id))throw Error('invalid_skill_member');const bot=this.team?.bot?.(id)??this.team?.rt?.state?.bots?.[id];if(!bot)throw Error('unknown_team_member');return bot;}
  assignment(botId){
    const bot=this.bot(botId),known=new Set(this.rows('head').map(value=>value.name));
    const names=[...new Set((bot.capabilities??[]).filter(name=>known.has(name)))].sort(),record=this.row('binding:'+botId);
    // External Bot changes are reflected immediately and invalidate old UI revisions.
    const revision=record?.names?.join('\0')===names.join('\0')?record.revision:(record?.revision??0)+1;
    return {botId,names,revision};
  }
  catalog({botId,includeDisabled=false}={}){
    const heads=this.rows('head'),members=this.team?.rt?.state?.bots??{},bindings=Object.keys(members).map(id=>this.assignment(id));
    const assignment=botId?this.assignment(botId):undefined,selected=new Set(assignment?.names??[]);
    const skills=heads.filter(head=>includeDisabled||head.enabled).map(head=>{
      const value=this.version(head.name,head.version);
      return {name:head.name,description:value.description,version:head.version,revision:head.revision,enabled:head.enabled,source:head.source,
        selected:botId?selected.has(head.name):undefined,available:head.enabled&&(!botId||selected.has(head.name)),
        assignedBotIds:bindings.filter(item=>item.names.includes(head.name)).map(item=>item.botId),
        versions:this.history(head.name).versions.map(({version,createdAt,description})=>({version,createdAt,description})),updatedAt:head.updatedAt};
    }).sort((a,b)=>a.name.localeCompare(b.name));
    return {skills,candidates:this.candidates(),policy:this.policy(),bindings,...assignment?{assignment}:{},problems:this.problems};
  }
  validateSelection(task){
    if(task.managementReview)return [];
    const names=task.skillNames;
    if(names!==undefined&&(!Array.isArray(names)||names.length>20||names.some(name=>!skillNameValid(name))||new Set(names).size!==names.length))throw Error('invalid_skill_selection');
    const botId=task.assignedBotId??this.team?.chiefId,assigned=this.assignment(botId).names;
    const selected=names??assigned.filter(name=>this.head(name).enabled);
    if(selected.length>20)throw Error('invalid_skill_selection');
    for(const name of selected)if(!this.head(name).enabled||!assigned.includes(name))throw Error('skill_not_available');
    return [...selected];
  }
  snapshot(task){return this.validateSelection(task).map(name=>{const value=this.get(name);verifySkillSnapshot(value);return clone(value);});}

  validateAssignment(body){
    if(!body||!idValid(body.botId)||!Array.isArray(body.names)||body.names.length>20||body.names.some(name=>!skillNameValid(name))||new Set(body.names).size!==body.names.length)throw Error('invalid_skill_assignment');
    const current=this.assignment(body.botId);
    if(body.revision!==undefined&&body.revision!==current.revision)throw Error('skill_assignment_changed');
    const names=[...body.names].sort();for(const name of names)if(!this.head(name).enabled&&!current.names.includes(name))throw Error('skill_not_available');
    return {...current,previous:current.names,names};
  }
  prepareAssignment(body){
    this.checkAction(body);if(body.action!=='assign')throw Error('invalid_skill_action');
    const key='action:'+body.actionId,old=this.row(key),signature=fingerprint(body);
    if(old){if(old.fingerprint!==signature)throw Error('skill_action_conflict');return old;}
    const selection=this.validateAssignment(body),value={kind:'action',input:clone(body),fingerprint:signature,status:'pending',selection,createdAt:this.now()};
    this.put(key,value);return value;
  }
  pendingAssignments(){return this.rows('action').filter(value=>value.status==='pending'&&value.input?.action==='assign');}
  checkAction(body){
    if(!body||!idValid(body.actionId)||!['save','promote','enable','disable','rollback','assign','policy'].includes(body.action))throw Error('invalid_skill_action');
    const fields={save:['name','description','content','enabled'],promote:['candidateId','name','description','content','enabled'],enable:['name'],disable:['name'],rollback:['name','version'],assign:['botId','names'],policy:['autoCandidate','autoEnable']};
    const allowed=new Set(['action','actionId','revision',...fields[body.action]]);
    if(Object.keys(body).some(key=>!allowed.has(key)))throw Error('invalid_skill_action');
  }
  checkRevision(body,head){if(head&&body.revision!==head.revision)throw Error('skill_changed');if(!head&&body.revision!==undefined&&body.revision!==0)throw Error('skill_changed');}

  mutate(body){
    this.checkAction(body);const key='action:'+body.actionId,signature=fingerprint(body),old=this.row(key);
    if(old&&old.fingerprint!==signature)throw Error('skill_action_conflict');
    if(old?.status==='completed')return {...this.catalog({includeDisabled:true}),result:old.result,replayed:true};
    const result=this.transaction(()=>{
      let result;
      if(body.action==='assign'){
        const selection=old?.selection??this.validateAssignment(body),current=this.assignment(body.botId);
        if(current.names.join('\0')!==selection.names.join('\0'))throw Error('skill_assignment_not_applied');
        result={botId:body.botId,names:selection.names,revision:Math.max(selection.revision+1,current.revision)};
        this.put('binding:'+body.botId,{kind:'binding',...result,updatedAt:this.now()});
      }else if(body.action==='policy'){
        const current=this.policy();if(body.revision!==current.revision)throw Error('skill_policy_changed');
        for(const name of ['autoCandidate','autoEnable'])if(body[name]!==undefined&&typeof body[name]!=='boolean')throw Error('invalid_skill_policy');
        result={...current,autoCandidate:body.autoCandidate??current.autoCandidate,autoEnable:body.autoEnable??current.autoEnable,revision:current.revision+1};this.put('policy',result);
      }else if(['enable','disable','rollback'].includes(body.action)){
        const head=this.head(body.name);this.checkRevision(body,head);
        const value=body.action==='rollback'?this.version(body.name,body.version):this.version(body.name,head.version);verifySkillSnapshot(value);
        result={...head,version:value.version,enabled:body.action==='rollback'?head.enabled:body.action==='enable',revision:head.revision+1,updatedAt:this.now()};this.put('head:'+body.name,result);
      }else{
        let candidate;
        if(body.action==='promote'){
          candidate=this.row(body.candidateId);if(candidate?.kind!=='candidate')throw Error('unknown_skill_candidate');
          this.assertCandidateCurrent(candidate);
          if(candidate.status==='promoted')throw Error('skill_candidate_already_promoted');
          if(candidate.status!=='ready'||candidate.ready!==true)throw Error('skill_candidate_not_ready');
        }
        const name=body.name??candidate?.name,description=body.description??candidate?.description,content=body.content??candidate?.content;
        if(!skillNameValid(name))throw Error('invalid_skill_name');
        const head=this.row('head:'+name);this.checkRevision(body,head);
        if(body.enabled!==undefined&&typeof body.enabled!=='boolean')throw Error('invalid_skill');
        const previous=head?this.version(name,head.version):undefined;
        const bundle=editedBundle({name,description,content,previous});bundle.source=candidate?'learned':'personal';
        const value=this.saveVersion(archiveBundle(this.home,bundle),candidate?.source);
        result={kind:'head',name,version:value.version,enabled:body.enabled??true,source:bundle.source,revision:(head?.revision??0)+1,createdAt:head?.createdAt??this.now(),updatedAt:this.now()};
        this.put('head:'+name,result);
        if(candidate){this.put(candidate.id,{...candidate,status:'promoted',skillName:name,skillVersion:value.version,updatedAt:this.now()});saveJson(join(this.home,'skills','candidates',candidate.id+'.json'),this.row(candidate.id));}
      }
      this.put(key,{kind:'action',input:clone(body),fingerprint:signature,status:'completed',result,createdAt:old?.createdAt??this.now(),finishedAt:this.now()});return result;
    });
    this.changed();return {...this.catalog({includeDisabled:true}),result};
  }

  candidates({taskId,projectId,limit=50}={}){
    if(!Number.isInteger(limit)||limit<1||limit>200)throw Error('invalid_skill_page');
    if(projectId!==undefined&&!idValid(projectId))throw Error('invalid_skill_project');
    const sql="SELECT body FROM opennova_skill_record WHERE json_extract(body,'$.kind')='candidate'"+(taskId?" AND json_extract(body,'$.source.taskId')=?":"")+(projectId?" AND json_extract(body,'$.source.projectId')=?":"")+' ORDER BY rowid DESC LIMIT ?';
    return this.db.prepare(sql).all(...(taskId?[taskId]:[]),...(projectId?[projectId]:[]),limit).map(row=>JSON.parse(row.body));
  }
  assertAccepted(task,report,review){
    if(!task||!report||!review||task.kind!=='agent'||task.managementReview||task.parentTaskId||['closing','closed'].includes(task.closure?.status)||task.status!=='completed'||review.status!=='accepted'||report.status!=='completed'||report.taskId!==task.id||report.runId!==task.runId||review.taskId!==task.id||review.runId!==task.runId||review.reportId!==report.id||(report.assignmentVersion??1)!==(task.assignmentVersion??1)||(review.assignmentVersion??1)!==(task.assignmentVersion??1))throw Error('skill_source_not_accepted');
    if(report.evidence?.captureIncomplete||report.evidence?.execution?.cleanupConfirmed===false||(report.artifacts??[]).some(item=>item.status!=='available'||item.sourceStatus&&!['available','unchanged'].includes(item.sourceStatus)))throw Error('skill_source_changed');
    if(this.tasks?.reports?.assertCurrent)this.tasks.reports.assertCurrent(task,report.id);
    if(this.tasks?.supervisor?.summary){const current=this.tasks.supervisor.summary(task);if(current.reviewStatus!=='accepted'||current.reviewVersion!==review.id||current.reportId!==report.id)throw Error('skill_source_changed');}
  }
  assertCandidateCurrent(candidate){
    const source=candidate.source;
    if(!this.tasks?.row||!this.tasks?.reports||!this.tasks?.supervisor)throw Error('skill_source_unavailable');
    const task=this.tasks.row('task',source.taskId),report=this.tasks.reports.get(source.reportId,{fresh:true}),review=this.tasks.supervisor.get(source.reviewId);
    if(source.projectId!==undefined&&source.projectId!==task.projectId)throw Error('skill_candidate_source_changed');
    this.assertAccepted(task,report,review);
  }
  hasObservation(reportId,reviewId){return !!this.db.prepare("SELECT id FROM opennova_skill_record WHERE json_extract(body,'$.kind')='candidate' AND json_extract(body,'$.source.reportId')=? AND json_extract(body,'$.source.reviewId')=? LIMIT 1").get(reportId,reviewId);}
  observeAccepted(task,report,review,{force=false}={}){
    if(!this.policy().autoCandidate&&!force)return null;
    this.assertAccepted(task,report,review);
    const candidate=experienceCandidate(task,report,review,this.now()),old=this.row(candidate.id);if(old)return old;
    saveJson(join(this.home,'skills','candidates',candidate.id+'.json'),candidate);
    this.put(candidate.id,candidate);
    this.changed();
    return this.row(candidate.id);
  }
  /** Accept a draft only from the host's bound, read-only experience run. */
  refineCandidate(body){
    if(!body||!idValid(body.actionId)||!idValid(body.candidateId)||!Number.isSafeInteger(body.revision))throw Error('invalid_skill_candidate');
    const key='action:'+body.actionId,signature=fingerprint(body),old=this.row(key);
    if(old){if(old.fingerprint!==signature)throw Error('skill_action_conflict');return this.row(body.candidateId);}
    const candidate=this.row(body.candidateId);
    if(candidate?.kind!=='candidate')throw Error('unknown_skill_candidate');
    if(fingerprint(body.source)!==fingerprint(candidate.source))throw Error('skill_candidate_source_changed');
    if(candidate.revision!==body.revision||candidate.status==='promoted')throw Error('skill_candidate_changed');
    this.assertCandidateCurrent(candidate);skillDocument(body.name,body.description,body.content);
    if(/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\|\bsk-[A-Za-z0-9_-]{12,}|\bBearer\s+[A-Za-z0-9._-]{8,})/.test(body.description+'\n'+body.content))throw Error('skill_candidate_private_literal');
    const value={...candidate,name:body.name,description:body.description.trim(),content:body.content.trim(),status:'ready',ready:true,revision:candidate.revision+1,updatedAt:this.now()};
    this.transaction(()=>{this.put(candidate.id,value);this.put(key,{kind:'action',fingerprint:signature,status:'completed',result:{candidateId:candidate.id},createdAt:this.now()});});
    saveJson(join(this.home,'skills','candidates',candidate.id+'.json'),value);
    if(this.policy().autoEnable&&!this.row('head:'+value.name))this.mutate({actionId:'auto-'+digest(candidate.id+':'+value.revision),action:'promote',candidateId:candidate.id});
    else this.changed();
    return this.row(candidate.id);
  }
  recordUsage({taskId,runId,skills=[],status,reviewId}){
    if(!idValid(taskId)||!idValid(runId)||!statusValid.has(status)||!Array.isArray(skills)||skills.length>20)throw Error('invalid_skill_usage');
    for(const item of skills){if(!skillNameValid(item.name)||!this.row('version:'+item.name+':'+item.version))throw Error('unknown_skill_version');}
    const id='usage:'+taskId+':'+runId,current=this.row(id),versions=skills.map(({name,version})=>({name,version}));
    if(current&&fingerprint(current.skills)!==fingerprint(versions))throw Error('skill_usage_conflict');
    const result={kind:'usage',taskId,runId,skills:versions,status,...reviewId?{reviewId}:{},createdAt:current?.createdAt??this.now(),updatedAt:this.now()};
    if(current?.status===status&&current?.reviewId===reviewId)return current;
    return this.put(id,result);
  }
}
