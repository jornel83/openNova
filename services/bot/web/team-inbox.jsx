import React from 'react';
import {inboxTasks,inboxText,reviewLabels} from './team-view.mjs';
export function TeamInbox({tasks,onSelect}){
  const items=inboxTasks(tasks);if(!items.length)return null;
  return <section className="team-inbox" aria-label="待你处理"><div className="task-heading"><h3>待你处理</h3><span>{items.length} 项</span></div>
    <p className="subtle">总管把需要你判断或补充信息的工作放在这里。</p>
    {items.map(task=><article className="team-inbox-item" key={task.id}><strong>{task.title}</strong><span>{task.ownerName||'总管'} · {reviewLabels[task.reviewStatus]||'等待补充'}</span><p>{inboxText(task)}</p><button type="button" onClick={()=>onSelect(task.id)}>查看成果并处理</button></article>)}
  </section>;
}
