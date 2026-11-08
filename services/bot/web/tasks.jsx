import React,{useEffect,useRef,useState} from 'react';
import {TeamPanel,AssigneeSelect} from './team.jsx';
import {AgentTaskForm,AgentTaskDetail} from './agent-tasks.jsx';
import {TeamOverview,TeamWatch} from './team-overview.jsx';
import {taskPages} from './team-overview-view.mjs';
import {TeamResults,TaskCoordination} from './team-results.jsx';
import {reviewLabels,reviewConflict,employeeTask} from './team-view.mjs';
import {errorText} from './api.mjs';
import {taskLabels,activeTask,taskReason,taskDuration,appendTaskLog,taskActivityText,taskClosureStatus,taskClosureLabel,taskUnavailable} from './task-view.mjs';
import {SkillLibrary} from './skills.jsx';

export function TaskCard({task,onOpen}){
  return <button type="button" className="task-card" onClick={()=>onOpen(task.id)}>
    <span className="task-card-title">{task.title}{task.unread&&<i aria-label="未读结果"/>}</span>
    {task.ownerName&&<span className="task-card-hint">负责人：{task.ownerName}{!employeeTask(task)?' · 总管亲自执行':''}{task.ownershipOrigin==='legacy'?' · 历史任务':''}</span>}
    <span className={'task-status '+task.status}>{taskClosureLabel(task)&&taskClosureLabel(task)+' · '}{task.kind==='agent'?'Agent · ':''}{taskLabels[task.status]||task.status} · {taskDuration(task)}</span>
    {task.reviewStatus&&<span className={'team-review-status '+task.reviewStatus}>{reviewLabels[task.reviewStatus]||task.reviewStatus}</span>}
    {task.blockedReason&&<span className="task-card-hint">等待前置任务或交接完成</span>}
    <span className="task-card-hint">{taskReason(task)||'查看详情与日志'}<span aria-hidden="true"> →</span></span>
  </button>;
}

