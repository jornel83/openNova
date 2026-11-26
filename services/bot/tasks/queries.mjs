/** Indexed scheduling queries. History is decoded only when a caller requests it. */
import {currentWatchAlertSql} from '../team/watch.mjs';
import {closedAncestorSql} from './closure-visibility.mjs';
export const LIVE_STATUSES=['queued','blocked','running','pausing','cancelling'];
export const UNFINISHED_STATUSES=[...LIVE_STATUSES,'waiting_input','waiting_event','paused'];
const list=values=>values.map(()=>'?').join(',');
const field=(name,alias='t')=>`json_extract(${alias}.body,'$.${name}')`;
const visible=`${field('managementReview')} IS NULL`;
const open=`${field('closure')} IS NULL`;
const notClosed=`COALESCE(${field('closure.status')},'')<>'closed'`;
// Unary + removes the TEXT column affinity on the outer id. Identifiers are
// strings; this preserves their comparison while allowing the JSON expression
// index to serve a correlated lookup instead of scanning all report history.
const currentReport=`SELECT p.id FROM team_report p WHERE ${field('taskId','p')}=+t.id AND ${field('runId','p')}=${field('runId')} AND ${field('assignmentVersion','p')}=COALESCE(${field('assignmentVersion')},1) ORDER BY ${field('version','p')} DESC LIMIT 1`;
const reviewField=name=>`SELECT ${field(name,'v')} FROM team_review v WHERE ${field('taskId','v')}=+t.id AND ${field('runId','v')}=${field('runId')} AND ${field('assignmentVersion','v')}=COALESCE(${field('assignmentVersion')},1) AND ${field('reportId','v')}=(${currentReport}) ORDER BY v.rowid DESC LIMIT 1`;
const currentReview=reviewField('status');
const reviewEligible=`${visible} AND ${open} AND NOT ${closedAncestorSql()} AND ${field('management.enabled')}=1 AND COALESCE(${field('management.paused')},0)=0 AND ${field('status')} IN ('completed','failed','waiting_input')`;
const pendingReview=`(${currentReport}) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM team_review v WHERE ${field('taskId','v')}=+t.id AND ${field('runId','v')}=${field('runId')} AND ${field('assignmentVersion','v')}=COALESCE(${field('assignmentVersion')},1) AND ${field('reportId','v')}=(${currentReport}))`;
export class TaskQueries {
  constructor(tasks){
    this.tasks=tasks;this.db=tasks.db;
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS background_task_status ON background_task(json_extract(body,'$.status'));
      CREATE INDEX IF NOT EXISTS background_task_project_status ON background_task(json_extract(body,'$.projectId'),json_extract(body,'$.status'));
      CREATE INDEX IF NOT EXISTS background_task_owner_status ON background_task(json_extract(body,'$.assignedBotId'),json_extract(body,'$.status'));
      CREATE INDEX IF NOT EXISTS background_task_run ON background_task(json_extract(body,'$.runId'));
      CREATE INDEX IF NOT EXISTS background_task_parent ON background_task(json_extract(body,'$.parentTaskId'));
      CREATE INDEX IF NOT EXISTS background_task_parent_run ON background_task(json_extract(body,'$.parentRunId'));
      CREATE INDEX IF NOT EXISTS background_task_review_target ON background_task(json_extract(body,'$.managementReview.targetTaskId'));
      CREATE INDEX IF NOT EXISTS background_task_handoff ON background_task(json_extract(body,'$.handoff.status'));
      CREATE INDEX IF NOT EXISTS background_task_dependencies ON background_task((json_array_length(body,'$.dependencyInputs')>0));
      CREATE INDEX IF NOT EXISTS background_task_unfinished_dependencies ON background_task(id) WHERE (json_array_length(body,'$.dependencyInputs')>0)=1 AND json_extract(body,'$.status') IN ('queued','blocked','running','pausing','cancelling','waiting_input','waiting_event','paused');
      CREATE INDEX IF NOT EXISTS background_run_task ON background_run(json_extract(body,'$.taskId'));
      CREATE INDEX IF NOT EXISTS background_run_job ON background_run(json_extract(body,'$.jobId'));
      CREATE INDEX IF NOT EXISTS background_job_cleanup ON background_job(json_extract(body,'$.cleanupConfirmed'));
      CREATE INDEX IF NOT EXISTS background_message_task ON background_message(json_extract(body,'$.taskId'));
    `);
  }
  conditions({statuses,ownerId,projectId,search,includeManagement=false,closed=false}={}){
    const where=[],params=[];
    if(!includeManagement)where.push(visible);
    where.push(closed?`${field('closure.status')}='closed'`:`${notClosed} AND NOT ${closedAncestorSql()}`);
    if(statuses){where.push(`${field('status')} IN (${list(statuses)})`);params.push(...statuses);}
    if(projectId!==undefined){
      if(projectId===null)where.push(`${field('projectId')} IS NULL`);
      else{if(typeof projectId!=='string'||!/^[\w-]{1,128}$/.test(projectId))throw Error('invalid_task_project');where.push(`${field('projectId')}=?`);params.push(projectId);}
    }
    if(ownerId!==undefined){
      if(typeof ownerId!=='string'||!ownerId||ownerId.length>100)throw Error('invalid_task_owner');
      // Tasks predating team ownership belong to the chief, as in TeamRegistry.owner.
      where.push(ownerId===this.tasks.team?.chiefId?`(${field('assignedBotId')}=? OR ${field('assignedBotId')} IS NULL)`:`${field('assignedBotId')}=?`);params.push(ownerId);
    }
    if(search!==undefined){
      if(typeof search!=='string'||search.length>200)throw Error('invalid_task_search');
      if(search.trim()){where.push(`(instr(lower(COALESCE(${field('title')},'')),lower(?))>0 OR instr(lower(t.id),lower(?))>0)`);params.push(search.trim(),search.trim());}
    }
    return {where:where.length?where.join(' AND '):'1',params};
  }
  select(options={}){const {where,params}=this.conditions(options);return this.db.prepare(`SELECT t.body FROM background_task t WHERE ${where} ORDER BY t.rowid DESC`).all(...params).map(row=>JSON.parse(row.body));}
  unfinished(){return this.select({statuses:UNFINISHED_STATUSES});}
  counts(options={}){
    const {where,params}=this.conditions(options);
    return this.db.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(${field('status')} IN ('queued','blocked','running','pausing','cancelling')),0) AS activeCount,COALESCE(SUM(COALESCE(${field('unread')},0)<>0),0) AS unreadCount FROM background_task t WHERE ${where}`).get(...params);
  }
  page({limit=50,offset=0,ownerId,projectId,filter='all',search}={}){
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0)throw Error('invalid_task_page');
    if(!['all','active','attention','recent','closed'].includes(filter))throw Error('invalid_task_filter');
    const options={ownerId,projectId,search},base=this.conditions({...options,closed:filter==='closed'}),where=[base.where];
    if(filter==='active')where.push(`${field('status')} IN ('queued','blocked','running','pausing','cancelling')`);
    if(filter==='recent')where.push(`${field('status')} IN ('completed','failed','waiting_input','cancelled','interrupted') AND (${currentReport}) IS NOT NULL`);
    if(filter==='attention'){
      const hasWatch=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_watch_alert'").get();
      where.push(`(${field('closure.status')}='closing' OR ${field('status')} IN ('failed','interrupted','waiting_input')
        OR (${field('status')} NOT IN ('running','pausing','cancelling') AND EXISTS (SELECT 1 FROM background_run r JOIN background_job j ON j.id=${field('jobId','r')} WHERE r.id=${field('runId')} AND ${field('cleanupConfirmed','j')}=0))
        ${this.reviewQueueReady?`OR (${currentReview}) IN ('needs_user','paused','budget_exhausted','failed','stale')`:''}
        ${hasWatch?`OR EXISTS (SELECT 1 FROM team_watch_alert a WHERE ${currentWatchAlertSql()} AND ${field('acknowledgedAt','a')} IS NULL)`:''})`);
    }
    const sql=where.join(' AND '),counts=this.counts(options),closedCount=this.counts({...options,closed:true}).total,total=this.db.prepare(`SELECT COUNT(*) AS n FROM background_task t WHERE ${sql}`).get(...base.params).n;
    const finished=`COALESCE((SELECT ${field('finishedAt','r')} FROM background_run r WHERE r.id=${field('runId')}),${field('updatedAt')},${field('createdAt')},0)`;
    const order=filter==='recent'?`${this.reviewQueueReady?`MAX(${finished},COALESCE((${reviewField('finishedAt')}),0))`:finished} DESC,t.rowid DESC`:`(${field('status')} IN ('queued','blocked','running','pausing','cancelling')) DESC,COALESCE(${field('unread')},0) DESC,t.rowid DESC`;
    const tasks=this.db.prepare(`SELECT t.body FROM background_task t WHERE ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...base.params,limit,offset).map(row=>JSON.parse(row.body));
    return {...counts,closedCount,tasks,total,hasMore:offset+limit<total};
  }
  related({parentTaskId,parentRunId,managementTargetId}={}){
    const clauses=[],values=[];
    for(const [name,value] of [['parentTaskId',parentTaskId],['parentRunId',parentRunId],['managementReview.targetTaskId',managementTargetId]])if(value!==undefined){clauses.push(`${field(name)}=?`);values.push(value);}
    if(!clauses.length)return [];
    return this.db.prepare(`SELECT t.body FROM background_task t WHERE ${clauses.join(' OR ')} ORDER BY t.rowid DESC`).all(...values).map(row=>JSON.parse(row.body));
  }
  currentWork(){
    // Follow the Task's current Run. A cleanup flag on an obsolete Job must not
    // hold today's queue, even when that old worker later publishes a receipt.
    // CROSS JOIN keeps the unconfirmed-Job index as the starting point; each
    // matching Job then follows primary keys, never a historical Task scan.
    return this.db.prepare(`SELECT t.body AS task,r.body AS run,j.body AS job FROM background_task t JOIN background_run r ON r.id=${field('runId')} JOIN background_job j ON j.id=${field('jobId','r')} WHERE t.id IN (
      SELECT id FROM background_task WHERE json_extract(body,'$.status') IN ('running','pausing','cancelling')
      UNION SELECT t2.id FROM background_job j2 CROSS JOIN background_run r2 ON r2.id=json_extract(j2.body,'$.runId') CROSS JOIN background_task t2 ON t2.id=json_extract(r2.body,'$.taskId') WHERE json_extract(j2.body,'$.cleanupConfirmed')=0 AND json_extract(t2.body,'$.runId')=r2.id AND json_extract(r2.body,'$.jobId')=j2.id
    )`).all().map(row=>({task:JSON.parse(row.task),run:JSON.parse(row.run),job:JSON.parse(row.job)}));
  }
  holdsSlot(){return this.currentWork().length>0;}
  nextQueued(){
    const row=this.db.prepare(`SELECT t.body FROM background_task t JOIN background_run r ON r.id=${field('runId')} WHERE ${field('status')}='queued' AND ${open} AND NOT ${closedAncestorSql()} ORDER BY (${field('managementReview')} IS NOT NULL) DESC,CASE ${field('priority')} WHEN 'high' THEN 2 WHEN 'low' THEN 0 ELSE 1 END DESC,COALESCE(${field('dueAt')},1e100),${field('createdAt','r')},t.rowid LIMIT 1`).get();
    return row?JSON.parse(row.body):null;
  }
  assignmentCandidates(){
    return this.db.prepare(`SELECT t.body FROM background_task t WHERE ${visible} AND ${open} AND NOT ${closedAncestorSql()} AND t.id IN (
      SELECT id FROM background_task WHERE json_extract(body,'$.status') IN ('queued','blocked')
      UNION SELECT id FROM background_task WHERE json_extract(body,'$.handoff.status')='stopping'
      UNION SELECT id FROM background_task INDEXED BY background_task_unfinished_dependencies WHERE (json_array_length(body,'$.dependencyInputs')>0)=1 AND json_extract(body,'$.status') IN ('queued','blocked','running','pausing','cancelling','waiting_input','waiting_event','paused')
    ) ORDER BY t.rowid DESC`).all().map(row=>JSON.parse(row.body));
  }
  initializeReviews(){
    // A durable, transactionally maintained candidate set keeps idle supervision
    // independent of accepted history. A recapture in the same Run re-enqueues.
    const refresh=id=>`DELETE FROM task_review_candidate WHERE task_id=${id}; INSERT OR IGNORE INTO task_review_candidate SELECT t.id FROM background_task t WHERE t.id=${id} AND ${reviewEligible} AND ${pendingReview};`;
    // Replace earlier definitions too: deployed databases already have these
    // trigger names, but did not observe closure-only updates.
    const triggerNames=['task_insert','task_update','task_delete',...['team_report','team_review'].flatMap(table=>['insert','update','delete'].map(event=>table+'_'+event))];
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_review_candidate(task_id TEXT PRIMARY KEY);
      ${triggerNames.map(name=>'DROP TRIGGER IF EXISTS task_review_candidate_'+name+';').join('\n')}
      CREATE TRIGGER IF NOT EXISTS task_review_candidate_task_insert AFTER INSERT ON background_task BEGIN ${refresh('NEW.id')} END;
      CREATE TRIGGER IF NOT EXISTS task_review_candidate_task_update AFTER UPDATE ON background_task WHEN json_extract(OLD.body,'$.runId') IS NOT json_extract(NEW.body,'$.runId') OR json_extract(OLD.body,'$.assignmentVersion') IS NOT json_extract(NEW.body,'$.assignmentVersion') OR json_extract(OLD.body,'$.status') IS NOT json_extract(NEW.body,'$.status') OR json_extract(OLD.body,'$.management') IS NOT json_extract(NEW.body,'$.management') OR json_extract(OLD.body,'$.managementReview') IS NOT json_extract(NEW.body,'$.managementReview') OR json_extract(OLD.body,'$.closure') IS NOT json_extract(NEW.body,'$.closure') BEGIN ${refresh('NEW.id')} END;
      CREATE TRIGGER IF NOT EXISTS task_review_candidate_task_delete AFTER DELETE ON background_task BEGIN DELETE FROM task_review_candidate WHERE task_id=OLD.id; END;
      ${['team_report','team_review'].map(table=>['INSERT','UPDATE','DELETE'].map(event=>`CREATE TRIGGER IF NOT EXISTS task_review_candidate_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN ${event!=='INSERT'?refresh("json_extract(OLD.body,'$.taskId')"):''}${event!=='DELETE'?refresh("json_extract(NEW.body,'$.taskId')"):''} END;`).join('\n')).join('\n')}
      DELETE FROM task_review_candidate;
      INSERT INTO task_review_candidate SELECT t.id FROM background_task t WHERE ${reviewEligible} AND ${pendingReview};`);
    this.reviewQueueReady=true;
  }
  pendingReviews(){return this.db.prepare(`SELECT t.body FROM task_review_candidate q CROSS JOIN background_task t ON t.id=q.task_id WHERE ${open} AND NOT ${closedAncestorSql()}`).all().map(row=>JSON.parse(row.body));}
}
