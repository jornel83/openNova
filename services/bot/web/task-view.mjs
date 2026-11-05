export const taskLabels={paused:'已暂停',pausing:'暂停中',waiting_input:'等待补充',queued:'排队中',running:'运行中',cancelling:'取消中',completed:'已完成',failed:'执行失败',cancelled:'已取消',interrupted:'异常中断'};
export const activeTask=task=>['queued','running','pausing','cancelling'].includes(task.status);
export function taskReason(task){
  if(task.error==='task_timeout')return '执行超过时限，作业已停止。';
  if(task.cleanupConfirmed===false&&!activeTask(task))return '旧作业是否停止尚未确认，后续任务暂缓执行。请核对运行环境。';
  if(task.status==='paused')return '工作会话和文件已保留，可以补充要求后接续。';
  if(task.status==='waiting_input')return task.question||'需要补充信息后继续。';
  if(task.status==='pausing')return '正在停止模型与工具，确认退出后可继续。';
  if(task.kind==='agent'&&task.status==='completed')return '本轮已结束；请查看报告、工具退出码和文件差异。';
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
