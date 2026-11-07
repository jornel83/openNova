import React,{useEffect,useRef,useState} from 'react';
import {errorText} from './api.mjs';
import {taskLabels} from './task-view.mjs';
import {reviewLabels} from './team-view.mjs';
import {attentionText,memberStatusLabels,watchTypeLabels,watchPolicyDraft,watchPolicyBody,watchError} from './team-overview-view.mjs';

function OverviewGroup({name,count=0,tasks=[],kind,onSelect,onFilter}){
  return <section className={'team-overview-group '+kind} aria-label={name}>
    <div className="task-heading"><h3>{name} <span className="team-count">{count}</span></h3>{count>tasks.length&&onFilter&&<button type="button" onClick={onFilter}>查看全部</button>}</div>
    <div className="team-overview-rows">{tasks.map(task=><button key={task.id} type="button" className="team-overview-row" onClick={()=>onSelect(task.id)}>
      <strong>{task.title}</strong>
      <span>{task.ownerName||'总管'} · {taskLabels[task.status]||task.status}{task.reviewStatus?' · '+(reviewLabels[task.reviewStatus]||task.reviewStatus):''}</span>
      {kind==='attention'&&<small>{attentionText(task)}</small>}
      {kind==='recent'&&task.resultSummary&&<small className="team-result-excerpt">{task.resultSummary}</small>}
      {kind==='recent'&&!!task.artifactNames?.length&&<small className="team-result-files">交付：{task.artifactNames.join('、')}</small>}
    </button>)}{!tasks.length&&<p className="subtle">{kind==='active'?'目前没有正在执行的任务。':kind==='attention'?'目前没有需要你处理的事项。':'任务完成后，成果会显示在这里。'}</p>}</div>
  </section>;
}

export function TeamOverview({overview,onSelect,onOwner,onFilter,owner='all'}){
  if(!overview)return <p className="task-intro" role="status">正在读取团队总览…</p>;
  const counts=overview.counts??{};
  return <section className="team-overview" aria-label="团队总览">
    <OverviewGroup name="正在做" count={counts.active} tasks={overview.active} kind="active" onSelect={onSelect} onFilter={()=>onFilter('active')}/>
    <OverviewGroup name="需要你处理" count={counts.attention} tasks={overview.attention} kind="attention" onSelect={onSelect} onFilter={()=>onFilter('attention')}/>
    <OverviewGroup name="最近成果" count={counts.recent} tasks={overview.recent} kind="recent" onSelect={onSelect} onFilter={()=>onFilter('recent')}/>
    <p className="team-overview-caption">共 {counts.total??0} 项任务 · 已完成 {counts.completed??0} · 已验收记录 {counts.accepted??0}</p>
    {!!overview.members?.length&&<details className="team-members-overview"><summary>员工状态 · {overview.members.length} 位</summary><div className="team-member-rows">{overview.members.map(member=><article key={member.id}>
      <button type="button" className="team-member-select" aria-pressed={owner===member.id} onClick={()=>onOwner(owner===member.id?'all':member.id)}><strong>{member.name}</strong><span>{member.role} · {memberStatusLabels[member.status]||member.status}</span><small>正在做 {member.activeCount??0} · 待处理 {member.attentionCount??0}</small></button>
      {member.latestResult&&<button type="button" className="team-member-result" onClick={()=>onSelect(member.latestResult.taskId||member.latestResult.id)}>最近成果：{member.latestResult.title||'查看成果'}</button>}
    </article>)}</div></details>}
  </section>;
}

