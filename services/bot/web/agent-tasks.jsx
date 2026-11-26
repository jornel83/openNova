import React,{useEffect,useRef,useState} from 'react';
import {AssigneeSelect} from './team.jsx';
import {EventRules} from './event-rules.jsx';
import {ResearchSources} from './research-sources.jsx';
import {TaskPlanningFields} from './team-results.jsx';
import {errorText} from './api.mjs';
import {activeTask,taskLabels,appendTaskLog,taskUnavailable,taskMediaLabels,taskMediaStatus} from './task-view.mjs';
import {agentExecutionBudget,executionBudgetLabel} from './task-budget.mjs';
import {TaskSkillSelect,TaskSkillUsage,TaskVideoProgress} from './skills.jsx';
import {skillSelection} from './skill-view.mjs';
const fresh={assignedBotId:'',workspaceMode:'general',inputs:'',title:'',goal:'',constraints:'',acceptanceCriteria:'',permission:'full',minutes:'',maxSteps:'',tokenBudget:'',autoContinue:0,managementEnabled:null,maxReworks:2,dependsOn:[],priority:'normal',dueAt:'',skillMode:'auto',skillNames:[]};
export function useTaskProjectBinding(projects){
  const [draft,setDraft]=useState(null),captured=useRef(null),state=projects?.state;
  const current=state?{projectId:state.projectId,revision:state.revision}:null;
  const capture=()=>{if(!captured.current&&current){captured.current={...current};setDraft(captured.current);}return captured.current||current;};
  const reset=()=>{captured.current=null;setDraft(null);};
  const confirm=()=>{captured.current=current?{...current}:null;setDraft(captured.current);};
  const stale=!!draft&&(!current||draft.projectId!==current.projectId||draft.revision!==current.revision);
  const project=projects?.projects?.find(project=>project.id===state?.projectId);
  const unavailable=!!projects&&(!state?.projectId||!Number.isSafeInteger(state.revision)||state.focus!=='work'||project?.status==='archived');
  return {capture,reset,confirm,stale,unavailable,blocked:stale||unavailable,name:project?.name||state?.projectId};
}
export function TaskProjectNotice({binding,retrying,disabled}){
  if(retrying)return <p className="subtle" role="status">重试只核对原项目中的同一任务，当前项目和编辑内容不会替换原提交。</p>;
  if(binding.unavailable)return <p className="subtle" role="status">当前不在可执行的工作项目中，请从项目入口选择或接续项目后再新建任务。</p>;
  if(binding.stale)return <p className="subtle" role="status">当前项目已变化，任务草稿已保留。请核对后再提交到{binding.name}。<button type="button" disabled={disabled} onClick={binding.confirm}>确认使用当前项目</button></p>;
  return binding.name?<p className="subtle">任务所属项目：{binding.name}</p>:null;
}
export function AgentTaskForm({api,action,onSelect,disabled,team,tasks=[],projects}){
  const [form,setForm]=useState(fresh),[submitting,setSubmitting]=useState(false),submission=useRef(null),inflight=useRef(false);
  const binding=useTaskProjectBinding(projects);
  const budget=agentExecutionBudget(form);
  const research=form.workspaceMode==='research';
  const field=(key,value)=>setForm({...form,[key]:value});
  async function submit(e){
    e.preventDefault();if(disabled||inflight.current||!submission.current&&(binding.blocked||!budget||!research&&form.skillMode==='explicit'&&!form.skillNames.length))return;
    if(!submission.current){const {skillMode,skillNames,currentFile,documentOutputPath,...fields}=form,expectedProject=binding.capture();submission.current={...fields,...(research?{workspaceMode:'documents',documentResearch:true,currentFile:!!currentFile,...(form.permission==='full'&&documentOutputPath?.trim()?{documentOutputPath:documentOutputPath.trim()}:{})}:{}),...(research?{skillNames:[]}:skillSelection(skillMode,skillNames)),...budget,assignedBotId:form.assignedBotId||undefined,inputFiles:form.inputs.split('\n').map(s=>s.trim()).filter(Boolean),id:crypto.randomUUID(),kind:'agent',autoContinue:!research&&form.permission==='full'?Number(form.autoContinue):0,
      managementEnabled:form.managementEnabled??true,maxReworks:Number(form.maxReworks),dueAt:form.dueAt?new Date(form.dueAt).getTime():null,...(expectedProject?{expectedProject:{...expectedProject}}:{})};}
    inflight.current=true;setSubmitting(true);
    try{
      const result=await action('background-task-start',submission.current,{rethrow:true});
      if(result){submission.current=null;binding.reset();setForm(fresh);onSelect(result.task.id);}
    }catch(error){if(error.code!=='network')submission.current=null;}finally{inflight.current=false;setSubmitting(false);}
  }
  return <details className="task-create"><summary>新建 Agent 工作任务</summary><form onSubmit={submit} onChangeCapture={binding.capture}>
    <TaskProjectNotice binding={binding} retrying={!!submission.current} disabled={disabled||submitting}/>
    <label>任务模板<select value={form.workspaceMode} onChange={e=>field('workspaceMode',e.target.value)}><option value="general">通用工作（默认）</option><option value="research">文件研究（固定版本）</option><option value="code">代码工程</option><option value="documents">文本资料整理</option></select></label>
    <p className="subtle">{research?'使用提交时的文件版本。切换项目不影响研究；重启后从已确认的进度继续。':form.workspaceMode==='code'?'复制当前代码工程到独立工作目录，可查看差异并按需应用成果。':form.workspaceMode==='documents'?'将指定的文本资料复制到独立工作目录，成果单独保存。':'创建独立工作目录，可按需带入文件，保存脚本、报告和其他成果。'}</p>
    <AssigneeSelect team={team} value={form.assignedBotId} onChange={v=>setForm({...form,assignedBotId:v,skillNames:[]})}/>
    {form.workspaceMode!=='code'&&<label>输入文件{research?'（文件名或路径，每行一个）':'（项目内相对路径，每行一个）'}<textarea rows={3} required={form.workspaceMode==='documents'||research&&!form.currentFile} value={form.inputs} onChange={e=>field('inputs',e.target.value)}/></label>}
    {research&&<><label className="task-check"><input type="checkbox" checked={!!form.currentFile} onChange={e=>field('currentFile',e.target.checked)}/>引用提交时的当前文件</label>
      {form.permission==='full'&&<label>Word 或 PDF 保存路径（选填）<input value={form.documentOutputPath??''} onChange={e=>field('documentOutputPath',e.target.value)} placeholder="例如：研究报告.docx，不能与现有文件重名"/></label>}</>}
    <label>任务名称<input required maxLength={160} value={form.title} onChange={e=>field('title',e.target.value)}/></label>
    <label>任务目标<textarea required rows={4} maxLength={8000} value={form.goal} onChange={e=>field('goal',e.target.value)}/></label>
    <label>约束<textarea rows={3} maxLength={4000} value={form.constraints} onChange={e=>field('constraints',e.target.value)}/></label>
    <label>验收标准（选填）<textarea rows={3} maxLength={4000} value={form.acceptanceCriteria} onChange={e=>field('acceptanceCriteria',e.target.value)} placeholder="例如：交付报告，列出来源，验证脚本退出码为 0"/></label>
    {api&&!research&&<TaskSkillSelect api={api} botId={form.assignedBotId||team?.chiefBotId} mode={form.skillMode} names={form.skillNames} onChange={({mode,names})=>setForm({...form,skillMode:mode,skillNames:names})} disabled={disabled}/>}
    <label className="task-check"><input type="checkbox" checked={form.managementEnabled??true} onChange={e=>field('managementEnabled',e.target.checked)}/>自动检查成果并跟进</label>
    {(form.managementEnabled??true)&&<label>最多自动返工次数<input type="number" required min={0} max={5} value={form.maxReworks} onChange={e=>field('maxReworks',Number(e.target.value))}/></label>}
    <p className="subtle">{(form.managementEnabled??true)?'无论总管还是员工执行，完成后都会独立检查成果与实际执行证据；符合要求自动验收，需要你判断时再交给你处理。':'自动检查已关闭，完成后由你查看并验收成果。'}</p>
    <TaskPlanningFields value={form} tasks={tasks} onChange={patch=>setForm({...form,...patch})}/>
    <label>执行权限<select value={form.permission} onChange={e=>field('permission',e.target.value)}><option value="full">{research?'读取并生成成果（默认）':'完整执行（Full Access，默认）'}</option><option value="read-only">只读</option></select></label>
    <p className="subtle">{form.permission==='read-only'?'读取资料并查询信息；不生成文件。':research?'可以读取固定资料并生成研究成果，默认保存到任务目录。':'可读写当前系统用户有权访问的任意目录，并使用已接入的命令、联网及浏览器工具。成果默认保存在独立目录，仍遵守任务约束。'}</p>
    {!research&&form.permission==='full'&&<><label className="task-check"><input type="checkbox" checked={!!form.autoContinue} onChange={e=>field('autoContinue',e.target.checked?2:0)}/>测试完成后自动接续</label>{!!form.autoContinue&&<label>最多自动接续次数<input required type="number" min={1} max={5} value={form.autoContinue} onChange={e=>field('autoContinue',Number(e.target.value))}/></label>}<p className="subtle">默认关闭。启用后允许 Agent 提交后台验证，结果到达时按规则接续；规则有效期 24 小时。</p></>}
    <details><summary>执行预算 · {budget&&Object.values(budget).every(value=>value===0)?'不限制':'自定义'}</summary><p className="subtle">默认不限制；需要上限时填写，留空可取消该项限制。</p><label>最多模型步骤<input type="number" min={1} max={128} placeholder="不限制" value={form.maxSteps} onChange={e=>field('maxSteps',e.target.value)}/></label><label>Token 预算<input type="number" min={1000} max={1000000} placeholder="不限制" value={form.tokenBudget} onChange={e=>field('tokenBudget',e.target.value)}/></label><label>最长运行时间（分钟）<input type="number" min={1/60} max={120} step="any" placeholder="不限制" value={form.minutes} onChange={e=>field('minutes',e.target.value)}/></label></details>
    <button className="task-primary" disabled={disabled||submitting||!submission.current&&(binding.blocked||!budget||!research&&form.skillMode==='explicit'&&!form.skillNames.length)} type="submit">{submitting?'正在提交…':submission.current?'重试原任务提交':'提交 Agent 任务'}</button>
  </form></details>;
}
const deliveryLabels={pending:'待处理',sending:'正在提交',delivered:'已接收',unknown:'接收情况待核对'};
export function AgentTaskDetail({api,detail,currentRun,action,disabled,busy,onSelect}){
  const {task}=detail,[text,setText]=useState(''),[diff,setDiff]=useState(null),[applied,setApplied]=useState(false);
  const unavailable=taskUnavailable(task);
  const readonly=(task.permission??(task.mode==='analysis'?'read-only':'full'))==='read-only';
  const codeWorkspace=!task.workspaceMode||task.workspaceMode==='code';
  const research=task.documentResearch&&task.inputSnapshot?.version===2;
  const permissionLabel=readonly?'只读':research?'读取并生成成果':task.policyVersion>=2?'完整执行（Full Access）':'可写（历史权限）';
  const hasReport=[detail.teamReview?.current,...(detail.teamReview?.history??[])].some(r=>r?.runId===currentRun?.id);
  const actions=useRef(new Map());
  useEffect(()=>{setDiff(null);setApplied(false);},[task.runId]);
  async function dispatch(name,extra={}){
    const key=JSON.stringify([name,task.runId,extra]);if(!actions.current.has(key))actions.current.set(key,crypto.randomUUID());
    return action(name,{id:task.id,runId:task.runId,actionId:actions.current.get(key),messageId:actions.current.get(key),...extra});
  }
  async function send(name){const result=await dispatch(name,{text});if(result)setText('');}
  return <div className="agent-task">
    <p className="task-intro">{permissionLabel} · {research?'文件研究（固定版本）':({general:'通用工作',code:'代码工程',documents:'文本资料整理'})[task.workspaceMode??'code']} · {executionBudgetLabel(task)}</p>
    {!readonly&&!research&&task.policyVersion>=2&&<p className="subtle">可访问当前系统用户有权访问的任意目录；仍须遵守下方目标与约束，系统权限不会自动提升。</p>}
    {!readonly&&!research&&!(task.policyVersion>=2)&&<p className="subtle">此任务保留创建时的工具权限。新建任务可使用通用执行能力。</p>}
    <details className="task-command" open><summary>目标与约束</summary><p>{task.goal}</p>{task.constraints&&<p>{task.constraints}</p>}</details>
    <TaskSkillUsage detail={detail} currentRun={currentRun}/>
    <TaskVideoProgress api={api} detail={detail} currentRun={currentRun}/>
    <TaskMediaProgress detail={detail} currentRun={currentRun}/>
    {currentRun?.researchResume&&<p className="subtle">服务重启后已接续本轮研究，沿用原文件版本和已确认的工具结果。</p>}
    {currentRun?.instruction&&<p className="task-intro">本轮接续要求：{currentRun.instruction}</p>}
    {currentRun?.id===task.runId&&currentRun.summaryRecovery&&<p className="subtle">本轮仅补汇总。已收到的自动接续事件继续保留，等待你明确“接续任务”后再按原规则处理。</p>}
    {task.question&&<p className="task-question" role="status">{unavailable?'本轮问题：':'需要补充信息：'}{task.question}</p>}
    {!unavailable&&<><div className="task-actions">{(activeTask(task)||task.status==='waiting_event')&&!['cancelling','pausing'].includes(task.status)&&<button disabled={disabled} onClick={()=>void dispatch('background-task-pause')}>暂停任务</button>}</div>
    <label>补充要求或接续说明<textarea rows={3} maxLength={4000} value={text} onChange={e=>setText(e.target.value)} placeholder="例如：保留原接口，并补充测试"/></label>
    <p className="subtle">补充要求在当前轮次结束后处理。任务已停止时，请点击“接续任务”；需要立即停下请先暂停。</p>
    <div className="task-actions"><button disabled={disabled||!text.trim()} onClick={()=>void send('background-task-message')}>保存补充要求</button>{task.canContinue&&<button disabled={disabled} onClick={()=>void send('background-task-continue')}>接续任务</button>}{task.canRecoverSummary&&currentRun?.id===task.runId&&<button disabled={disabled||busy} onClick={()=>void dispatch('background-task-continue',{summaryOnly:true,reportId:detail.teamReview?.current?.id})}>仅补汇总</button>}</div>
    {task.canRecoverSummary&&<p className="subtle">已保存的工具步骤成功，可仅补充汇总；该操作不运行命令或修改文件。继续做其他工作请使用“接续任务”。</p>}</>}
    {!!detail.messages?.length&&<details className="task-command"><summary>补充记录（{detail.messages.length}）</summary>{detail.messages.map(m=><p key={m.id}><strong>{deliveryLabels[m.delivery.status]||m.delivery.status}</strong> · {m.text}</p>)}</details>}
    {currentRun?.progress&&<p className="subtle">本轮：{currentRun.progress.steps} 个模型步骤 · {currentRun.progress.toolCalls} 次工具调用 · {currentRun.progress.estimatedTokens?'约 ':''}{currentRun.progress.totalTokens||'暂未报告'} Token{currentRun.progress.estimatedTokens?'（估算）':''}</p>}
    {(task.policyVersion>=2||task.workspaceMode!=='documents')&&<EventRules detail={detail} currentRun={currentRun} action={action} disabled={disabled} readOnly={unavailable} onSelect={onSelect}/>}
    <h4>执行步骤</h4>
    {currentRun?.jobs?.length?<ol className="agent-steps">{currentRun.jobs.map(j=><AgentStep key={j.id} api={api} taskId={task.id} runId={currentRun.id} job={j}/>)}</ol>:<p className="subtle">尚无工具执行记录。</p>}
    {!hasReport&&currentRun?.result&&<><h4>本轮报告</h4><pre className="task-report">{currentRun.result.text||errorText({message:currentRun.result.error})}</pre></>}
    {!hasReport&&<ResearchSources sources={currentRun?.result?.sources??[]}/>}
    {!readonly&&codeWorkspace&&<><h4>文件修改</h4><p className="subtle">这里只显示独立工作目录的待应用修改，外部目录修改不包含在内。{!unavailable&&'先查看差异，再应用到原工程；原文件已变化时会停止，不会自动提交 Git。'}</p>{!unavailable&&<div className="task-actions"><button disabled={disabled||!task.canContinue} onClick={async()=>{const value=await dispatch('background-task-diff');if(value){setDiff(value);setApplied(false);}}}>查看文件差异</button>{diff&&!diff.empty&&!applied&&<button disabled={disabled||busy||!task.canContinue} onClick={async()=>{const value=await dispatch('background-task-apply',{revision:diff.revision});if(value?.application?.status==='applied')setApplied(true);}}>应用到原工程</button>}</div>}
      {applied&&<p className="task-intro" role="status">已应用到原工程。</p>}{diff&&<><p className="subtle">{diff.empty?'没有待应用的修改。':`${diff.files.length} 个文件：${diff.files.join('、')}`}</p>{!diff.empty&&<pre className="task-log" aria-label="文件差异">{diff.patch}</pre>}</>}
      {!!detail.applications?.length&&<details className="task-command"><summary>应用记录</summary>{detail.applications.map(a=><p key={a.actionId}>{a.status==='applied'?'已应用':'应用结果待核对，请检查原文件'} · {new Date(a.createdAt).toLocaleString()}</p>)}</details>}
    </>}
    {detail.workspace&&<details className="task-command"><summary>独立工作目录</summary><p>{detail.workspace.path}</p></details>}
  </div>;
}

function TaskMediaProgress({detail,currentRun}){
  const records=(detail.media?.records??[]).filter(item=>item.runId===currentRun?.id||item.id===currentRun?.mediaResume?.operationId||item.id===currentRun?.result?.awaiting?.mediaOperationId);
  if(!records.length)return null;
  return <details className="task-video-progress" open><summary>图片与 GIF 进度</summary>{records.map(item=><article key={item.id}>
    <strong>{taskMediaLabels[item.operation]||'媒体处理'} · {taskMediaStatus(item)}</strong>
    {item.generation?.taskId&&<p className="subtle">{item.generation.provider==='spark'?'Spark':'Seedance'} 任务 {item.generation.taskId}</p>}
    {item.error&&<p className="error">{errorText({message:item.error})}</p>}
    {item.localFollow==='stopped'&&<p className="subtle">远端任务可能仍在运行；接续时可以跟进以前的任务。</p>}
  </article>)}</details>;
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
