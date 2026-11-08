import React,{useRef,useState} from 'react';
import {errorText} from './api.mjs';
import {taskLabels} from './task-view.mjs';
const types={check:'本任务测试／构建完成',task:'指定后台命令完成',file:'项目文件变化',github:'GitHub 评论'};
const states={enabled:'已启用',disabled:'未启用',expired:'已过期',exhausted:'额度已用尽',attention:'来源需要处理'};
const deliveries={pending:'待接续',dispatched:'已创建执行',cancelled:'已取消',ignored:'未接续'};
const reasons={automation_paused:'自动接续已暂停',task_busy:'等待当前执行结束',manual_continuation_required:'任务需要手动接续',cleanup_unconfirmed:'等待确认旧作业已退出',queue_full:'队列已满',rule_exhausted:'规则已过期或额度已用尽',rule_disabled:'规则已关闭',source_run_superseded:'原执行已被手动接续',superseded:'已合并到后一次文件变化'};
const fresh={type:'file',instruction:'',paths:'',repository:'',number:'',authors:'',taskId:'',runId:'',maxRuns:2,ttlHours:24,enabled:false};
export function EventRules({detail,currentRun,action,disabled,readOnly=false,onSelect}){
  const {task,automation}=detail,[form,setForm]=useState(fresh),submission=useRef(null);
  if(!automation)return null;
  const field=(key,value)=>setForm({...form,[key]:value});
  async function submit(e){
    e.preventDefault();
    const source=form.type==='file'?{paths:form.paths.split('\n').map(s=>s.trim()).filter(Boolean)}:form.type==='github'?{repository:form.repository,number:Number(form.number),authors:form.authors.split(',').map(s=>s.trim()).filter(Boolean)}:form.type==='task'?{taskId:form.taskId,runId:form.runId}:{};
    submission.current??={id:crypto.randomUUID(),taskId:task.id,type:form.type,instruction:form.instruction,source,enabled:form.enabled,maxRuns:Number(form.maxRuns),ttlHours:Number(form.ttlHours)};
    try{const result=await action('background-task-rule',submission.current,{rethrow:true});
      if(result){submission.current=null;setForm(fresh);}
    }catch(error){if(error.code!=='network')submission.current=null;}
  }
  return <section className="event-rules" aria-label="事件接续">
    <h4>事件接续</h4>
    {readOnly&&<p className="subtle">自动接续已暂停，以下为已保存的规则和事件记录。</p>}
    {!readOnly&&<p className="subtle">仅按你启用的规则接续同一任务。每条规则最多接续 5 次、有效期最长 7 天；文件修改仍需审阅后应用。</p>}
    {!readOnly&&!!automation.rules.length&&<div className="task-actions"><button disabled={disabled} onClick={()=>void action('background-task-automation',{id:task.id,paused:!automation.paused})}>{automation.paused?'恢复自动接续':'暂停自动接续'}</button><span className="subtle">{automation.paused?'自动接续已暂停':'自动接续可用'}；此操作不停止当前执行。</span></div>}
    {currentRun?.trigger&&<p className="task-intro">本轮由{types[automation.rules.find(r=>r.id===currentRun.trigger.ruleId)?.type]||'事件'}触发。具体资料可在下方事件记录中查看。</p>}
    {automation.rules.length?<ul className="event-rule-list">{automation.rules.map(r=><li key={r.id}>
      <strong>{types[r.type]} · {states[r.state]}</strong><p>{r.instruction}</p>
      <p className="subtle">已接续 {r.usedRuns} / {r.maxRuns} 次 · 有效至 {new Date(r.expiresAt).toLocaleString()}</p>
      {r.type==='file'&&<p className="subtle">{r.source.paths.join('、')}</p>}
      {r.type==='github'&&<p className="subtle">{r.source.repository} #{r.source.number} · {r.source.authors.join('、')} · /opennova</p>}
      {r.type==='task'&&<p className="subtle">任务 {r.source.taskId} · 执行 {r.source.runId}</p>}
      {r.error&&<p className="error" role="status">{errorText({message:r.error})}</p>}
      {!readOnly&&<div className="task-actions"><button disabled={disabled||!r.enabled&&(['expired','exhausted'].includes(r.state)||r.usedRuns>=r.maxRuns||r.expiresAt<=Date.now())} onClick={()=>void action('background-task-rule-toggle',{id:r.id,revision:r.revision,enabled:!r.enabled})}>{r.enabled?'关闭规则':'启用规则'}</button></div>}
    </li>)}</ul>:<p className="subtle">尚未配置自动接续规则。</p>}
    {!!detail.checks?.length&&<details className="task-command"><summary>后台验证（{detail.checks.length}）</summary>{detail.checks.map(c=><div className="task-actions" key={c.id}><button disabled={disabled} onClick={()=>onSelect(c.id)}>{c.title} · {taskLabels[c.status]}{c.exitCode!=null&&` · 退出码 ${c.exitCode}`}</button></div>)}</details>}
    <details className="task-command"><summary>事件记录（最近 {automation.deliveries.length} 条）</summary>
      {automation.deliveries.map(d=><details className="event-record" key={d.id}><summary>{deliveries[d.status]} · {d.event?.type} · {new Date(d.createdAt).toLocaleString()}</summary><p>{reasons[d.reason]||d.reason}</p>{d.runId&&<p>接续到第 {detail.runs.find(r=>r.id===d.runId)?.number} 次执行</p>}<pre className="task-log">{JSON.stringify(d.event?.data,null,2)}</pre></details>)}
      {!automation.deliveries.length&&<p>暂无事件。</p>}
    </details>
    {!readOnly&&<details className="task-create"><summary>添加接续规则</summary><form onSubmit={submit}>
      <label>事件来源<select value={form.type} onChange={e=>field('type',e.target.value)}>{Object.entries(types).filter(([key])=>key!=='check'||task.mode==='edit').map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      {form.type==='check'&&<p className="subtle">供 Agent 在后续执行中提交异步测试或构建。当前执行不会中途获得新工具；添加后可手动接续任务。</p>}
      {form.type==='file'&&<><label>项目内文件（每行一个，最多 10 个）<textarea required rows={3} value={form.paths} onChange={e=>field('paths',e.target.value)} placeholder="src/index.ts"/></label><p className="subtle">监听原工程中的明确文件，稳定 2 秒后触发。仅传递内容摘要，不覆盖任务工作目录；排除 .env、*.local.json 和构建目录。</p></>}
      {form.type==='task'&&<><label>来源任务 ID<input required value={form.taskId} onChange={e=>field('taskId',e.target.value)}/></label><label>来源执行 ID<input required value={form.runId} onChange={e=>field('runId',e.target.value)}/></label><p className="subtle">只处理这一次命令执行；已结束的执行会立即导入结果。</p></>}
      {form.type==='github'&&<><label>GitHub 仓库<input required placeholder="owner/repo" value={form.repository} onChange={e=>field('repository',e.target.value)}/></label><label>Issue 或 PR 编号<input required type="number" min={1} value={form.number} onChange={e=>field('number',e.target.value)}/></label><label>允许的评论作者（逗号分隔）<input required value={form.authors} onChange={e=>field('authors',e.target.value)}/></label><p className="subtle">每分钟读取一次启用后的新讨论评论，必须以 /opennova 开头。不包含代码行审阅评论。私有仓库需在仓库外配置只读授权。</p></>}
      <label>触发后的处理要求<textarea required rows={3} maxLength={4000} value={form.instruction} onChange={e=>field('instruction',e.target.value)} placeholder="根据变化核对原任务，报告受影响的测试"/></label>
      <label>最多自动接续次数<input type="number" required min={1} max={5} value={form.maxRuns} onChange={e=>field('maxRuns',e.target.value)}/></label>
      <label>有效期（小时）<input type="number" required min={1} max={168} value={form.ttlHours} onChange={e=>field('ttlHours',e.target.value)}/></label>
      <label className="task-check"><input type="checkbox" checked={form.enabled} onChange={e=>field('enabled',e.target.checked)}/>保存后启用此规则</label>
      {submission.current&&<p className="subtle">重试会核对原规则提交。</p>}
      <button className="task-primary" disabled={disabled} type="submit">{submission.current?'重试规则提交':'保存接续规则'}</button>
    </form></details>}
  </section>;
}
