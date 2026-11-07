import React,{useEffect,useRef,useState} from 'react';
import {ResearchSources} from './research-sources.jsx';
import {AssigneeSelect} from './team.jsx';
import {taskLabels} from './task-view.mjs';
import {errorText} from './api.mjs';
import {reviewView,reviewLabels,priorityLabels,localDateValue,canEditDependencies,artifactLabel,employeeTask,dependencyReason} from './team-view.mjs';

export function TaskPlanningFields({value,tasks=[],onChange,taskId,disabled=false}){
  const selected=value.dependsOn??[];
  const choices=tasks.filter(t=>t.id!==taskId&&!t.managementReview&&!t.parentTaskId);
  const missing=selected.filter(id=>!choices.some(t=>t.id===id));
  return <details className="task-planning"><summary>优先级、截止时间与前置任务</summary>
    <label>优先级<select disabled={disabled} value={value.priority??'normal'} onChange={e=>onChange({priority:e.target.value})}>{Object.entries(priorityLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
    <label>截止时间（选填）<input disabled={disabled} type="datetime-local" value={value.dueAt??''} onChange={e=>onChange({dueAt:e.target.value})}/></label>
    <fieldset className="task-dependencies" disabled={disabled}><legend>前置任务（可多选）</legend>
      {!choices.length&&!missing.length&&<p className="subtle">暂无其他任务可选。</p>}
      {[...choices,...missing.map(id=>({id,title:'未加载任务 '+id}))].map(t=><label className="task-check" key={t.id}><input type="checkbox" checked={selected.includes(t.id)} onChange={e=>onChange({dependsOn:e.target.checked?[...selected,t.id]:selected.filter(id=>id!==t.id)})}/><span>{t.title}{t.status&&<small> · {taskLabels[t.status]||t.status}</small>}</span></label>)}
    </fieldset><p className="subtle">等待前置成果满足条件后开始。前置成果发生变化时，会提示重新核对。</p>
  </details>;
}

function useBoundAction(action){
  const ids=useRef(new Map());
  return async(name,body)=>{
    const key=JSON.stringify([name,body]);if(!ids.current.has(key))ids.current.set(key,crypto.randomUUID());
    return action(name,{...body,actionId:ids.current.get(key)});
  };
}

export function TeamResults({detail,currentRun,action,disabled=false,busy=false}){
  const view=reviewView(detail,currentRun?.id),{report,review,binding}=view;
  const [text,setText]=useState(''),send=useBoundAction(action);
  useEffect(()=>setText(''),[report?.id]);
  if(!report)return null;
  const evidence=report.evidence??{},execution=evidence.execution??{},commands=evidence.commands??[],checks=evidence.checks??[];
  async function decide(kind){const result=await send('tasks/review',{...binding,action:kind,text:text.trim()||(kind==='accept'?'用户手动验收通过。':'')});if(result)setText('');}
  return <section className="team-results" aria-label="成果与验收">
    <div className="task-heading"><h3>成果与验收</h3><span>第 {report.version} 版</span></div>
    <div className="team-result-states"><span>执行：{taskLabels[report.status]||report.status}</span><span>验收：{reviewLabels[review?.status]||'待查看'}</span></div>
    <p className="subtle">{employeeTask(detail.task)?'员工交付，按验收标准检查。':'总管亲自执行，由你查看成果。'}{report.delivery==='delivered'?' 汇报已送达管理记录。':''}</p>
    {!view.latest&&<p className="team-callout">这是历史成果，仅供查看。请切换到最新执行记录后处理。</p>}
    {view.latest&&view.evidenceChanged&&<p className="team-callout">当前文件或成果快照已有变化，或快照未完整保存。请核对后接续任务，形成新的成果再验收。</p>}
    {view.verificationFailed&&<p className="team-callout">命令或检查没有全部成功，本版暂不能验收。请查看退出码和日志后决定是否返工。</p>}
    <p className="team-result-summary">{report.summary||'尚无文字摘要，请查看执行证据。'}</p>
    {report.question&&<p className="task-question">需要补充：{report.question}</p>}
    {detail.task.acceptanceCriteria&&<details className="task-command"><summary>验收标准</summary><p>{detail.task.acceptanceCriteria}</p></details>}
    <h4>交付文件</h4>
    {report.artifacts?.length?<ul className="task-artifacts team-result-files">{report.artifacts.map(file=><li key={file.id}><div><span>{file.name}</span>{file.sourceStatus==='changed'&&<small>工作目录原件已有新修改，此处为本版成果快照。</small>}{file.sourceStatus==='missing'&&<small>工作目录原件已移除，此处为本版成果快照。</small>}</div><button type="button" disabled={disabled||busy||file.status!=='available'} onClick={()=>void send('tasks/report-artifact',{id:detail.task.id,reportId:report.id,artifactId:file.id})}>{file.status==='available'?'打开成果':artifactLabel(file)}</button></li>)}</ul>:<p className="subtle">此版没有文件成果，可查看摘要与参考来源。</p>}
    <ResearchSources sources={report.sources??[]}/>
    <details className="team-evidence" open><summary>实际执行证据</summary>
      <p>执行状态：{taskLabels[execution.status]||execution.status||'未报告'}{execution.exitCode!=null&&` · 退出码 ${execution.exitCode}`}</p>
      {execution.cleanupConfirmed===false&&<p className="error">作业停止尚未确认，当前不能验收。</p>}
      {commands.map((command,index)=><details className="task-command" key={command.stepId||index}><summary>命令 {index+1} · {taskLabels[command.status]||command.status}{command.exitCode!=null&&` · 退出码 ${command.exitCode}`}</summary>{command.command&&<pre>{command.command}</pre>}{command.workdir&&<p className="subtle">工作目录：{command.workdir}</p>}<pre className="task-log">{command.log||'没有保存的命令输出。'}</pre></details>)}
      {checks.map(check=><details className="task-command" key={check.runId}><summary>{check.title||'后台检查'} · {taskLabels[check.status]||check.status}{check.exitCode!=null&&` · 退出码 ${check.exitCode}`}</summary>{check.command&&<pre>{check.command}</pre>}<pre className="task-log">{check.log||check.output||'没有保存的检查输出。'}</pre></details>)}
      {!!evidence.steps?.length&&<details><summary>工具记录 · {evidence.steps.length} 项</summary><ol className="team-evidence-steps">{evidence.steps.map((step,index)=><li key={step.id||index}><strong>{step.tool}</strong> · {taskLabels[step.status]||step.status}{step.exitCode!=null&&` · 退出码 ${step.exitCode}`}<pre>{step.output||'无保存输出'}</pre></li>)}</ol></details>}
      {!commands.length&&!checks.length&&<p className="subtle">本版没有命令或测试记录；完成摘要不代表测试已通过。</p>}
    </details>
    {review?.decision?.summary&&<p className="team-callout">处理意见：{review.decision.summary}</p>}
    {view.latest&&<div className="team-review-actions"><label>回答问题或说明返工要求<textarea rows={3} maxLength={4000} value={text} onChange={e=>setText(e.target.value)} placeholder="说明缺少什么、需要调整什么，或回答总管的问题"/></label>
      <div className="task-actions"><button type="button" disabled={disabled||!view.canAccept} onClick={()=>void decide('accept')}>验收通过</button><button type="button" disabled={disabled||!view.actionable||!text.trim()} onClick={()=>void decide('request_changes')}>要求返工</button>{report.status==='waiting_input'&&<button type="button" disabled={disabled||!view.actionable||!text.trim()} onClick={()=>void decide('answer')}>提交回答</button>}<button type="button" disabled={disabled||!view.actionable||!text.trim()} onClick={()=>void decide('needs_user')}>留待我处理</button></div>
      <p className="subtle">打开文件、验收成果和应用代码是独立操作。验收通过不会自动合入原工程。</p>
    </div>}
    {!!detail.teamReview?.reviews?.length&&<details className="team-review-history"><summary>验收与处理记录 · {detail.teamReview.reviews.length}</summary><ol>{[...detail.teamReview.reviews].sort((a,b)=>(b.createdAt??0)-(a.createdAt??0)).map(item=><li key={item.id}><strong>{reviewLabels[item.status]||item.status}</strong><small>{item.createdAt?new Date(item.createdAt).toLocaleString('zh-CN'):''}</small><p>{item.decision?.summary||(item.error?errorText({message:item.error}):'等待处理')}</p>{item.decision?.instruction&&<p>接续要求：{item.decision.instruction}</p>}</li>)}</ol></details>}
  </section>;
}

export function TaskCoordination({detail,team,tasks=[],action,disabled=false}){
  const {task}=detail,management=detail.teamReview?.management??task.management;
  const [maxReworks,setMaxReworks]=useState(management?.maxReworks??2),[assignee,setAssignee]=useState(task.assignedBotId??''),[handoff,setHandoff]=useState('');
  const [tokenBudget,setTokenBudget]=useState(management?.tokenBudget??600000),[budgetMinutes,setBudgetMinutes]=useState((management?.timeBudgetMs??7200000)/60000);
  const [schedule,setSchedule]=useState({dependsOn:task.dependsOn??[],priority:task.priority??'normal',dueAt:localDateValue(task.dueAt)});
  const send=useBoundAction(action),bound={id:task.id,runId:task.runId};
  useEffect(()=>{setAssignee(task.assignedBotId??'');setHandoff('');setMaxReworks(management?.maxReworks??2);setTokenBudget(management?.tokenBudget??600000);setBudgetMinutes((management?.timeBudgetMs??7200000)/60000);setSchedule({dependsOn:task.dependsOn??[],priority:task.priority??'normal',dueAt:localDateValue(task.dueAt)});},[task.id,task.runId,task.assignmentVersion]);
  const validBudgets=Number.isInteger(maxReworks)&&maxReworks>=0&&maxReworks<=5&&Number.isInteger(tokenBudget)&&tokenBudget>=1000&&tokenBudget<=3000000&&Number.isFinite(budgetMinutes)&&budgetMinutes>=1&&budgetMinutes<=480;
  const target=assignee||team?.chiefBotId,selected=target===team?.chiefBotId?'':assignee;
  const dependencies=(task.dependsOn??[]).map(id=>tasks.find(t=>t.id===id)??{id,title:id});
  return <section className="task-coordination" aria-label="任务安排">
    {management&&employeeTask(task)&&<details className="task-management" open><summary>总管跟进</summary>
      <label className="task-check"><input type="checkbox" checked={!!management.enabled} disabled={disabled} onChange={e=>void send('tasks/management',{...bound,enabled:e.target.checked})}/>启用成果检查与跟进</label>
      <p className="subtle">已自动返工 {management.usedReworks??0} / {management.maxReworks??2} 次 · 累计 {management.usedTokens??0} / {management.tokenBudget??600000} Token · {Math.ceil((management.usedDurationMs??0)/60000)} / {(management.timeBudgetMs??7200000)/60000} 分钟</p>
      <label>最多自动返工次数<input type="number" min={0} max={5} value={maxReworks} onChange={e=>setMaxReworks(Number(e.target.value))}/></label>
      <details><summary>累计执行预算</summary><label>累计 Token 上限<input type="number" min={1000} max={3000000} value={tokenBudget} onChange={e=>setTokenBudget(Number(e.target.value))}/></label><label>累计运行时间（分钟）<input type="number" min={1} max={480} value={budgetMinutes} onChange={e=>setBudgetMinutes(Number(e.target.value))}/></label><p className="subtle">员工执行与总管检查共用累计预算；达到上限后停止自动跟进，等待你处理。</p></details>
      <div className="task-actions"><button type="button" disabled={disabled||!validBudgets} onClick={()=>void send('tasks/management',{...bound,maxReworks,tokenBudget,timeBudgetMs:Math.round(budgetMinutes*60000)})}>保存跟进设置</button>{management.enabled&&<button type="button" disabled={disabled} onClick={()=>void send('tasks/management',{...bound,paused:!management.paused})}>{management.paused?'恢复总管跟进':'暂停总管跟进'}</button>}</div>
      {management.paused&&<p className="team-callout">总管跟进已暂停。恢复后会按当前成果和预算继续检查。</p>}
    </details>}
    <details className="task-command"><summary>优先级与依赖</summary><p>优先级：{priorityLabels[task.priority]||'普通'}{task.dueAt?` · 截止 ${new Date(task.dueAt).toLocaleString('zh-CN')}`:''}</p>
      {!!dependencies.length&&<ul>{dependencies.map(t=><li key={t.id}>{t.title}</li>)}</ul>}
      {task.blockedReason&&<p className="team-callout">暂未开始：{dependencyReason(task.blockedReason,tasks)}</p>}
      {!!task.inputsStale?.length&&<p className="team-callout">前置成果有更新，请核对后重新安排任务。</p>}
      {canEditDependencies(detail)&&<><TaskPlanningFields value={schedule} tasks={tasks} taskId={task.id} disabled={disabled} onChange={patch=>setSchedule({...schedule,...patch})}/><button type="button" disabled={disabled} onClick={()=>void send('tasks/dependencies',{...bound,...schedule,dueAt:schedule.dueAt?new Date(schedule.dueAt).getTime():null})}>保存任务安排</button></>}
    </details>
    {team&&task.kind==='agent'&&<details className="task-handoff"><summary>交接给其他员工</summary><AssigneeSelect team={team} value={selected} onChange={setAssignee}/><label>交接说明<textarea rows={3} maxLength={4000} value={handoff} onChange={e=>setHandoff(e.target.value)} placeholder="交代当前进度、需要保留的成果和下一步要求"/></label>
      <button type="button" disabled={disabled||task.kind!=='agent'||!target||target===task.assignedBotId||!handoff.trim()||task.handoff?.status==='stopping'} onClick={()=>void send('tasks/reassign',{...bound,assignmentVersion:task.assignmentVersion,assignedBotId:target,summary:handoff.trim(),...(detail.teamReview?.current?.runId===task.runId?{reportId:detail.teamReview.current.id}:{})})}>提交交接</button>
      {task.handoff&&<p className="subtle">{task.handoff.status==='stopping'?'正在停止原作业并准备交接。':'交接记录已保存。'}</p>}
    </details>}
  </section>;
}
