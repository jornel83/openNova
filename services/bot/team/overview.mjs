/** Full-population counts; only the displayed rows materialize report evidence. */
import {currentWatchAlertSql} from './watch.mjs';
import {closedAncestorSql} from '../tasks/closure-visibility.mjs';
const active="('queued','blocked','running','pausing','cancelling')";
const attentionReviews="('needs_user','budget_exhausted','failed','paused','stale')";
const recent="reportId IS NOT NULL AND status IN ('completed','failed','waiting_input','interrupted','cancelled') AND max(finishedAt,reviewedAt)>=:since";
const watchMatch=`a.taskId=+b.id AND a.runId=b.runId AND a.assignmentVersion=b.assignmentVersion`;

export class TeamOverview {
  constructor({tasks,team,watch,now=Date.now}){Object.assign(this,{tasks,team,watch,now,db:tasks.db});}
  view({ownerId,limit=6,period='all'}={}){
    if(!Number.isInteger(limit)||limit<1||limit>50||!['all','today'].includes(period)||ownerId!==undefined&&(typeof ownerId!=='string'||!/^[\w-]{1,100}$/.test(ownerId)))throw Error('invalid_team_overview');
    const now=this.now(),start=new Date(now);start.setHours(0,0,0,0);
    const since=period==='today'?start.getTime():0,timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    const args={chief:this.team.chiefId,owner:ownerId??null,since,limit,now};
    // Current Run + assignment + latest report + latest matching decision. Old
    // accepted reports must never make a new execution look accepted.
    const cte=`WITH alerts AS (
      SELECT json_extract(a.body,'$.taskId') taskId,json_extract(a.body,'$.runId') runId,
        coalesce(json_extract(a.body,'$.assignmentVersion'),1) assignmentVersion,a.body
      FROM team_watch_alert a JOIN background_task t ON t.id=json_extract(a.body,'$.taskId')
      WHERE ${currentWatchAlertSql('t','a',':now')} AND json_extract(a.body,'$.acknowledgedAt') IS NULL
    ), base AS (
      SELECT t.id,t.body,t.rowid seq,coalesce(json_extract(t.body,'$.assignedBotId'),:chief) ownerId,
        json_extract(t.body,'$.status') status,json_extract(t.body,'$.runId') runId,json_extract(t.body,'$.closure.status') closureStatus,
        ${closedAncestorSql()} hiddenByClosedParent,
        coalesce(json_extract(t.body,'$.assignmentVersion'),1) assignmentVersion,
        coalesce(json_extract(r.body,'$.finishedAt'),0) finishedAt,
        json_extract(j.body,'$.cleanupConfirmed') cleanupConfirmed,
        p.id reportId,p.body reportBody,json_extract(v.body,'$.status') reviewStatus,
        coalesce(json_extract(v.body,'$.finishedAt'),json_extract(v.body,'$.createdAt'),0) reviewedAt
      FROM background_task t
      LEFT JOIN background_run r ON r.id=json_extract(t.body,'$.runId')
      LEFT JOIN background_job j ON j.id=json_extract(r.body,'$.jobId')
      LEFT JOIN team_report p ON p.id=(SELECT id FROM team_report x WHERE json_extract(x.body,'$.taskId')=+t.id
        AND json_extract(x.body,'$.runId')=json_extract(t.body,'$.runId')
        AND json_extract(x.body,'$.assignmentVersion')=coalesce(json_extract(t.body,'$.assignmentVersion'),1)
        ORDER BY json_extract(x.body,'$.version') DESC LIMIT 1)
      LEFT JOIN team_review v ON v.rowid=(SELECT rowid FROM team_review x WHERE json_extract(x.body,'$.taskId')=+t.id
        AND json_extract(x.body,'$.reportId')=+p.id AND json_extract(x.body,'$.runId')=json_extract(t.body,'$.runId')
        AND json_extract(x.body,'$.assignmentVersion')=coalesce(json_extract(t.body,'$.assignmentVersion'),1)
        ORDER BY rowid DESC LIMIT 1)
      WHERE json_extract(t.body,'$.managementReview') IS NULL
    ), population AS (
      SELECT b.*,status IN ${active} isActive,
        (coalesce(closureStatus='closing',0) OR status IN ('failed','interrupted','waiting_input') OR (cleanupConfirmed=0 AND status NOT IN ('running','pausing','cancelling'))
          OR coalesce(reviewStatus IN ${attentionReviews},0) OR EXISTS(SELECT 1 FROM alerts a WHERE ${watchMatch})) needsAttention
      FROM base b WHERE (:owner IS NULL OR ownerId=:owner) AND coalesce(closureStatus,'')<>'closed' AND NOT hiddenByClosedParent
    )`;
    const select=(sql,bindings=args)=>{const stmt=this.db.prepare(cte+sql);stmt.setAllowUnknownNamedParameters(true);return stmt.all(bindings);};
    const aggregate=`count(*) total,coalesce(sum(isActive),0) active,coalesce(sum(needsAttention),0) attention,
      coalesce(sum(status='completed' AND finishedAt>=:since),0) completed,
      coalesce(sum(reviewStatus='accepted' AND reviewedAt>=:since),0) accepted,
      coalesce(sum(${recent}),0) recent`;
    const counts={...select(` SELECT ${aggregate},(SELECT count(*) FROM base WHERE closureStatus='closed' AND (:owner IS NULL OR ownerId=:owner)) closed FROM population`)[0]};
    const byOwner=new Map(select(` SELECT ownerId,${aggregate} FROM population GROUP BY ownerId`).map(row=>[row.ownerId,row]));
    const rows=(where,order)=>select(` SELECT * FROM population WHERE ${where} ORDER BY ${order} LIMIT :limit`);
    const cache=new Map();
    const summary=row=>{
      if(cache.has(row.id))return cache.get(row.id);
      const task=JSON.parse(row.body),value=this.tasks.summary(task),reasons=[];
      if(task.closure?.status==='closing')reasons.push('正在关闭任务，等待执行进程与关联任务清理完成');
      if(task.status==='waiting_input')reasons.push(value.question||'等待你的补充');
      if(task.status==='failed'||task.status==='interrupted')reasons.push(value.error||'执行'+(task.status==='failed'?'失败':'中断'));
      if(value.cleanupConfirmed===false&&!['running','pausing','cancelling'].includes(task.status))reasons.push('正在确认执行进程已清理');
      if(['needs_user','budget_exhausted','failed','paused','stale'].includes(value.reviewStatus))reasons.push(value.inboxReason||({needs_user:'验收需要你处理',budget_exhausted:'总管执行预算已用尽',failed:'总管验收失败',paused:'总管验收已暂停',stale:'验收后的成果已变化，需要重新核对'})[value.reviewStatus]);
      const alerts=this.db.prepare(`SELECT a.body FROM team_watch_alert a JOIN background_task t ON t.id=json_extract(a.body,'$.taskId') WHERE t.id=:task AND ${currentWatchAlertSql('t','a',':now')} AND json_extract(a.body,'$.acknowledgedAt') IS NULL`).all({task:task.id,now}).map(row=>JSON.parse(row.body));
      reasons.push(...alerts.map(a=>a.reason));
      const report=row.reportBody?JSON.parse(row.reportBody):null;
      const result={...value,taskId:task.id,ownerId:row.ownerId,reasons:[...new Set(reasons.filter(Boolean))],alerts,
        ...(report?{resultSummary:report.summary,reportVersion:report.version,artifactNames:(report.artifacts??[]).map(a=>a.name)}:{})};
      cache.set(row.id,result);return result;
    };
    const roster=this.team.view();
    return {generatedAt:now,window:{period,since,timezone},counts,
      // Accepted is a stored decision count. Evidence on displayed results is
      // checked afresh by summary(); archived files are not all rehashed here.
      acceptanceBasis:'current-run-recorded-decisions',
      members:roster.members.map(member=>{const count=byOwner.get(member.id);return {id:member.id,name:member.name,role:member.role,status:member.status,chief:member.chief,enabled:member.enabled,
        activeCount:count?.active??0,attentionCount:count?.attention??0,totalCount:count?.total??0};}),
      active:rows('isActive','seq DESC').map(summary),
      attention:rows('needsAttention','seq DESC').map(summary),
      recent:rows(recent,'max(finishedAt,reviewedAt) DESC,seq DESC').map(summary),
      watch:this.watch.view({ownerId,limit}),
      scope:'当前未关闭任务与当前执行轮；内部验收任务不计入员工工作。进行中、待处理为当前状态；完成和验收记录按所选时间统计。直接关闭的任务历史另计，不包含在当前任务总数中；关联检查记录随已关闭父任务的详情查看。',
    };
  }
}
