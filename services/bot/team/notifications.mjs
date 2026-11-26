/** Durable assistant-only task reports. Speech is claimed once, never replayed. */
import {createHash} from 'node:crypto';
import {taskIsClosed} from '../tasks/closure.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const terminalReview=new Set(['needs_user','budget_exhausted','failed']);
const ident=value=>typeof value==='string'&&/^[\w-]{1,128}$/.test(value);
const captureAllowsSpeech=value=>['listening','muted'].includes(value);
const interruptsSpeech=control=>control.status==='queued'&&!['mute','unmute'].includes(control.action);
const clean=(value,max=180)=>String(value??'').replace(/```[\s\S]*?```/g,'[代码片段]').replace(/```[^\n]*\n?/g,' ').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
  .replace(/(?:https?:\/\/|\/Users\/|\/home\/|\/private\/|\/var\/|[A-Za-z]:\\)\S+/g,'[引用]')
  .replace(/\b(?:Bearer\s+\S+|(?:sk-|sk_)[A-Za-z0-9_-]{12,})/gi,'[凭据已隐藏]')
  .replace(/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,'[凭据已隐藏]')
  .replace(/[*#`<>]/g,'').replace(/\s+/g,' ').trim().slice(0,max);

export class TaskNotifications {
  constructor({ops,tasks,events,voice,projects,foregroundBusy=()=>false,now=Date.now,voiceTtlMs=120000}){
    Object.assign(this,{ops,tasks,events,voice,projects,foregroundBusy,now,voiceTtlMs,db:ops.db,pending:new Set()});
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_notification_state (id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS records_conversation_created ON records(json_extract(body,'$.createdAt') DESC) WHERE kind IN ('request','task_notification')`);
    // Voice leases are process-local. Text remains durable, but a restarted host
    // must never replay audio whose actual playback is unknowable.
    for(const record of ops.list('task_notification'))if(record.voiceStatus==='pending')this.save({...record,voiceStatus:'skipped',voiceReason:'host_restarted'});
    const initialized=this.seen('initialized');
    for(const task of tasks.all())this.observe(task,{baseline:!initialized,recovery:true});
    this.db.prepare('INSERT OR IGNORE INTO task_notification_state VALUES (?,?)').run('initialized',JSON.stringify({at:now()}));
  }
  seen(id){return !!this.db.prepare('SELECT id FROM task_notification_state WHERE id=?').get(id);}
  remember(id){this.db.prepare('INSERT OR IGNORE INTO task_notification_state VALUES (?,?)').run(id,JSON.stringify({at:this.now()}));}
  save(record){this.ops.put(record);return record;}
  changed(task){
    try{
      this.observe(task);
      // A task closing/rework transition permanently retires pending speech;
      // reopening the same run later cannot resurrect an old announcement.
      for(const row of this.db.prepare("SELECT body FROM records WHERE kind='task_notification' AND json_extract(body,'$.taskId')=? AND json_extract(body,'$.voiceStatus')='pending'").all(task.id)){
        const record=JSON.parse(row.body);if(!this.valid(record))this.save({...record,voiceStatus:'skipped',voiceReason:'task_updated'});
      }
      this.pending.delete(task.id);if(!this.pending.size)this.lastError=null;
    }
    catch(error){this.pending.add(task.id);this.lastError=String(error.message);}
  }
  tick(){for(const id of [...this.pending].slice(0,10))this.changed(this.tasks.row('task',id));}
  current(task,{verify=false}={}){
    if(!task||task.managementReview||task.parentTaskId||taskIsClosed(task)||this.tasks.closureAncestor?.(task))return null;
    const reportId=this.tasks.reports.currentId(task),report=reportId?this.tasks.reports.raw(reportId):null;
    if(!report)return null;
    const review=this.tasks.supervisor?.history(task.id).find(r=>r.reportId===reportId&&r.runId===task.runId&&r.assignmentVersion===(task.assignmentVersion??1));
    let status,reason;
    if(review?.status==='accepted'){
      if(task.status!=='completed'||verify&&this.tasks.supervisor.summary(task).reviewStatus!=='accepted')return null;
      status='accepted';reason=clean(report.summary,160);
    }else if(terminalReview.has(review?.status)&&['completed','waiting_input','failed','interrupted','paused'].includes(task.status)){
      status='needs_user';reason=review.status==='budget_exhausted'?'自动处理已达到本任务的执行预算，需要你决定是否继续。':
        clean(review.decision?.summary)||'自动验收未能完成，需要你查看任务详情并决定下一步。';
    }else if(task.status==='interrupted'||(!task.management?.enabled||task.management.paused)&&['completed','waiting_input','failed'].includes(task.status)){
      status='needs_user';reason=task.status==='completed'?'任务已执行完成，自动检查未开启，请查看成果并验收。':clean(report.question||report.summary||'任务需要你确认下一步。');
    }
    if(!status)return null;
    const id='notice-'+hash(JSON.stringify([task.id,task.runId,task.assignmentVersion??1,reportId,status]));
    return {id,task,report,review,status,reason};
  }
  observe(task,{baseline=false,recovery=false}={}){
    if(this.tasks.closed)return;
    const state=this.current(task);if(!state||this.seen(state.id))return;
    if(baseline){this.remember(state.id);return;}
    if(!this.current(task,{verify:true}))return;
    const {id,report,review,status,reason}=state,title=clean(task.title,100)||'后台任务',ownerName=clean(this.tasks.team?.owner?.(task)?.ownerName,40);
    const artifacts=(report.artifacts??[]).filter(a=>a.status==='available').map(a=>({id:a.id,name:clean(a.name,100)})).slice(0,10);
    const projectName=task.projectId&&this.projects?.store.get(task.projectId)?.name;
    const subject=(projectName?`「${clean(projectName,60)}」`:'')+(ownerName?ownerName+'的':'')+`“${title}”`,heading=status==='accepted'?`${subject}已完成并通过验收。`:`${subject}需要你处理。`;
    const files=artifacts.length?'成果：'+artifacts.map(a=>a.name).join('、')+'。':'';
    const currentVoice=this.voice?.snapshot(),target=!recovery&&this.inFocus(task)&&currentVoice?.connected?currentVoice.voiceInstanceId:null;
    const record={id,kind:'task_notification',role:'assistant',source:'task',status:'completed',text:[heading,reason,files].filter(Boolean).join('\n'),
      speechText:[heading,clean(reason,90),artifacts.length?'成果已保存在任务详情。':''].filter(Boolean).join(' ').slice(0,240),createdAt:this.now(),
      projectId:task.projectId,projectName,taskId:task.id,taskTitle:title,runId:task.runId,reportId:report.id,assignmentVersion:task.assignmentVersion??1,assignedBotId:task.assignedBotId,ownerName,
      notificationStatus:status,reviewId:review?.id,originRequestId:task.requestId,artifacts,
      voiceInstanceId:target,voiceStatus:target?'pending':'skipped',voiceExpiresAt:this.now()+this.voiceTtlMs,...(!target?{voiceReason:recovery?'recovered_text_only':'voice_not_connected'}:{})};
    // Both inserts share the caller's SQLite transaction if there is one. The
    // record's stable primary key also handles a crash before the seen marker.
    if(!this.db.prepare("SELECT id FROM records WHERE id=? AND kind='task_notification'").get(id))this.save(record);
    this.remember(id);this.events?.publish('task.notification',{id,taskId:task.id});
    return this.ops.get(id);
  }
  valid(record){
    try{return this.current(this.tasks.row('task',record.taskId),{verify:true})?.id===record.id;}catch{return false;}
  }
  present(record){return {...record,notificationObsolete:!this.valid(record)};}
  conversation(limit=50,{projectId,unclassified=false}={}){
    const clause=unclassified?" AND json_type(body,'$.projectId') IS NULL":projectId===null?" AND json_type(body,'$.projectId')='null'":projectId!==undefined?" AND json_extract(body,'$.projectId')=?":'';
    const rows=this.db.prepare("SELECT body FROM records WHERE kind IN ('request','task_notification')"+clause+" ORDER BY json_extract(body,'$.createdAt') DESC,rowid DESC LIMIT ?").all(...(!unclassified&&projectId!=null?[projectId]:[]),limit+1).map(r=>JSON.parse(r.body));
    return {messages:rows.slice(0,limit).reverse().map(r=>r.kind==='task_notification'?this.present(r):r),hasMore:rows.length>limit};
  }
  context(before=this.now(),projectId){
    if(this.projects&&projectId==null)return [];
    const clause=this.projects?" AND json_extract(body,'$.projectId')=?":'';
    return this.db.prepare("SELECT body FROM records WHERE kind='task_notification' AND json_extract(body,'$.createdAt')<=?"+clause+" ORDER BY json_extract(body,'$.createdAt') DESC,rowid DESC LIMIT 5").all(before,...(this.projects?[projectId]:[])).map(row=>{
      const r=this.present(JSON.parse(row.body));return {id:r.id,taskId:r.taskId,taskTitle:r.taskTitle,runId:r.runId,reportId:r.reportId,notificationStatus:r.notificationStatus,notificationObsolete:r.notificationObsolete,text:r.text};
    });
  }
  inFocus(record){const state=this.projects?.state();return !state||state.focus==='work'&&record.projectId===state.projectId;}
  focusChanged(){
    for(const record of this.ops.list('task_notification'))if(['pending','claimed'].includes(record.voiceStatus)&&!this.inFocus(record))this.save({...record,voiceStatus:'skipped',voiceReason:'conversation_focus_changed'});
  }
  voiceReady(instanceId){
    if(!ident(instanceId)||this.foregroundBusy()||this.tasks.closed)return false;
    const state=this.voice?.snapshot();
    return !!(state?.connected&&state.voiceInstanceId===instanceId&&captureAllowsSpeech(state.capture)&&state.recognition==='idle'&&state.playback==='idle'&&!state.draft&&!state.requestId&&!state.controls?.some(c=>c.status==='queued'));
  }
  eligible(record,instanceId){
    return record?.kind==='task_notification'&&this.inFocus(record)&&record.voiceStatus==='pending'&&record.voiceInstanceId===instanceId&&record.voiceExpiresAt>this.now()&&this.valid(record);
  }
  next({voiceInstanceId,excludeIds=[]}){
    if(!Array.isArray(excludeIds)||excludeIds.length>256||excludeIds.some(value=>!ident(value)))throw Error('invalid_task_notification_exclusions');
    if(!this.voiceReady(voiceInstanceId))return {notification:null};
    const excluded=new Set(excludeIds);
    // Iterate beyond obsolete rows; a stale backlog must not starve new speech.
    const rows=this.db.prepare("SELECT body FROM records WHERE kind='task_notification' AND json_extract(body,'$.voiceStatus')='pending' AND json_extract(body,'$.voiceInstanceId')=? AND json_extract(body,'$.voiceExpiresAt')>? ORDER BY rowid").iterate(voiceInstanceId,this.now());
    for(const row of rows){const record=JSON.parse(row.body);if(!excluded.has(record.id)&&this.eligible(record,voiceInstanceId))return {notification:this.present(record)};}
    return {notification:null};
  }
  claim({id,voiceInstanceId}){
    if(!ident(id)||!this.voiceReady(voiceInstanceId))return {notification:null};
    let record;try{record=this.ops.get(id);}catch{return {notification:null};}
    if(!this.eligible(record,voiceInstanceId))return {notification:null};
    const claimed={...record,voiceStatus:'claimed',voiceClaimedAt:this.now()};
    const change=this.db.prepare("UPDATE records SET body=? WHERE id=? AND kind='task_notification' AND json_extract(body,'$.voiceStatus')='pending'").run(JSON.stringify(claimed),id);
    return {notification:change.changes?this.present(claimed):null};
  }
  active({id,voiceInstanceId}){
    if(!ident(id)||!ident(voiceInstanceId)||this.foregroundBusy()||this.tasks.closed)return {valid:false};
    const state=this.voice?.snapshot();
    if(!state?.connected||state.voiceInstanceId!==voiceInstanceId||!captureAllowsSpeech(state.capture)||state.recognition!=='idle'||state.draft||state.requestId||state.playback==='error'||state.controls?.some(interruptsSpeech))return {valid:false};
    let record;try{record=this.ops.get(id);}catch{return {valid:false};}
    return {valid:record.kind==='task_notification'&&this.inFocus(record)&&record.voiceStatus==='claimed'&&record.voiceInstanceId===voiceInstanceId&&record.voiceExpiresAt>this.now()&&this.valid(record)};
  }
  ack({id,voiceInstanceId,status}){
    if(!ident(id)||!ident(voiceInstanceId)||!['played','interrupted','failed','skipped'].includes(status))throw Error('invalid_task_notification_ack');
    let record;try{record=this.ops.get(id);}catch{return {acknowledged:false};}
    if(record.kind!=='task_notification'||record.voiceInstanceId!==voiceInstanceId||record.voiceStatus!=='claimed')return {acknowledged:false};
    this.save({...record,voiceStatus:status,voiceFinishedAt:this.now()});return {acknowledged:true};
  }
}
