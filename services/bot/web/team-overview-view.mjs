import {inboxText} from './team-view.mjs';

export const memberStatusLabels={idle:'空闲',working:'执行中',running:'执行中',queued:'排队中',blocked:'等待前置条件',waiting_input:'等待信息',waiting_event:'等待事件',paused:'已暂停',disabled:'已停用'};
export const watchTypeLabels={due_soon:'即将到期',overdue:'已逾期',blocked:'等待较久',no_activity:'一段时间没有新进展'};
export function attentionText(task){
  const reasons=(task.reasons??[]).filter(reason=>typeof reason==='string'&&reason.trim());
  return reasons.length?[...new Set(reasons)].join('；'):inboxText(task);
}
export function watchPolicyDraft(policy={}){
  return {revision:policy.revision,enabled:policy.enabled!==false,dueSoonMinutes:String((policy.dueSoonMs??3600000)/60000),blockedMinutes:String((policy.blockedMs??1800000)/60000),inactiveMinutes:String((policy.inactiveMs??1800000)/60000),raiseQueuedPriority:policy.raiseQueuedPriority===true};
}
export function watchPolicyBody(draft){
  const result={revision:draft.revision,enabled:draft.enabled===true,raiseQueuedPriority:draft.raiseQueuedPriority===true};
  for(const [input,field] of [['dueSoonMinutes','dueSoonMs'],['blockedMinutes','blockedMs'],['inactiveMinutes','inactiveMs']]){
    if(String(draft[input]??'').trim()==='')return null;
    const number=Number(draft[input]),milliseconds=Math.round(number*60000);
    if(!Number.isFinite(number)||number<0||number!==0&&(milliseconds<1000||milliseconds>604800000))return null;
    result[field]=milliseconds;
  }
  return result;
}
export function watchError(error){
  return ({invalid_watch_policy:'提醒时间需要为 0 或 1 秒至 7 天，0 表示关闭该类提醒。',watch_policy_changed:'值守设置已被更新，已重新读取，请核对后再保存。',watch_action_conflict:'该操作与已保存的设置不一致，请重新读取后再试。',invalid_watch_ack:'提醒信息不完整，请刷新后再试。',watch_alert_stale:'任务已接续或交接，旧提醒已失效，已重新读取。',unknown_watch_alert:'这条提醒已不存在，已重新读取。',invalid_watch_page:'提醒列表参数无效，请刷新后重试。'})[error?.code||error?.message];
}

/** Every page uses the same server-side scope; local rows are never the filter source. */
export async function taskPages(api,{owner='all',filter='all',pageLimit=50,stopped=()=>false}){
  const rows=[];let result={tasks:[],total:0,hasMore:false};
  for(let offset=0;offset<pageLimit;offset+=50){
    if(stopped())return null;
    result=await api.call('background-tasks',{...(owner==='all'?{}:{ownerId:owner}),filter,limit:50,offset});
    if(stopped())return null;
    rows.push(...result.tasks);if(!result.hasMore)break;
  }
  return {...result,tasks:[...new Map(rows.map(task=>[task.id,task])).values()]};
}
