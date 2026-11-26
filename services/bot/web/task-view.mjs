import {labels as errorLabels} from './api.mjs';
import {diagnosticText} from '../../agent/errors.mjs';
export const taskLabels={blocked:'等待前置条件',paused:'已暂停',pausing:'暂停中',waiting_input:'等待补充',waiting_event:'等待事件',queued:'排队中',running:'运行中',cancelling:'取消中',completed:'已完成',failed:'执行失败',cancelled:'已取消',interrupted:'异常中断'};
export const activeTask=task=>['blocked','queued','running','pausing','cancelling'].includes(task.status);
export const taskClosureStatus=task=>['closing','closed'].includes(task?.closure?.status)?task.closure.status:null;
export const taskUnavailable=task=>!!taskClosureStatus(task)||['closing','closed'].includes(task?.parentClosure?.status);
export const taskClosureLabel=task=>({closing:'正在关闭',closed:'已关闭'})[taskClosureStatus(task)]||'';
export const taskMediaLabels={image_generate:'静态图片',gif_generate:'GIF 动图',media_export:'本地导出',gif_review:'GIF 抽帧审阅'};
export function taskMediaStatus(operation){
  if(operation.localFollow==='stopped')return '已停止本地跟进';
  if(operation.terminalStatus)return taskLabels[operation.terminalStatus]|| (operation.terminalStatus==='unknown'?'远端结果待核对':operation.terminalStatus);
  if(operation.status==='pending'&&operation.generation?.provider==='spark')
    return operation.generation.status==='queued'?'Spark 排队中':'正在跟进 Spark 图片任务';
  if(operation.status==='pending')return operation.generation?.providerStatus==='queued'?'Seedance 排队中':'正在跟进 Seedance';
  if(operation.status==='partial')return '部分文件已保存';
  if(operation.status==='unknown')return '远端结果待核对';
  return taskLabels[operation.status]||'等待结果';
}
export function taskActivityText(run,now=Date.now()){
  const activity=run?.activity;if(!activity)return '';
  const labels={initializing:'正在准备工作会话',waiting_foreground:'等待前台对话结束',model:'正在等待模型响应',tool:'正在执行工具',idle:'正在衔接执行步骤',command:'命令正在运行',queued:'等待执行队列',blocked:'等待前置条件',pausing:'正在暂停',cancelling:'正在取消'};
  const phase=labels[activity.phase];if(!phase)return '';
  const seconds=Math.max(0,Math.floor((now-activity.lastActivityAt)/1000)),age=seconds<60?`${seconds} 秒`:`${Math.floor(seconds/60)} 分钟`;
  const recent=Number.isFinite(activity.lastActivityAt)?` · 最近活动 ${age}前`:'';
  const heartbeat=activity.heartbeatAt&&now-activity.heartbeatAt>15000?' · 状态更新暂未收到，尚不能确认执行是否中断':'';
  return phase+(activity.tool?'（'+activity.tool+'）':'')+recent+heartbeat;
}
export function taskReason(task){
  if(task?.parentClosure?.status==='closing')return '所属任务正在关闭，此记录仅供查看；请等待所属任务完成关闭。';
  if(task?.parentClosure?.status==='closed')return '所属任务已关闭，此记录仅供查看。需要继续时，请先恢复所属任务；恢复不会自动执行。';
  if(taskClosureStatus(task)==='closing')return '正在停止执行与自动跟进；确认作业退出后，会从任务列表移除。历史和成果将保留。';
  if(taskClosureStatus(task)==='closed')return '已从任务列表移除，执行记录和成果仍保留。恢复到列表不会启动执行或自动跟进。';
  const researchStops={
    research_waiting_for_input:'研究正在等你补充信息。请查看上轮问题后接续任务。',
    research_write_outcome_unknown:'中断前的写入结果尚未确认。请先核对任务文件和上轮记录。',
    research_document_outcome_unknown:'中断前的文档交付结果尚未确认。请先核对目标文件和生成记录。',
    research_step_requires_review:'上轮有需要人工核对的工具步骤。请查看执行记录。',
    research_recovery_budget_exhausted:'本次研究的执行预算已用完，已确认的结果保存在任务中。'
  };
  if(researchStops[task.error])return researchStops[task.error];
  if(task.error==='task_timeout')return '执行超过时限，作业已停止。';
  if(task.error==='task_document_receipt_unavailable')return '指定的交付文件缺少成功生成回执。请查看文档工具的执行记录。';
  if(task.error==='task_document_delivery_changed')return '交付文件已被修改或移走，无法确认当前版本。';
  if(task.cleanupConfirmed===false&&!activeTask(task))return '旧作业是否停止尚未确认，后续任务暂缓执行。请核对运行环境。';
  if(task.status==='failed'&&task.diagnostic)return (task.failurePhase==='model_after_tools'?'工具步骤已保存，后续模型调用未完成。':'')+diagnosticText(task.diagnostic);
  if(['project_state_changed','project_task_mismatch','project_object_changed_read_again','task_inputs_changed','project_work_request_required','project_archived'].includes(task.error))return errorLabels[task.error];
  if(task.mediaOperation&&task.error&&errorLabels[task.error])return errorLabels[task.error];
  if(task.status==='paused')return '工作会话和文件已保留，可以补充要求后接续。';
  if(task.status==='waiting_event'&&task.awaiting?.kind==='media'){
    const provider=(task.mediaOperation??task.media?.operation)==='image_generate'?'Spark':'Seedance';
    return `本轮已释放执行队列，OpenNova 继续跟进同一个 ${provider} 任务，完成后归档成果。`;
  }
  if(task.status==='waiting_event')return task.automationPaused?'自动接续已暂停，后台验证记录和工作目录已保留。':'本轮已释放执行队列，等待后台验证结果按规则接续。';
  if(task.status==='waiting_input')return task.question||'需要补充信息后继续。';
  if(task.status==='pausing')return '正在停止模型与工具，确认退出后可继续。';
  if(task.kind==='agent'&&task.status==='completed')return task.permission==='read-only'||task.mode==='analysis'?'本轮已结束；请查看报告和工具记录。':['general','documents'].includes(task.workspaceMode)?'本轮已结束；请查看报告、工具步骤和结果文件。':'本轮已结束；请查看报告、工具退出码和文件差异。';
  if(task.status==='cancelling')return '正在停止作业并确认进程退出。';
  if(task.status==='interrupted')return '服务中断，执行已停止；已完成的文件修改仍然保留。';
  if(task.status==='failed')return task.exitCode!=null?`命令退出码 ${task.exitCode}，请查看日志。`:'作业未能完成，请查看日志与运行环境。';
  if(task.status==='cancelled')return '已停止后续执行，已保存的文件不会撤销。';
  return '';
}
export function taskDuration(task,now=Date.now()){
  if(!task.startedAt)return task.status==='queued'?'等待执行':'未启动';
  const seconds=Math.max(0,Math.floor(((task.finishedAt??now)-task.startedAt)/1000));
  return seconds<60?`${seconds} 秒`:`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;
}
export function appendTaskLog(current,chunk,maxChars=120000){
  if(current.runId!==chunk.runId||current.offset!==chunk.offset)return current;
  const text=current.text+chunk.text;
  return {...current,text:text.slice(-maxChars),offset:chunk.nextOffset,earlier:current.earlier||text.length>maxChars,truncated:chunk.truncated};
}
