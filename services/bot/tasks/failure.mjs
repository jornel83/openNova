import {errorEvent,diagnosticText} from '../../agent/errors.mjs';
import {existsSync} from 'node:fs';

// Keep only allowlisted diagnostics. Provider messages, bodies and credentials
// must never become task reports or browser error text.
export function taskFailure(error,{phase='model',steps=[],management=false}={}){
  const {type,...diagnostic}=errorEvent(error,phase==='initializing'?'harness_start':'conversation');
  if(diagnostic.code==='agent_runtime_failed')return {};
  const completedCommands=steps.filter(s=>s.tool==='task_command'&&s.status==='completed'&&s.exitCode===0).length;
  return {diagnostic,failurePhase:management?'review':phase==='initializing'?'initializing':steps.length?'model_after_tools':'model',completedCommands,
    failureText:(management?'自动验收的模型调用未完成。':steps.length?'工具步骤已保存，后续模型调用未完成。':'工作会话未完成。')+diagnosticText(diagnostic)};
}
export function recoverableModelFailure(value){
  const d=value?.diagnostic??value;
  return ['network_error','connection_error','stream_interrupted','incomplete_model_response','incomplete_agent_turn','model_service_unavailable'].includes(d?.code??value?.error)||d?.code==='api_error'&&(d.status===429||d.status>=500);
}
export function canSummarizeFailure(task,job,report){
  return task.kind==='agent'&&!task.managementReview&&task.status==='failed'&&job.cleanupConfirmed===true&&recoverableModelFailure(job.agentResult)&&
    report?.runId===task.runId&&!report.evidence?.captureIncomplete&&
    !!report.evidence?.steps?.length&&report.evidence.steps.every(s=>s.status==='completed')&&
    [...(report.evidence.commands??[]),...(report.evidence.checks??[])].every(s=>s.status==='completed'&&s.exitCode===0)&&
    !(report.evidence.codeChanges??[]).some(c=>c.deleted&&existsSync(c.path))&&
    (report.artifacts??[]).every(a=>a.status==='available'&&(!a.sourceStatus||a.sourceStatus==='available'));
}
