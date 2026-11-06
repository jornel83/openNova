import React,{useEffect,useRef,useState} from 'react';
import {AssigneeSelect} from './team.jsx';
import {EventRules} from './event-rules.jsx';
import {errorText} from './api.mjs';
import {activeTask,taskLabels,appendTaskLog} from './task-view.mjs';
const fresh={assignedBotId:'',workspaceMode:'code',inputs:'',title:'',goal:'',constraints:'',mode:'edit',minutes:30,maxSteps:32,tokenBudget:200000,autoContinue:0};
export function AgentTaskForm({action,onSelect,disabled,team}){
  const [form,setForm]=useState(fresh),submission=useRef(null);
  const field=(key,value)=>setForm({...form,[key]:value});
  async function submit(e){
    e.preventDefault();submission.current??={...form,assignedBotId:form.assignedBotId||undefined,inputFiles:form.inputs.split('\n').map(s=>s.trim()).filter(Boolean),id:crypto.randomUUID(),kind:'agent',timeoutMs:Number(form.minutes)*60000,maxSteps:Number(form.maxSteps),tokenBudget:Number(form.tokenBudget),autoContinue:form.mode==='edit'&&form.workspaceMode==='code'?Number(form.autoContinue):0};
    try{
      const result=await action('background-task-start',submission.current,{rethrow:true});
      if(result){submission.current=null;setForm(fresh);onSelect(result.task.id);}
    }catch(error){if(error.code!=='network')submission.current=null;}
  }
  return <details className="task-create"><summary>新建 Agent 工作任务</summary><form onSubmit={submit}>
    <label>工作目录类型<select value={form.workspaceMode} onChange={e=>setForm({...form,workspaceMode:e.target.value,assignedBotId:'',autoContinue:0})}><option value="code">代码工程</option><option value="documents">本地资料整理</option></select></label>
    <AssigneeSelect team={team} type={form.workspaceMode} value={form.assignedBotId} onChange={v=>field('assignedBotId',v)}/>
    {form.workspaceMode==='documents'&&<label>输入文件（项目内相对路径，每行一个）<textarea rows={3} value={form.inputs} onChange={e=>field('inputs',e.target.value)}/></label>}
    <label>任务名称<input required maxLength={160} value={form.title} onChange={e=>field('title',e.target.value)}/></label>
    <label>任务目标<textarea required rows={4} maxLength={8000} value={form.goal} onChange={e=>field('goal',e.target.value)}/></label>
    <label>约束与验收要求<textarea rows={3} maxLength={4000} value={form.constraints} onChange={e=>field('constraints',e.target.value)}/></label>
    <label>工作模式<select value={form.mode} onChange={e=>field('mode',e.target.value)}><option value="edit">修改并验证（默认）</option><option value="analysis">只读分析</option></select></label>
    <p className="subtle">{form.mode==='analysis'?'只读取独立工作目录，结果显示在任务报告中；不生成文件、不运行命令。':form.workspaceMode==='documents'?'复制指定文本资料到独立目录，可生成交付文件；不运行命令，不覆盖原资料。':'允许在独立工作目录中读写文件和运行命令。修改完成后可查看差异，再应用到原工程。'}</p>
    {form.mode==='edit'&&form.workspaceMode==='code'&&<><label className="task-check"><input type="checkbox" checked={!!form.autoContinue} onChange={e=>field('autoContinue',e.target.checked?2:0)}/>测试完成后自动接续</label>{!!form.autoContinue&&<label>最多自动接续次数<input required type="number" min={1} max={5} value={form.autoContinue} onChange={e=>field('autoContinue',Number(e.target.value))}/></label>}<p className="subtle">默认关闭。启用后允许 Agent 提交后台验证，结果到达时按规则接续；规则有效期 24 小时。</p></>}
    <label>最长运行时间（分钟）<input type="number" required min={1} max={120} value={form.minutes} onChange={e=>field('minutes',e.target.value)}/></label>
    <details><summary>执行预算</summary><label>最多模型步骤<input required type="number" min={1} max={128} value={form.maxSteps} onChange={e=>field('maxSteps',e.target.value)}/></label><label>Token 预算<input required type="number" min={1000} max={1000000} value={form.tokenBudget} onChange={e=>field('tokenBudget',e.target.value)}/></label></details>
    <button className="task-primary" disabled={disabled} type="submit">{submission.current?'重试原任务提交':'提交 Agent 任务'}</button>
  </form></details>;
}
const deliveryLabels={pending:'待处理',sending:'正在提交',delivered:'已接收',unknown:'接收情况待核对'};
export function AgentTaskDetail({api,detail,currentRun,action,disabled,busy,onSelect}){
  const {task}=detail,[text,setText]=useState(''),[diff,setDiff]=useState(null),[applied,setApplied]=useState(false);
  const actions=useRef(new Map());
  useEffect(()=>{setDiff(null);setApplied(false);},[task.runId]);
  async function dispatch(name,extra={}){
    const key=JSON.stringify([name,task.runId,extra]);if(!actions.current.has(key))actions.current.set(key,crypto.randomUUID());
    return action(name,{id:task.id,runId:task.runId,actionId:actions.current.get(key),messageId:actions.current.get(key),...extra});
  }
  async function send(name){const result=await dispatch(name,{text});if(result)setText('');}
  return <div className="agent-task">
    <p className="task-intro">{task.mode==='edit'?'修改并验证':'只读分析'} · 每轮最多 {task.maxSteps} 个模型步骤 · {task.timeoutMs/60000} 分钟</p>
    <details className="task-command" open><summary>目标与约束</summary><p>{task.goal}</p>{task.constraints&&<p>{task.constraints}</p>}</details>
    {currentRun?.instruction&&<p className="task-intro">本轮接续要求：{currentRun.instruction}</p>}
    {task.question&&<p className="task-question" role="status">需要补充信息：{task.question}</p>}
    <div className="task-actions">{(activeTask(task)||task.status==='waiting_event')&&!['cancelling','pausing'].includes(task.status)&&<button disabled={disabled} onClick={()=>void dispatch('background-task-pause')}>暂停任务</button>}</div>
    <label>补充要求或接续说明<textarea rows={3} maxLength={4000} value={text} onChange={e=>setText(e.target.value)} placeholder="例如：保留原接口，并补充测试"/></label>
    <p className="subtle">补充要求在当前轮次结束后处理。任务已停止时，请点击“接续任务”；需要立即停下请先暂停。</p>
    <div className="task-actions"><button disabled={disabled||!text.trim()} onClick={()=>void send('background-task-message')}>保存补充要求</button>{task.canContinue&&<button disabled={disabled} onClick={()=>void send('background-task-continue')}>接续任务</button>}</div>
    {!!detail.messages?.length&&<details className="task-command"><summary>补充记录（{detail.messages.length}）</summary>{detail.messages.map(m=><p key={m.id}><strong>{deliveryLabels[m.delivery.status]||m.delivery.status}</strong> · {m.text}</p>)}</details>}
    {currentRun?.progress&&<p className="subtle">本轮：{currentRun.progress.steps} 个模型步骤 · {currentRun.progress.toolCalls} 次工具调用 · {currentRun.progress.estimatedTokens?'约 ':''}{currentRun.progress.totalTokens||'暂未报告'} Token{currentRun.progress.estimatedTokens?'（估算）':''}</p>}
    {task.workspaceMode!=='documents'&&<EventRules detail={detail} currentRun={currentRun} action={action} disabled={disabled} onSelect={onSelect}/>}
    <h4>执行步骤</h4>
    {currentRun?.jobs?.length?<ol className="agent-steps">{currentRun.jobs.map(j=><AgentStep key={j.id} api={api} taskId={task.id} runId={currentRun.id} job={j}/>)}</ol>:<p className="subtle">尚无工具执行记录。</p>}
    {currentRun?.result&&<><h4>本轮报告</h4><pre className="task-report">{currentRun.result.text||errorText({message:currentRun.result.error})}</pre></>}
    {task.mode==='edit'&&task.workspaceMode!=='documents'&&<><h4>文件修改</h4><p className="subtle">显示当前工作目录的待应用修改。先查看差异，再应用到原工程；原文件已变化时会停止，不会自动提交 Git。</p><div className="task-actions"><button disabled={disabled||!task.canContinue} onClick={async()=>{const value=await dispatch('background-task-diff');if(value){setDiff(value);setApplied(false);}}}>查看文件差异</button>{diff&&!diff.empty&&!applied&&<button disabled={disabled||busy||!task.canContinue} onClick={async()=>{const value=await dispatch('background-task-apply',{revision:diff.revision});if(value?.application?.status==='applied')setApplied(true);}}>应用到原工程</button>}</div>
      {applied&&<p className="task-intro" role="status">已应用到原工程。</p>}{diff&&<><p className="subtle">{diff.empty?'没有待应用的修改。':`${diff.files.length} 个文件：${diff.files.join('、')}`}</p>{!diff.empty&&<pre className="task-log" aria-label="文件差异">{diff.patch}</pre>}</>}
      {!!detail.applications?.length&&<details className="task-command"><summary>应用记录</summary>{detail.applications.map(a=><p key={a.actionId}>{a.status==='applied'?'已应用':'应用结果待核对，请检查原文件'} · {new Date(a.createdAt).toLocaleString()}</p>)}</details>}
    </>}
    {detail.workspace&&<details className="task-command"><summary>独立工作目录</summary><p>{detail.workspace.path}</p></details>}
  </div>;
}