export function TaskPanel({api,summary,team,selectedId,onSelect,online,busy}){
  const [detail,setDetail]=useState(null),[error,setError]=useState(''),[pending,setPending]=useState(false);
  const [connectionError,setConnectionError]=useState(''),[notice,setNotice]=useState('');
  const [owner,setOwner]=useState('all');
  const [filter,setFilter]=useState('all'),[page,setPage]=useState(null),[pageLimit,setPageLimit]=useState(50);
  const [overview,setOverview]=useState(null),[overviewError,setOverviewError]=useState(''),[overviewVersion,setOverviewVersion]=useState(0);
  const [historyOpen,setHistoryOpen]=useState(false),[listLoading,setListLoading]=useState(false);
  const [runId,setRunId]=useState(null),[log,setLog]=useState(null),[clock,setClock]=useState(Date.now());
  const [form,setForm]=useState({title:'',command:'',workdir:'.',artifacts:'',minutes:'30'});
  const submission=useRef(null),retryAction=useRef(null),closureAction=useRef(null),closureBusy=useRef(false),detailVersion=useRef(0),logRef=useRef(null),selectedRef=useRef(selectedId);
  selectedRef.current=selectedId;
  useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{
    let stopped=false;setListLoading(true);
    const refresh=async()=>{
      try{
        const result=await taskPages(api,{owner,filter,pageLimit,stopped:()=>stopped});
        if(!stopped){setPage({...result,scope:owner+':'+filter});setConnectionError('');}
      }catch(e){if(!stopped)setConnectionError(errorText(e));}finally{if(!stopped)setListLoading(false);}
    };
    void refresh();return()=>{stopped=true;};
  },[summary,pageLimit,owner,filter,online,overviewVersion]);
  useEffect(()=>{
    let stopped=false;
    const refresh=async()=>{try{const value=await api.call('team-overview',{...(owner==='all'?{}:{ownerId:owner}),limit:3});if(!stopped){setOverview({...value,owner});setOverviewError('');}}catch(e){if(!stopped)setOverviewError(errorText(e));}};
    void refresh();return()=>{stopped=true;};
  },[summary,owner,online,overviewVersion]);
  useEffect(()=>{
    setDetail(null);setRunId(null);setError('');setConnectionError('');setNotice('');retryAction.current=null;closureAction.current=null;detailVersion.current++;
    if(!selectedId)return;
    let stopped=false,timer;
    const refresh=async()=>{
      try{
        const version=detailVersion.current;
        const value=await api.call('background-task',{id:selectedId});
        if(stopped)return;
        if(version===detailVersion.current){setDetail(value);setConnectionError('');}
        if(value.task.unread)await api.call('background-task-read',{id:selectedId,runId:value.task.runId});
      }catch(e){if(!stopped)setConnectionError(errorText(e));}
      if(!stopped)timer=setTimeout(refresh,1000);
    };
    void refresh();return()=>{stopped=true;clearTimeout(timer);};
  },[selectedId]);
  const currentRun=detail?.runs.find(run=>run.id===(runId||detail.task.runId));
  const logRun=currentRun?.id;
  useEffect(()=>{
    logRef.current={runId:logRun,offset:0,text:'',earlier:false};setLog(logRef.current);
    if(!selectedId||!logRun)return;
    let stopped=false,timer;
    const refresh=async()=>{
      let more=false;
      try{
        const chunk=await api.call('background-task-log',{id:selectedId,runId:logRun,offset:logRef.current.offset});
        if(stopped)return;
        logRef.current=appendTaskLog(logRef.current,chunk);setLog(logRef.current);more=chunk.hasMore;
      }catch(e){if(!stopped)setConnectionError(errorText(e));}
      if(!stopped)timer=setTimeout(refresh,more?30:1000);
    };
    void refresh();return()=>{stopped=true;clearTimeout(timer);};
  },[selectedId,logRun]);
  async function action(name,body,{rethrow=false}={}){
    setPending(true);setError('');setNotice('');
    try{
      const value=await api.call(name,body);
      if(name==='background-task-open'||name==='tasks/report-artifact'){
        if(value.status!=='dispatched')throw Error(value.error||'open_failed');
        setNotice('已向本机应用发送打开请求。');
      }
      if(value.task&&value.task.id===selectedRef.current){detailVersion.current++;setDetail(value);}return value;
    }
    catch(e){
      if(name==='background-task-start'&&e.code!=='network')submission.current=null;
      setError(errorText(e));
      if(reviewConflict(e)&&selectedRef.current){try{const latest=await api.call('background-task',{id:selectedRef.current});if(latest.task.id===selectedRef.current){detailVersion.current++;setDetail(latest);setRunId(null);setNotice('任务或成果已有更新，已切换到最新记录，请核对后再操作。');}}catch{}}
      if(rethrow)throw e;
    }finally{setPending(false);}
  }
  async function submit(event){
    event.preventDefault();
    if(!submission.current)submission.current={id:crypto.randomUUID(),assignedBotId:form.assignedBotId||undefined,title:form.title,command:form.command,workdir:form.workdir,timeoutMs:Number(form.minutes)*60000,artifacts:form.artifacts.split('\n').map(s=>s.trim()).filter(Boolean)};
    const value=await action('background-task-start',submission.current);
    if(value){submission.current=null;setForm({title:'',command:'',workdir:'.',artifacts:'',minutes:'30'});onSelect(value.task.id);}
  }
  async function retry(){
    const task=detail.task;
    if(retryAction.current?.runId!==task.runId)retryAction.current={id:task.id,runId:task.runId,actionId:crypto.randomUUID()};
    const value=await action('background-task-retry',retryAction.current);if(value)setRunId(null);
  }
  async function changeClosure(name){
    if(closureBusy.current||pending||!online)return;
    const task=detail.task;if((name==='background-task-close'&&taskUnavailable(task))||(name==='background-task-reopen'&&taskClosureStatus(task)!=='closed'))return;
    const binding={id:task.id,runId:task.runId,...(name==='background-task-close'?{assignmentVersion:task.assignmentVersion}:{})};
    const key=JSON.stringify([name,binding]);
    if(closureAction.current?.key!==key)closureAction.current={key,body:{...binding,actionId:crypto.randomUUID()}};
    closureBusy.current=true;
    try{
      const value=await action(name,closureAction.current.body);
      if(value){
        closureAction.current=null;setPage(null);setOverview(null);setOverviewVersion(n=>n+1);
        if(name==='background-task-reopen')setNotice('已恢复到任务列表，尚未启动执行；自动接续和总管跟进保持暂停。');
      }
    }finally{closureBusy.current=false;}
  }
  const currentPage=page?.scope===owner+':'+filter?page:null;
  const tasks=currentPage?.tasks??(owner==='all'&&filter==='all'?(summary?.tasks??[]).filter(task=>taskClosureStatus(task)!=='closed'):[]);
  const choices=[...new Map([...(summary?.tasks??[]),...tasks].filter(task=>!taskUnavailable(task)).map(task=>[task.id,task])).values()];
  const currentOverview=overview?.owner===owner?overview:null;
  const chooseOwner=value=>{setOwner(value);setPageLimit(50);};
  const chooseFilter=value=>{setFilter(value);setPageLimit(50);setHistoryOpen(true);};
  return <section className="task-panel" aria-label="后台任务">
    <div className="task-heading"><h2>{selectedId?'任务详情':'后台任务'}</h2>{selectedId&&<button type="button" onClick={()=>onSelect(null)}>返回列表</button>}</div>
    {(error||connectionError)&&<p className="error" role="alert">{error||connectionError}</p>}
    {notice&&<p className="task-intro" role="status">{notice}</p>}
    {summary?.problem&&<p className="error" role="alert">任务调度暂时不可用，已保存的任务仍可查看。请检查服务日志。</p>}
    {!selectedId?<>
      {team&&<label className="team-owner-filter">按负责人筛选<select value={owner} onChange={e=>chooseOwner(e.target.value)}><option value="all">全部员工与总管</option>{team.members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>}
      {overviewError&&<p className="error" role="alert">团队总览暂时未能刷新：{overviewError}</p>}
      <TeamOverview overview={currentOverview} owner={owner} onSelect={onSelect} onOwner={chooseOwner} onFilter={chooseFilter}/>
      <TeamWatch key={'watch:'+owner} api={api} watch={currentOverview?.watch} owner={owner} disabled={!online||pending} onSelect={onSelect} onRefresh={()=>setOverviewVersion(n=>n+1)}/>
      <details className="team-management"><summary>管理员工</summary><TeamPanel api={api} team={team} disabled={!online||busy} onSelect={onSelect}/></details>
      <SkillLibrary api={api} disabled={!online||busy||pending}/>
      <details className="task-history" open={historyOpen} onToggle={event=>setHistoryOpen(event.currentTarget.open)}><summary>任务记录{currentPage?` · ${currentPage.total??tasks.length} 项`:''}</summary>
        <div className="task-filters" aria-label="任务筛选">{[['all','全部'],['active','进行中'],['attention','需要你处理'],['recent','最近成果'],['closed','已关闭']].map(([value,label])=><button key={value} type="button" aria-pressed={filter===value} onClick={()=>chooseFilter(value)}>{label}</button>)}</div>
        <div className="task-list">{tasks.map(task=><TaskCard key={task.id} task={task} onOpen={onSelect}/>)}{!tasks.length&&<p className="task-empty">{listLoading?'正在读取任务…':'这里暂时没有任务。'}</p>}</div>
        {currentPage?.hasMore&&<button className="task-more" type="button" disabled={listLoading} onClick={()=>setPageLimit(n=>n+50)}>{listLoading?'正在读取…':'加载更多任务'}</button>}
      </details>
      <p className="task-intro">可以直接对 Nova 说任务要求，或补充员工需要的信息。任务执行期间，你可以继续聊天。</p>
      <AgentTaskForm api={api} team={team} tasks={choices} action={action} onSelect={onSelect} disabled={!online||pending}/>
      <details className="task-create"><summary>直接运行命令</summary>
        <form onSubmit={submit}>
          <AssigneeSelect team={team} value={form.assignedBotId} onChange={v=>setForm({...form,assignedBotId:v})}/>
          <label>任务名称<input required maxLength={160} value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></label>
          <label>命令<textarea required maxLength={16000} rows={3} value={form.command} onChange={e=>setForm({...form,command:e.target.value})}/></label>
          <label>项目内工作目录<input required value={form.workdir} onChange={e=>setForm({...form,workdir:e.target.value})}/></label>
          <label>最长运行时间（分钟）<input required type="number" min={1} max={120} value={form.minutes} onChange={e=>setForm({...form,minutes:e.target.value})}/></label>
          <label>结果文件（可选，每行一个相对路径）<textarea rows={2} value={form.artifacts} onChange={e=>setForm({...form,artifacts:e.target.value})}/></label>
          {submission.current&&<p className="subtle">重试会核对上次提交的同一任务，当前编辑内容不会重新提交。</p>}
          <button className="task-primary" type="submit" disabled={!online||pending}>{pending?'正在提交…':submission.current?'重试提交':'提交后台任务'}</button>
        </form>
      </details>
    </>:detail?<>
      <h3 className="task-title">{detail.task.title}</h3>
      {detail.task.ownerName&&<p>负责人：{detail.task.ownerName} · {employeeTask(detail.task)?'员工任务':'总管亲自执行'}</p>}
      {currentRun?.employee&&<details className="task-command"><summary>本轮职责快照</summary><p>{currentRun.employee.name} · {currentRun.employee.role}</p><p>{currentRun.employee.instructions}</p></details>}
      <p className={'task-status '+detail.task.status} role="status">{taskClosureLabel(detail.task)&&taskClosureLabel(detail.task)+' · '}{taskLabels[detail.task.status]} · {taskDuration(detail.task,clock)}</p>
      {taskReason(detail.task)&&<p className="task-intro">{taskReason(detail.task)}</p>}
      <div className="task-actions">
        {!taskUnavailable(detail.task)&&activeTask(detail.task)&&<button type="button" disabled={!online||pending||detail.task.status==='cancelling'} onClick={()=>void action('background-task-cancel',{id:detail.task.id,runId:detail.task.runId})}>{detail.task.status==='cancelling'?'正在停止…':'取消执行'}</button>}
        {!taskUnavailable(detail.task)&&detail.task.canRetry&&<button type="button" disabled={!online||pending} onClick={()=>void retry()}>重新执行</button>}
        {!detail.task.parentClosure&&(taskClosureStatus(detail.task)==='closed'?<button type="button" disabled={!online||pending||detail.task.canReopen===false||!!detail.task.parentClosure} onClick={()=>void changeClosure('background-task-reopen')}>恢复到任务列表</button>:taskClosureStatus(detail.task)==='closing'?<button type="button" disabled>正在关闭…</button>:!taskUnavailable(detail.task)&&!detail.task.managementReview&&detail.task.canClose!==false&&<button type="button" disabled={!online||pending} onClick={()=>void changeClosure('background-task-close')}>关闭任务</button>)}
        {detail.task.parentClosure&&<button type="button" onClick={()=>onSelect(detail.task.parentClosure.id)}>查看所属任务</button>}
      </div>
      {!taskUnavailable(detail.task)&&!detail.task.managementReview&&detail.task.canClose!==false&&<p className="subtle">关闭会停止后续执行并移出任务列表，保留历史和成果，可在“已关闭”中恢复。</p>}
      {detail.task.kind!=='agent'&&<details className="task-command"><summary>执行命令与目录</summary><pre>{detail.task.command}</pre><p>{detail.task.cwd}</p><p>任务 ID：{detail.task.id}</p><p>执行 ID：{detail.task.runId}</p><p>最长运行 {detail.task.timeoutMs/60000} 分钟</p></details>}
      <label className="task-attempt">执行记录<select value={logRun||''} onChange={e=>setRunId(e.target.value)}>{detail.runs.map(run=><option key={run.id} value={run.id}>第 {run.number} 次 · {taskLabels[run.status]}</option>)}</select></label>
      {!taskUnavailable(detail.task)&&taskActivityText(currentRun,clock)&&<p className="task-intro" aria-label="执行活动">{taskActivityText(currentRun,clock)}</p>}
      <TeamResults api={api} detail={detail} currentRun={currentRun} action={action} disabled={!online||pending} busy={busy}/>
      <TaskCoordination key={'coordination:'+detail.task.id} detail={detail} team={team} tasks={choices} action={action} disabled={!online||pending}/>
      {detail.task.kind==='agent'&&<AgentTaskDetail api={api} key={detail.task.id} detail={detail} currentRun={currentRun} action={action} disabled={!online||pending} busy={busy} onSelect={onSelect}/>}
      <h4>运行日志</h4>
      {log?.earlier&&<p className="subtle">显示最近的日志；完整已保存日志可按下方路径查看。</p>}
      {(log?.truncated||currentRun?.job.truncated)&&<p className="subtle">日志已达到 8 MB 保存上限，后续输出仍会读取，命令继续执行。</p>}
      <pre className="task-log" aria-label="任务日志">{log?.text||'暂时没有输出。'}</pre>
      <details className="task-command"><summary>已保存日志的位置</summary><p>{currentRun?.job.logPath}</p></details>
      {currentRun?.job.exitCode!=null&&<p className="subtle">退出码：{currentRun.job.exitCode}</p>}
      {![detail.teamReview?.current,...(detail.teamReview?.history??[])].some(report=>report?.runId===currentRun?.id)&&(detail.task.kind!=='agent'||['general','documents'].includes(detail.task.workspaceMode))&&<><h4>结果文件</h4>
      {currentRun?.job.artifacts?.length?<ul className="task-artifacts">{currentRun.job.artifacts.map(file=><li key={file.id}><span>{file.name}</span>{file.status==='available'?<button type="button" disabled={!online||busy||pending} onClick={()=>void action('background-task-open',{id:detail.task.id,runId:currentRun.id,artifactId:file.id,actionId:crypto.randomUUID()})}>打开文件</button>:<small>未生成或不可读取</small>}</li>)}</ul>:<p className="subtle">{detail.task.kind==='agent'?'本轮暂无交付文件；任务结束后在此展示，文字结果可查看本轮报告。':detail.task.artifacts.length?'任务结束后核对结果文件。':'未指定结果文件。执行结果可查看上方日志。'}</p>}</>}
    </>:<p className="task-empty">正在读取任务…</p>}
  </section>;
}