export function TeamWatch({api,watch,disabled,onRefresh,onSelect,owner='all'}){
  const [draft,setDraft]=useState(()=>watchPolicyDraft(watch?.policy)),[pending,setPending]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [pageLimit,setPageLimit]=useState(0),[page,setPage]=useState(null),[loading,setLoading]=useState(false);
  const submission=useRef(null),revision=watch?.policy?.revision;
  useEffect(()=>{if(watch?.policy){setDraft(watchPolicyDraft(watch.policy));submission.current=null;}},[revision]);
  useEffect(()=>{
    if(!pageLimit)return;
    let stopped=false;setLoading(true);
    const load=async()=>{try{let value,alerts=[];for(let offset=0;offset<pageLimit;offset+=50){value=await api.call('team-watch',{...(owner==='all'?{}:{ownerId:owner}),limit:50,offset});if(stopped)return;alerts.push(...value.alerts);if(!value.hasMore)break;}if(!stopped)setPage({...value,alerts:[...new Map(alerts.map(alert=>[alert.id,alert])).values()]});}catch(e){if(!stopped)setError(watchError(e)||errorText(e));}finally{if(!stopped)setLoading(false);}};
    void load();return()=>{stopped=true;};
  },[watch,owner,pageLimit]);
  if(!watch?.policy)return null;
  const body=watchPolicyBody(draft),view=page??watch,alerts=view.alerts??[];
  async function refresh(){try{setPage(null);await onRefresh();}catch{}}
  async function save(event){
    event.preventDefault();if(!body||pending||disabled)return;
    submission.current??={...body,actionId:crypto.randomUUID()};setPending('policy');setError('');setNotice('');
    try{const result=await api.call('team-watch-policy',submission.current);submission.current=null;setDraft(watchPolicyDraft(result.policy));setNotice('值守设置已保存。');await refresh();}
    catch(e){setError(watchError(e)||errorText(e));if(e.code!=='network'){submission.current=null;await refresh();}}
    finally{setPending('');}
  }
  async function acknowledge(alert){
    if(pending||disabled)return;setPending(alert.id);setError('');setNotice('');
    try{await api.call('team-watch-ack',{id:alert.id,taskId:alert.taskId,runId:alert.runId,assignmentVersion:alert.assignmentVersion,actionId:crypto.randomUUID()});setNotice('已知晓这条提醒。');await refresh();}
    catch(e){setError(watchError(e)||errorText(e));if(e.code!=='network')await refresh();}
    finally{setPending('');}
  }
  const change=(key,value)=>setDraft(current=>({...current,[key]:value}));
  return <details className="team-watch"><summary>总管值守 · {watch.policy.enabled?'已开启':'已关闭'}{watch.unacknowledged>0?` · ${watch.unacknowledged} 条待知晓`:''}</summary>
    <p className="subtle">提醒即将到期、逾期、等待较久或一段时间没有进展的任务。长期无进度只会提醒，由你决定是否接续或取消。</p>
    {watch.problem&&<p className="error" role="alert">值守检查暂时不可用，请检查服务日志。任务记录仍可查看。</p>}
    {error&&<p className="error" role="alert">{error}</p>}{notice&&<p className="task-intro" role="status">{notice}</p>}
    <WatchAlerts alerts={alerts} total={view.total} pending={pending} disabled={disabled} onAcknowledge={acknowledge} onSelect={onSelect}/>
    {(view.hasMore||view.total>alerts.length)&&<button className="task-more" type="button" disabled={loading} onClick={()=>setPageLimit(n=>Math.max(n,alerts.length)+50)}>{loading?'正在读取…':'加载更多提醒'}</button>}
    <details className="team-watch-settings"><summary>值守设置</summary><form onSubmit={save}>
      <label className="task-check"><input type="checkbox" checked={draft.enabled} disabled={disabled||!!pending} onChange={e=>change('enabled',e.target.checked)}/>启用总管值守</label>
      {[['dueSoonMinutes','到期前提醒（分钟）'],['blockedMinutes','等待较久提醒（分钟）'],['inactiveMinutes','无新进展提醒（分钟）']].map(([field,label])=><label key={field}>{label}<input type="number" min="0" max="10080" step="any" required value={draft[field]} disabled={disabled||!!pending} onChange={e=>change(field,e.target.value)}/></label>)}
      <p className="subtle">填 0 关闭该类时间提醒；“到期前提醒”不影响已经逾期的提醒。</p>
      <label className="task-check"><input type="checkbox" checked={draft.raiseQueuedPriority} disabled={disabled||!!pending} onChange={e=>change('raiseQueuedPriority',e.target.checked)}/>允许提高逾期任务的排队优先级</label>
      <p className="subtle">默认关闭。开启后仅调整排队任务的顺序，不会增加执行权限、预算或自动重试。</p>
      {submission.current&&<p className="subtle">重试会核对上次保存的同一设置，当前编辑不会替换上次提交。</p>}
      <div className="task-actions"><button type="submit" disabled={disabled||!!pending||!body}>{pending==='policy'?'保存中…':submission.current?'重试保存':'保存值守设置'}</button></div>
    </form></details>
  </details>;
}

function WatchAlerts({alerts,total=0,pending,disabled,onAcknowledge,onSelect}){
  return <div className="team-watch-alerts" aria-label="值守提醒">{alerts.map(alert=><article key={alert.id} className={'team-watch-alert '+alert.status}>
    <button type="button" className="team-watch-task" onClick={()=>onSelect?.(alert.taskId)}><strong>{alert.title||watchTypeLabels[alert.type]||'任务提醒'}</strong><span>{alert.ownerName?alert.ownerName+' · ':''}{watchTypeLabels[alert.type]||'任务提醒'}{alert.status==='resolved'?' · 已解除':''}</span><small>{alert.reason}</small></button>
    {!alert.acknowledgedAt&&alert.status!=='resolved'?<div className="task-actions"><button type="button" disabled={disabled||!!pending} onClick={()=>void onAcknowledge(alert)}>{pending===alert.id?'保存中…':'已知晓'}</button></div>:<span className="subtle">{alert.acknowledgedAt?'已知晓':'条件已解除'}</span>}
  </article>)}{!alerts.length&&<p className="subtle">暂无值守提醒。</p>}{total>alerts.length&&<p className="subtle">显示最近 {alerts.length} 条，共 {total} 条提醒。</p>}</div>;
}
