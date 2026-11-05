import React,{useEffect,useRef,useState} from 'react';
import {AgentTaskForm,AgentTaskDetail} from './agent-tasks.jsx';
import {errorText} from './api.mjs';
import {taskLabels,activeTask,taskReason,taskDuration,appendTaskLog} from './task-view.mjs';

export function TaskCard({task,onOpen}){
  return <button type="button" className="task-card" onClick={()=>onOpen(task.id)}>
    <span className="task-card-title">{task.title}{task.unread&&<i aria-label="未读结果"/>}</span>
    <span className={'task-status '+task.status}>{task.kind==='agent'?'Agent · ':''}{taskLabels[task.status]||task.status} · {taskDuration(task)}</span>
    <span className="task-card-hint">{taskReason(task)||'查看详情与日志'}<span aria-hidden="true"> →</span></span>
  </button>;
}

export function TaskPanel({api,summary,selectedId,onSelect,online,busy}){
  const [detail,setDetail]=useState(null),[error,setError]=useState(''),[pending,setPending]=useState(false);
  const [connectionError,setConnectionError]=useState(''),[notice,setNotice]=useState('');
  const [filter,setFilter]=useState('all'),[page,setPage]=useState(null),[pageLimit,setPageLimit]=useState(50);
  const [runId,setRunId]=useState(null),[log,setLog]=useState(null),[clock,setClock]=useState(Date.now());
  const [form,setForm]=useState({title:'',command:'',workdir:'.',artifacts:'',minutes:'30'});
  const submission=useRef(null),retryAction=useRef(null),logRef=useRef(null),selectedRef=useRef(selectedId);
  selectedRef.current=selectedId;
  useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{
    let stopped=false;
    const refresh=async()=>{
      try{
        const rows=[];let result;
        for(let offset=0;offset<pageLimit;offset+=50){result=await api.call('background-tasks',{limit:50,offset});rows.push(...result.tasks);if(!result.hasMore)break;}
        if(!stopped){setPage({...result,tasks:[...new Map(rows.map(task=>[task.id,task])).values()]});setConnectionError('');}
      }catch(e){if(!stopped)setConnectionError(errorText(e));}
    };
    void refresh();return()=>{stopped=true;};
  },[summary,pageLimit]);
  useEffect(()=>{
    setDetail(null);setRunId(null);setError('');setConnectionError('');setNotice('');retryAction.current=null;
    if(!selectedId)return;
    let stopped=false,timer;
    const refresh=async()=>{
      try{
        const value=await api.call('background-task',{id:selectedId});
        if(stopped)return;
        setDetail(value);setConnectionError('');
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
      if(name==='background-task-open'){
        if(value.status!=='dispatched')throw Error(value.error||'open_failed');
        setNotice('已向本机应用发送打开请求。');
      }
      if(value.task&&value.task.id===selectedRef.current)setDetail(value);return value;
    }
    catch(e){if(name==='background-task-start'&&e.code!=='network')submission.current=null;setError(errorText(e));if(rethrow)throw e;}finally{setPending(false);}
  }
  async function submit(event){
    event.preventDefault();
    if(!submission.current)submission.current={id:crypto.randomUUID(),title:form.title,command:form.command,workdir:form.workdir,timeoutMs:Number(form.minutes)*60000,artifacts:form.artifacts.split('\n').map(s=>s.trim()).filter(Boolean)};
    const value=await action('background-task-start',submission.current);
    if(value){submission.current=null;setForm({title:'',command:'',workdir:'.',artifacts:'',minutes:'30'});onSelect(value.task.id);}
  }
  async function retry(){
    const task=detail.task;
    if(retryAction.current?.runId!==task.runId)retryAction.current={id:task.id,runId:task.runId,actionId:crypto.randomUUID()};
    const value=await action('background-task-retry',retryAction.current);if(value)setRunId(null);
  }
  const tasks=(page??summary)?.tasks??[];
  const filtered=tasks.filter(t=>filter==='all'||filter==='active'&&activeTask(t)||filter==='attention'&&(t.unread||['failed','interrupted','waiting_input','waiting_event','paused'].includes(t.status)));
  return <section className="task-panel" aria-label="后台任务">
    <div className="task-heading"><h2>{selectedId?'任务详情':'后台任务'}</h2>{selectedId&&<button type="button" onClick={()=>onSelect(null)}>返回列表</button>}</div>
    {(error||connectionError)&&<p className="error" role="alert">{error||connectionError}</p>}
    {notice&&<p className="task-intro" role="status">{notice}</p>}
    {summary?.problem&&<p className="error" role="alert">任务调度暂时不可用，已保存的任务仍可查看。请检查服务日志。</p>}
    {!selectedId?<>
      <p className="task-intro">可以对 Nova 说“在后台运行测试”。任务执行期间，你可以继续聊天。</p>
      <div className="task-filters" aria-label="任务筛选">{[['all','全部'],['active','进行中'],['attention','需要关注']].map(([value,label])=><button key={value} type="button" aria-pressed={filter===value} onClick={()=>setFilter(value)}>{label}</button>)}</div>
      <div className="task-list">{filtered.map(task=><TaskCard key={task.id} task={task} onOpen={onSelect}/>)}{!filtered.length&&<p className="task-empty">{tasks.length?'这里暂时没有任务。':'还没有后台任务。'}</p>}</div>
      {page?.hasMore&&<button className="task-more" type="button" onClick={()=>setPageLimit(n=>n+50)}>加载更多任务</button>}
      <AgentTaskForm action={action} onSelect={onSelect} disabled={!online||pending}/>
      <details className="task-create"><summary>直接运行命令</summary>
        <form onSubmit={submit}>
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
      <p className={'task-status '+detail.task.status} role="status">{taskLabels[detail.task.status]} · {taskDuration(detail.task,clock)}</p>
      {taskReason(detail.task)&&<p className="task-intro">{taskReason(detail.task)}</p>}
      <div className="task-actions">
        {activeTask(detail.task)&&<button type="button" disabled={!online||pending||detail.task.status==='cancelling'} onClick={()=>void action('background-task-cancel',{id:detail.task.id,runId:detail.task.runId})}>{detail.task.status==='cancelling'?'正在停止…':'取消任务'}</button>}
        {detail.task.canRetry&&<button type="button" disabled={!online||pending} onClick={()=>void retry()}>重新执行</button>}
      </div>
      {detail.task.kind!=='agent'&&<details className="task-command"><summary>执行命令与目录</summary><pre>{detail.task.command}</pre><p>{detail.task.cwd}</p><p>任务 ID：{detail.task.id}</p><p>执行 ID：{detail.task.runId}</p><p>最长运行 {detail.task.timeoutMs/60000} 分钟</p></details>}
      <label className="task-attempt">执行记录<select value={logRun||''} onChange={e=>setRunId(e.target.value)}>{detail.runs.map(run=><option key={run.id} value={run.id}>第 {run.number} 次 · {taskLabels[run.status]}</option>)}</select></label>
      {detail.task.kind==='agent'&&<AgentTaskDetail api={api} key={detail.task.id} detail={detail} currentRun={currentRun} action={action} disabled={!online||pending} busy={busy} onSelect={onSelect}/>}
      <h4>运行日志</h4>
      {log?.earlier&&<p className="subtle">显示最近的日志；完整已保存日志可按下方路径查看。</p>}
      {(log?.truncated||currentRun?.job.truncated)&&<p className="subtle">日志已达到 8 MB 保存上限，后续输出仍会读取，命令继续执行。</p>}
      <pre className="task-log" aria-label="任务日志">{log?.text||'暂时没有输出。'}</pre>
      <details className="task-command"><summary>已保存日志的位置</summary><p>{currentRun?.job.logPath}</p></details>
      {currentRun?.job.exitCode!=null&&<p className="subtle">退出码：{currentRun.job.exitCode}</p>}
      {detail.task.kind!=='agent'&&<><h4>结果文件</h4>
      {currentRun?.job.artifacts?.length?<ul className="task-artifacts">{currentRun.job.artifacts.map(file=><li key={file.id}><span>{file.name}</span>{file.status==='available'?<button type="button" disabled={!online||busy||pending} onClick={()=>void action('background-task-open',{id:detail.task.id,runId:currentRun.id,artifactId:file.id,actionId:crypto.randomUUID()})}>打开文件</button>:<small>未生成或不可读取</small>}</li>)}</ul>:<p className="subtle">{detail.task.artifacts.length?'任务结束后核对结果文件。':'未指定结果文件。执行结果可查看上方日志。'}</p>}</>}
    </>:<p className="task-empty">正在读取任务…</p>}
  </section>;
}