function AgentStep({api,taskId,runId,job}){
  const [open,setOpen]=useState(false),[log,setLog]=useState(null),[error,setError]=useState('');
  useEffect(()=>{
    if(!open||job.tool!=='task_command')return;
    let stopped=false,timer,current={runId,offset:0,text:'',earlier:false};
    const refresh=async()=>{
      let more=false;
      try{const chunk=await api.call('background-task-log',{id:taskId,runId,stepId:job.id,offset:current.offset});
        if(stopped)return;current=appendTaskLog(current,chunk,24000);setLog(current);setError('');more=chunk.hasMore;
      }catch(e){if(!stopped)setError(errorText(e));}
      if(!stopped)timer=setTimeout(refresh,more?30:1000);
    };void refresh();return()=>{stopped=true;clearTimeout(timer);};
  },[open,taskId,runId,job.id]);
  return <li><details onToggle={e=>setOpen(e.currentTarget.open)}><summary>{job.tool} · {taskLabels[job.status]||job.status}{job.exitCode!=null&&` · 退出码 ${job.exitCode}`}</summary>
    <pre>{JSON.stringify(job.arguments,null,2)}</pre>
    {job.tool==='task_command'?<><pre className="task-log" aria-label="命令步骤日志">{log?.text||job.error||'暂时没有输出。'}</pre>{error&&<p role="alert">{error}</p>}{(log?.earlier||log?.truncated)&&<p className="subtle">这里只显示最近的已保存日志；完整路径见下方。</p>}</>:<pre className="task-log">{job.output||job.error||'执行中…'}</pre>}
    {job.logPath&&<p className="subtle">完整命令日志：{job.logPath}</p>}
  </details></li>;
}
