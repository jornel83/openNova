export const skillSourceLabel=source=>({bundled:'内置技能',personal:'个人技能',private:'团队技能',learned:'经验技能',candidate:'经验候选'})[source]||'团队技能';
export const skillVersionLabel=version=>Number.isInteger(version)?`第 ${version} 版`:String(version??'').slice(0,10)||'未记录版本';
export function skillSelection(mode,names=[]){return mode==='none'?{skillNames:[]}:mode==='explicit'?{skillNames:[...new Set(names)]}:{};}
export function runSkills(detail,currentRun){
  if(Array.isArray(currentRun?.skills))return currentRun.skills;
  if(currentRun?.id===detail?.task?.runId&&Array.isArray(detail?.skills))return detail.skills;
  return [];
}
export function reportCandidates(detail,report,review){
  return (detail?.skillCandidates??[]).filter(candidate=>candidate.source?.taskId===detail?.task?.id&&candidate.source?.runId===report?.runId&&candidate.source?.reportId===report?.id&&(!review?.id||candidate.source?.reviewId===review.id));
}
export function candidateSourceCurrent(detail,candidate){
  const task=detail?.task,source=candidate?.source,view=reviewView(detail,source?.runId);
  return !!task&&task.kind==='agent'&&!task.managementReview&&!task.parentTaskId&&!taskUnavailable(task)&&task.status==='completed'&&task.id===source?.taskId&&task.runId===source?.runId&&view.latest&&!view.evidenceChanged&&!view.verificationFailed&&view.report?.id===source?.reportId&&view.report.status==='completed'&&view.report.evidence?.execution?.cleanupConfirmed!==false&&view.review?.id===source?.reviewId&&view.review.status==='accepted';
}
export const skillConflict=error=>/skill.*(?:changed|conflict|stale)|candidate.*(?:changed|stale)|stale.*skill/.test(error?.code||error?.message||'');
export function skillCatalogProblems(catalog){
  const problems=[...(catalog?.problems??[])];
  for(const status of ['pending','blocked'])if(catalog?.sync?.[status]>0&&!problems.some(problem=>problem.status===status))problems.push({name:'技能同步',status});
  const unique=new Map();
  for(const problem of problems){
    const status=problem.status??'unavailable',name=problem.name||'技能';
    const text=status==='pending'?'设置已保存，正在同步到员工；后台会自动重试。':status==='blocked'?'同步需要重新确认。请刷新后核对技能是否启用、员工是否可用，重新选择员工技能并保存。':'暂时无法载入，请核对技能文件与资源是否完整，再刷新技能。';
    unique.set(name+':'+status,{name,status,text});
  }
  return [...unique.values()];
}
export const videoStatusLabel=status=>({submitting:'正在提交',submission_not_confirmed:'提交结果待核对',submitted:'已提交',queued:'远端排队中',pending:'远端处理中',running:'生成中',succeeded:'生成完成',downloaded:'已下载',completed:'处理完成',failed:'执行失败',expired:'已过期',cancelled:'已取消',stopped:'已停止本地跟进'})[status]||status||'状态待核对';
import {reviewView} from './team-view.mjs';
import {taskUnavailable} from './task-view.mjs';
