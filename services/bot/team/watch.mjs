/** Persistent, deterministic follow-up. Observation never restarts or stops work. */
import {createHash} from 'node:crypto';
import {taskIsClosed} from '../tasks/closure.mjs';
import {closedAncestorSql,hasClosedAncestor} from '../tasks/closure-visibility.mjs';

export const WATCH_DEFAULTS={enabled:true,dueSoonMs:3600000,blockedMs:1800000,inactiveMs:1800000,raiseQueuedPriority:false};
const idOk=value=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actionHash=body=>hash(Object.fromEntries(Object.entries(body).sort(([a],[b])=>a.localeCompare(b))));
const eligible=new Set(['queued','running','blocked','waiting_input','waiting_event']);
const same=(a,b)=>a.runId===b.runId&&(a.assignmentVersion??1)===(b.assignmentVersion??1);
const explain={due_soon:'已进入临近截止时间的提醒范围，请核对完成安排。',overdue:'已超过截止时间，工作尚未执行完成，请核对进展与后续安排。',blocked:'任务持续等待前置条件或事件，请核对阻塞原因。',no_activity:'持续未观察到新的执行进展，请核对当前等待原因；这不代表任务失败或进程已停止。'};

/** Shared current-state predicate for overview/count SQL. Caller filters ack.
 * Real progress files are reconciled by tick(); state/deadline changes are
 * invalidated immediately. nowSql is a trusted SQL expression or parameter.
 */
export function currentWatchAlertSql(taskAlias='t',alertAlias='a',nowSql="CAST(unixepoch('subsec')*1000 AS INTEGER)"){
  if(![taskAlias,alertAlias].every(alias=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)))throw Error('invalid_watch_alias');
  const task=key=>`json_extract(${taskAlias}.body,'$.${key}')`,alert=key=>`json_extract(${alertAlias}.body,'$.${key}')`;
  return `(${alert('taskId')}=${taskAlias}.id AND ${alert('runId')}=${task('runId')}
    AND coalesce(${alert('assignmentVersion')},1)=coalesce(${task('assignmentVersion')},1)
    AND ${alert('status')}='active' AND ${task('managementReview')} IS NULL AND ${task('closure')} IS NULL AND NOT ${closedAncestorSql(taskAlias)}
    AND ${task('status')} IN ('queued','running','blocked','waiting_input','waiting_event')
    AND CASE ${alert('type')}
      WHEN 'due_soon' THEN ${alert('dueAt')}=${task('dueAt')} AND ${task('dueAt')}>(${nowSql})
      WHEN 'overdue' THEN ${alert('dueAt')}=${task('dueAt')} AND ${task('dueAt')}<=(${nowSql})
      WHEN 'blocked' THEN ${task('status')} IN ('blocked','waiting_event') AND ${task('status')}=${alert('anchor[1]')}
        AND ${task('blockedReason')} IS ${alert('blockedReason')}
      WHEN 'no_activity' THEN ${task('status')}='running'
      ELSE 0 END)`;
}

