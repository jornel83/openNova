import {taskUnavailable,taskClosureStatus} from './task-view.mjs';
export const reviewLabels={pending:'待处理',queued:'待总管检查',reviewing:'总管检查中',accepted:'已验收',changes_requested:'需要返工',answered:'已补充要求',needs_user:'待你处理',paused:'跟进已暂停',budget_exhausted:'跟进额度已用尽',stale:'已有新成果',failed:'检查未完成'};
export const priorityLabels={low:'低',normal:'普通',high:'高'};
export function reviewView(detail,runId=detail?.task?.runId){
  const task=detail?.task??{},team=detail?.teamReview??{};
  const reports=[team.current,...(team.history??[])].filter(Boolean);
  const report=reports.find(r=>r.runId===runId)??null;
  const reviews=(team.reviews??[]).filter(r=>r.reportId===report?.id).sort((a,b)=>(b.createdAt??0)-(a.createdAt??0));
  const latest=!!report&&report.id===team.current?.id&&report.runId===task.runId&&report.assignmentVersion===task.assignmentVersion;
  const review=latest&&team.currentReview?.reportId===report.id?team.currentReview:reviews[0]??null;
  const evidence=report?.evidence??{},candidate=evidence.candidateReview;
  const covered=new Set(candidate?.status==='passed'?candidate.coveredStepIds:[]);
  const failed=item=>item.status!=='completed'||(candidate||item.exitCode!=null)&&item.exitCode!==0;
  const candidateChanged=candidate&&(candidate.patchCurrent===false||latest&&review?.status==='stale');
  const evidenceChanged=!!report&&(!!candidateChanged||evidence.captureIncomplete||(report.artifacts??[]).some(file=>file.status!=='available'||file.sourceStatus&&file.sourceStatus!=='available'));
  const unresolvedStep=candidate&&evidence.steps?.some(step=>step.status!=='completed'&&!(step.tool==='task_command'&&covered.has(step.id)));
  const verificationFailed=!!(candidate&&candidate.status!=='passed'||unresolvedStep||
    evidence.execution?.exitCode!=null&&evidence.execution.exitCode!==0||
    evidence.commands?.some(item=>failed(item)&&!covered.has(item.stepId))||evidence.checks?.some(failed));
  const actionable=latest&&!taskUnavailable(task)&&!evidenceChanged&&['completed','failed','waiting_input'].includes(task.status)&&report.evidence?.execution?.cleanupConfirmed===true;
  return {report,review,reviews,covered,management:team.management??task.management??null,latest,actionable,evidenceChanged,verificationFailed,
    canAccept:actionable&&!verificationFailed&&report.status==='completed'&&review?.status!=='accepted',
    binding:report?{id:task.id,runId:report.runId,reportId:report.id,assignmentVersion:report.assignmentVersion}:null};
}
export function inboxTasks(tasks=[]){
  return tasks.filter(t=>taskClosureStatus(t)!=='closed'&&(t.inboxReason||['needs_user','paused','budget_exhausted','failed'].includes(t.reviewStatus)||t.status==='waiting_input'));
}
export function inboxText(task){
  if(task.status==='waiting_input')return task.question||'员工需要补充信息。';
  const labels={budget_exhausted:'总管跟进额度已用尽，请决定下一步。',management_budget_exhausted:'总管跟进额度已用尽，请决定下一步。',accepted_report_evidence_changed:'已验收成果的文件或证据发生变化，请重新核对。',paused:'总管跟进已暂停。',needs_user:'总管需要你作出决定。',failed:'总管检查未完成，请查看原因。'};
  if(task.inboxReason&&!labels[task.inboxReason])return task.inboxReason;
  return labels[task.inboxReason]||labels[task.reviewStatus]||task.inboxReason||'请查看最新成果并处理。';
}
export const reviewConflict=error=>/task_closed|task_reopen_unavailable|task_run_changed|assignment.*changed|(?:report|review|dependency).*?(?:stale|changed|conflict)|stale.*(?:report|review)/.test(error?.code||error?.message||'');
export function localDateValue(timestamp){
  if(!timestamp)return '';
  const date=new Date(timestamp);if(!Number.isFinite(date.getTime()))return '';
  return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
}
export const canEditDependencies=detail=>!taskUnavailable(detail.task)&&detail.task.kind==='agent'&&['queued','blocked','paused'].includes(detail.task.status)&&!detail.runs.find(run=>run.id===detail.task.runId)?.startedAt;
export const employeeTask=task=>task.assignedBotId&&task.supervisorBotId?task.assignedBotId!==task.supervisorBotId:task.routing==='employee-background';
export function dependencyReason(reason,tasks=[]){
  const [code,id]=String(reason??'').split(':');
  const name=tasks.find(task=>task.id===id)?.title||'前置任务';
  return ({dependency_waiting_acceptance:`等待“${name}”的成果验收通过。`,dependency_artifact_changed:`“${name}”的成果文件已变化，需要重新核对。`,dependency_artifact_missing:'前置成果文件不可读取，请核对交付文件。',team_member_disabled:'负责人已停用，请启用员工或交接任务。',team_disabled:'团队派工已关闭，恢复后可继续。',team_report_artifact_changed:'用于交接的成果已变化，请重新核对。'})[code]||'等待前置成果或交接条件满足。';
}
export function artifactLabel(file){return ({available:'可打开',missing:'成果快照缺失',changed:'成果快照已变化',too_large:'文件超过快照大小限制'})[file.status]||'暂不可打开';}
