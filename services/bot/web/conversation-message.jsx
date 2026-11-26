import React from 'react';
import {Bubbles} from '@opennova/ds-bot/cells.js';
import {UserMessageCell} from '@opennova/ds-bot/user-message.js';
import {OperationCard} from './operation-card.jsx';
import {ResearchSources} from './research-sources.jsx';
import {researchPhaseLabel} from './research-view.mjs';
import {modelRetryLabel} from '../../agent/model-retry.mjs';
import {replyPresentation} from './reply-stream.mjs';
import {requestFailure} from './request-view.mjs';
import {errorText} from './api.mjs';
import {TaskCard} from './tasks.jsx';
import {GeneratedImage} from './generated-image.jsx';

export function ConversationMessage({message,replyStream,roster,botId,sessionId,actions,tasks=[],operations=[],busy,online,onAction,onOpenTask,api,project,onImageAction,onRefresh,visibleReviewIds}){
  const time=new Date(message.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  if(message.kind==='task_notification')return <section className="exchange task-notification" data-notification-id={message.id} aria-label={message.notificationObsolete?'历史任务汇报':'任务汇报'}>
    <div className="message-meta">任务汇报 · {time}</div>
    <div className="assistant-message">
      <div className="speaker-label"><span/> NOVA</div>
      {message.notificationObsolete&&<p className="notification-history">历史汇报 · 任务状态已更新，请以任务详情为准。</p>}
      <Bubbles texts={[message.text]} roster={roster} selfId={botId} sessionId={sessionId} actions={actions}/>
      {message.taskId&&<button type="button" className="notification-task-link" aria-label={'查看任务：'+(message.taskTitle||'任务详情')} onClick={()=>onOpenTask(message.taskId)}>查看任务 <span aria-hidden="true">→</span></button>}
    </div>
  </section>;
  const preview=replyPresentation(message,replyStream);
  const failure=requestFailure(message);
  const savedMedia=operation=>project&&operations.filter(op=>op.operation===operation&&
    op.status==='completed'&&op.projectId===project.projectId&&op.artifact&&(
      operation==='image_generate'?op.file?.id:op.artifacts?.gif?.path
    )).map(record=><GeneratedImage key={record.id} record={record} api={api} project={project} disabled={busy||!online} onAction={onImageAction}/>);
  return <section className="exchange" data-request-id={message.id}>
    <div className="message-meta">{message.source==='voice'?'语音':message.source==='web'?'文字':'终端'} · {time}</div>
    <UserMessageCell node={{data:{content:[{type:'text',text:message.input}],time:message.createdAt}}} sessionId={sessionId} useRoster={select=>select(roster)} actions={actions}/>
    <div className="assistant-message">{tasks.filter(t=>t.requestId===message.id).map(task=><TaskCard key={task.id} task={task} onOpen={onOpenTask}/>)}<div className="speaker-label"><span/> NOVA</div>
      {!!operations.length&&<div className="inline-operations" aria-label="本轮操作">{operations.map(record=><OperationCard key={record.id} record={record} disabled={busy||!online} onAction={onAction} api={api} project={project} offline={!online} onRefresh={onRefresh} visibleReviewIds={visibleReviewIds}/>)}</div>}
      {savedMedia('image_generate')}
      {message.status==='completed'&&!failure?<><Bubbles texts={[message.text||'本轮已完成。']} roster={roster} selfId={botId} sessionId={sessionId} actions={actions}/><ResearchSources sources={message.sources} derivations={message.derivations}/></>:<>
        {preview&&<div className={'reply-draft'+(preview.interrupted?' interrupted':'')} aria-label={preview.interrupted?'未完成的回答':'生成中的回答'} aria-busy={!preview.interrupted}>
          <Bubbles texts={[preview.text]} roster={roster} selfId={botId} sessionId={sessionId} actions={actions}/>
          <p className={'turn-status '+(preview.interrupted?'':'working')} role="status">{preview.label}</p>
        </div>}
        {(!preview||preview.interrupted)&&<p className={'turn-status '+(failure?'error':['queued','running'].includes(message.status)?'working':'')} role="status" aria-label={failure?'本轮失败':undefined}>{failure?failure.text:message.status==='queued'?'正在等待…':message.status==='running'?(modelRetryLabel(message)||researchPhaseLabel(message)||(message.phase==='tool'?'正在处理工作内容…':'正在思考…')):errorText({message:message.error||message.status,code:message.status,diagnostic:message.diagnostic})}</p>}
        {failure&&<details className="other-operations turn-diagnostic"><summary>错误详情</summary><p>{failure.details}</p></details>}
      </>}
      {savedMedia('gif_generate')}
    </div>
  </section>;
}

/** Only suppress unread cards whose current result is already in this loaded conversation page. */
export function uncoveredTaskNotices(tasks,messages){
  const notifications=messages.filter(message=>message.kind==='task_notification'&&!message.notificationObsolete);
  return tasks.filter(task=>task.unread&&!notifications.some(message=>message.taskId===task.id&&message.runId===task.runId&&(!task.reportId||message.reportId===task.reportId)));
}

export function TaskNotices({tasks=[],messages=[],onOpenTask}){
  const uncovered=uncoveredTaskNotices(tasks,messages).slice(0,3);
  return uncovered.length?<div className="task-notice" role="status"><p>后台任务有新结果</p>{uncovered.map(task=><TaskCard key={task.id} task={task} onOpen={onOpenTask}/>)}</div>:null;
}