export class TeamWatch {
  constructor({tasks,team=tasks.team,events=tasks.events,now=Date.now}){
    Object.assign(this,{tasks,team,events,now,db:tasks.db});this.lastTick=null;this.ticking=false;this.sequence=0;
    this.db.exec(`CREATE TABLE IF NOT EXISTS team_watch_record (id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_watch_alert (id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_watch_action (id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_watch_alert_active ON team_watch_alert(json_extract(body,'$.status'),json_extract(body,'$.acknowledgedAt'));
      CREATE INDEX IF NOT EXISTS team_watch_alert_task ON team_watch_alert(json_extract(body,'$.taskId'));
      CREATE INDEX IF NOT EXISTS team_watch_action_task ON team_watch_action(json_extract(body,'$.taskId'));
      CREATE INDEX IF NOT EXISTS team_watch_task_status ON background_task(json_extract(body,'$.status'))`);
    if(!this.read('record','policy'))this.write('record','policy',{...WATCH_DEFAULTS,revision:1,updatedAt:this.now()});
  }
  read(kind,id){const row=this.db.prepare(`SELECT body FROM team_watch_${kind} WHERE id=?`).get(id);return row?JSON.parse(row.body):null;}
  write(kind,id,value){this.db.prepare(`INSERT INTO team_watch_${kind} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(id,JSON.stringify(value));return value;}
  atomic(fn){const name='watch_'+(++this.sequence);this.db.exec('SAVEPOINT '+name);try{const result=fn();this.db.exec('RELEASE '+name);return result;}catch(error){this.db.exec('ROLLBACK TO '+name);this.db.exec('RELEASE '+name);throw error;}}
  policy(){return this.read('record','policy');}
  owner(task){return this.team?.owner?.(task)??{assignedBotId:task.assignedBotId??this.team?.chiefId,ownerName:task.ownerName??'总管'};}
  observation(task,at){
    const key='observed:'+task.id,old=this.read('record',key),blockedReason=task.blockedReason??null;
    if(old&&same(old,task)&&old.status===task.status&&old.blockedReason===blockedReason)return old;
    // Legacy blocked tasks have no reliable transition timestamp. Start an
    // observation interval instead of treating their creation date as proof.
    return this.write('record',key,{taskId:task.id,runId:task.runId,assignmentVersion:task.assignmentVersion??1,status:task.status,blockedReason,since:at});
  }
  conditions(task,policy,at,{observe=false}={}){
    if(!policy.enabled||taskIsClosed(task)||task.managementReview||!eligible.has(task.status)||hasClosedAncestor(this.tasks,task))return [];
    const results=[],add=(type,anchor,extra={})=>results.push({type,anchor,...extra});
    if(Number.isSafeInteger(task.dueAt)&&task.dueAt>=0){
      if(at>=task.dueAt)add('overdue',task.dueAt,{dueAt:task.dueAt});
      else if(policy.dueSoonMs>0&&task.dueAt-at<=policy.dueSoonMs)add('due_soon',task.dueAt,{dueAt:task.dueAt});
    }
    if(['blocked','waiting_event'].includes(task.status)){
      const observed=observe?this.observation(task,at):this.read('record','observed:'+task.id);
      if(policy.blockedMs>0&&observed&&same(observed,task)&&observed.status===task.status&&observed.blockedReason===(task.blockedReason??null)&&at-observed.since>=policy.blockedMs)
        add('blocked',[observed.since,task.status,observed.blockedReason],{observedSince:observed.since,blockedReason:task.blockedReason??null});
    }else if(observe&&this.read('record','observed:'+task.id))this.observation(task,at);
    if(task.status==='running'&&policy.inactiveMs>0){
      const run=this.tasks.row('run',task.runId),job=this.tasks.row('job',run.jobId),activity=this.tasks.activity?.(task,run,job);
      const timestamp=Number.isFinite(activity?.lastActivityAt)?activity.lastActivityAt:run.startedAt??run.createdAt??task.createdAt;
      if(Number.isFinite(timestamp)&&timestamp<=at&&at-timestamp>=policy.inactiveMs)add('no_activity',timestamp,{lastActivityAt:timestamp,phase:activity?.phase??(task.kind==='agent'?'model':'command')});
    }
    return results;
  }
  alertId(task,condition){return 'watch-'+hash([task.id,task.runId,task.assignmentVersion??1,condition.type,condition.anchor]);}
  current(alert,policy=this.policy(),at=this.now()){
    let task;try{task=this.tasks.row('task',alert.taskId);}catch{return null;}
    if(!same(task,alert)||task.managementReview||!eligible.has(task.status))return null;
    return this.conditions(task,policy,at).some(condition=>this.alertId(task,condition)===alert.id)?task:null;
  }
  tick({force=false}={}){
    if(this.ticking||this.tasks.closed)return;
    const at=this.now();if(!force&&this.lastTick!==null&&at>=this.lastTick&&at-this.lastTick<5000)return;
    this.lastTick=at;this.ticking=true;
    const changed=new Set(),priorities=new Set();
    try{
      const policy=this.policy(),wanted=new Set();
      this.atomic(()=>{
        if(policy.enabled)for(const {body} of this.db.prepare(`SELECT t.body FROM background_task t WHERE json_extract(t.body,'$.status') IN ('queued','running','blocked','waiting_input','waiting_event') AND json_extract(t.body,'$.managementReview') IS NULL AND json_extract(t.body,'$.closure') IS NULL AND NOT ${closedAncestorSql()}`).all()){
          const task=JSON.parse(body),owner=this.owner(task);
          for(const condition of this.conditions(task,policy,at,{observe:true})){
            const id=this.alertId(task,condition),old=this.read('alert',id);wanted.add(id);
            const value={...old,id,taskId:task.id,runId:task.runId,assignmentVersion:task.assignmentVersion??1,ownerId:owner.assignedBotId,ownerName:owner.ownerName,title:task.title,
              ...condition,reason:explain[condition.type],status:'active',createdAt:old?.createdAt??at,lastSeenAt:old?.lastSeenAt??at,acknowledgedAt:old?.acknowledgedAt??null};
            delete value.resolvedAt;
            if(JSON.stringify(old)!==JSON.stringify(value)){value.lastSeenAt=at;this.write('alert',id,value);changed.add(task.id);}
            if(condition.type==='overdue'&&policy.raiseQueuedPriority&&task.status==='queued'&&task.priority!=='high'){
              const actionId='priority:'+id,current=this.tasks.row('task',task.id);
              if(!this.read('action',actionId)&&!taskIsClosed(current)&&same(current,task)&&current.status==='queued'&&current.dueAt===task.dueAt&&current.priority!=='high'){
                this.tasks.put('task',{...current,priority:'high',updatedAt:at});
                this.write('action',actionId,{id:actionId,type:'priority_raised',taskId:task.id,runId:task.runId,assignmentVersion:task.assignmentVersion??1,alertId:id,policyRevision:policy.revision,previousPriority:current.priority??'normal',priority:'high',createdAt:at,reason:'按已启用的值守规则，提高超期排队任务的优先级。'});
                priorities.add(task.id);changed.add(task.id);
              }
            }
          }
        }
        for(const row of this.db.prepare("SELECT body FROM team_watch_alert WHERE json_extract(body,'$.status')='active'").all()){
          const alert=JSON.parse(row.body);if(!wanted.has(alert.id)){this.write('alert',alert.id,{...alert,status:'resolved',resolvedAt:at,lastSeenAt:at});changed.add(alert.taskId);}
        }
      });
      for(const id of priorities)this.tasks.changed?.(this.tasks.row('task',id));
      if(changed.size)this.events?.publish('team.watch.updated',{taskIds:[...changed]});
      this.lastError=null;
    }catch(error){this.lastError=String(error.message);throw error;}
    finally{this.ticking=false;}
  }
  view({limit=20,offset=0,ownerId}={}){
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||ownerId!==undefined&&!idOk(ownerId))throw Error('invalid_watch_page');
    const policy=this.policy(),at=this.now(),alerts=[];
    // Only currently active observations are checked; old rows remain auditable.
    for(const row of this.db.prepare("SELECT body FROM team_watch_alert WHERE json_extract(body,'$.status')='active' ORDER BY json_extract(body,'$.acknowledgedAt') IS NOT NULL,json_extract(body,'$.createdAt') DESC,id").all()){
      const alert=JSON.parse(row.body),task=this.current(alert,policy,at);if(!task)continue;
      const owner=this.owner(task);if(ownerId!==undefined&&owner.assignedBotId!==ownerId)continue;
      alerts.push({...alert,title:task.title,ownerId:owner.assignedBotId,ownerName:owner.ownerName});
    }
    const actionRows=ownerId===undefined?this.db.prepare('SELECT body FROM team_watch_action ORDER BY rowid DESC LIMIT 20').all():
      this.db.prepare("SELECT a.body FROM team_watch_action a JOIN background_task t ON t.id=json_extract(a.body,'$.taskId') WHERE COALESCE(json_extract(t.body,'$.assignedBotId'),?)=? ORDER BY a.rowid DESC LIMIT 20").all(this.team?.chiefId??'',ownerId);
    return {policy,alerts:alerts.slice(offset,offset+limit),total:alerts.length,unacknowledged:alerts.filter(alert=>alert.acknowledgedAt===null).length,hasMore:alerts.length>offset+limit,actions:actionRows.map(row=>JSON.parse(row.body)),observedAt:at,problem:this.lastError??null};
  }
  configure(body){
    if(!body||!idOk(body.actionId)||!Number.isSafeInteger(body.revision)||body.revision<1)throw Error('invalid_watch_policy');
    const fields=['enabled','dueSoonMs','blockedMs','inactiveMs','raiseQueuedPriority'];
    if(Object.keys(body).some(key=>!['actionId','revision',...fields].includes(key)))throw Error('invalid_watch_policy');
    for(const key of ['enabled','raiseQueuedPriority'])if(body[key]!==undefined&&typeof body[key]!=='boolean')throw Error('invalid_watch_policy');
    for(const key of ['dueSoonMs','blockedMs','inactiveMs'])if(body[key]!==undefined&&(!Number.isSafeInteger(body[key])||body[key]<0||body[key]>604800000||body[key]>0&&body[key]<1000))throw Error('invalid_watch_policy');
    const key='operation:'+body.actionId,fingerprint=actionHash(body),old=this.read('record',key);
    if(old){if(old.fingerprint!==fingerprint)throw Error('watch_action_conflict');return this.view();}
    this.atomic(()=>{
      const policy=this.policy();if(policy.revision!==body.revision)throw Error('watch_policy_changed');
      const patch=Object.fromEntries(fields.filter(key=>body[key]!==undefined).map(key=>[key,body[key]]));
      this.write('record','policy',{...policy,...patch,revision:policy.revision+1,updatedAt:this.now()});
      this.write('record',key,{kind:'configure',fingerprint,createdAt:this.now()});
    });
    this.tick({force:true});this.events?.publish('team.watch.updated',{policyChanged:true});return this.view();
  }
  acknowledge(body){
    if(!body||!idOk(body.id)||!idOk(body.taskId)||!idOk(body.runId)||!Number.isSafeInteger(body.assignmentVersion)||body.assignmentVersion<1||body.actionId!==undefined&&!idOk(body.actionId))throw Error('invalid_watch_ack');
    const key=body.actionId&&'operation:'+body.actionId,fingerprint=actionHash(body);let changed=false;
    this.atomic(()=>{
      const old=key&&this.read('record',key);if(old&&old.fingerprint!==fingerprint)throw Error('watch_action_conflict');
      const alert=this.read('alert',body.id);if(!alert)throw Error('unknown_watch_alert');
      if(alert.taskId!==body.taskId||!same(alert,body)||alert.status!=='active'||!this.current(alert))throw Error('watch_alert_stale');
      if(alert.acknowledgedAt===null){this.write('alert',alert.id,{...alert,acknowledgedAt:this.now()});changed=true;}
      if(key&&!old)this.write('record',key,{kind:'acknowledge',fingerprint,createdAt:this.now()});
    });
    if(changed)this.events?.publish('team.watch.updated',{taskIds:[body.taskId]});return this.view();
  }
}
