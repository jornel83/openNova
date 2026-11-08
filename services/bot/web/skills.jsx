import React,{useEffect,useRef,useState} from 'react';
import {errorText} from './api.mjs';
import {taskUnavailable} from './task-view.mjs';
import {skillConflict,skillCatalogProblems,skillSourceLabel,skillVersionLabel,runSkills,reportCandidates,candidateSourceCurrent,videoStatusLabel} from './skill-view.mjs';

export function SkillCatalogProblems({catalog}){
  const problems=skillCatalogProblems(catalog);
  return problems.length?<div role="status">{problems.map(problem=><p key={problem.name+':'+problem.status} className={problem.status==='pending'?'subtle':'error'}>{problem.name}：{problem.text}</p>)}</div>:null;
}

function useCatalog(api,open,botId){
  const [value,setValue]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0);
  useEffect(()=>{
    if(!open||!api)return;
    let disposed=false,timer;setLoading(true);setError('');
    const load=async()=>{try{const result=await api.call('skills',{includeDisabled:true,...(botId?{botId}:{})});if(!disposed){setValue(result);setError('');}}catch(e){if(!disposed)setError(errorText(e));}finally{if(!disposed){setLoading(false);timer=setTimeout(load,5000);}}};
    void load();return()=>{disposed=true;clearTimeout(timer);};
  },[api,open,botId,revision]);
  return {value,error,loading,refresh:()=>setRevision(n=>n+1),setValue};
}

function useSkillAction(api,onRefresh,endpoint='skill-action'){
  const [pending,setPending]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const saved=useRef(null),sending=useRef(false);
  async function send(body,message){
    if(sending.current)return null;sending.current=true;setPending(true);setError('');setNotice('');
    const fingerprint=JSON.stringify(body);
    if(saved.current&&saved.current.fingerprint!==fingerprint){setError('上次操作的结果尚未确认，请先重试原操作。');sending.current=false;setPending(false);return null;}
    saved.current??={fingerprint,body:{...body,actionId:crypto.randomUUID()},message};
    try{const result=await api.call(endpoint,saved.current.body);saved.current=null;setNotice(message||'技能设置已保存。');onRefresh?.(result);return result;}
    catch(e){setError(errorText(e));if(e.code!=='network'){saved.current=null;if(skillConflict(e))onRefresh?.();}return null;}
    finally{sending.current=false;setPending(false);}
  }
  return {send,pending,error,notice,retry:!!saved.current,retryLast:()=>saved.current&&send(JSON.parse(saved.current.fingerprint),saved.current.message)};
}

export function TaskSkillSelect({api,botId,mode='auto',names=[],onChange,disabled=false}){
  const [open,setOpen]=useState(false),catalog=useCatalog(api,open,botId);
  const skills=(catalog.value?.skills??[]).filter(skill=>skill.enabled&&skill.available!==false),missing=names.filter(name=>!skills.some(skill=>skill.name===name));
  return <details className="task-skills-select" onToggle={event=>setOpen(event.currentTarget.open)}><summary>使用技能 · {mode==='auto'?'自动匹配':mode==='none'?'本次不用':`已指定 ${names.length} 项`}</summary>
    <label>技能选择<select value={mode} disabled={disabled} onChange={event=>onChange({mode:event.target.value,names})}><option value="auto">按任务自动匹配</option><option value="explicit">指定技能</option><option value="none">本次不使用技能</option></select></label>
    {mode==='explicit'&&<fieldset disabled={disabled||catalog.loading}><legend>可用技能</legend>{[...skills,...missing.map(name=>({name,enabled:false,description:'当前不可用，请重新选择'}))].map(skill=><label className="task-check" key={skill.name}><input type="checkbox" checked={names.includes(skill.name)} onChange={event=>onChange({mode,names:event.target.checked?[...names,skill.name]:names.filter(name=>name!==skill.name)})}/><span>{skill.name}<small>{skill.description}</small></span></label>)}{!skills.length&&!catalog.loading&&<p className="subtle">暂无可用技能。</p>}</fieldset>}
    {catalog.loading&&<p className="subtle">正在读取技能…</p>}{catalog.error&&<p className="error" role="alert">{catalog.error}</p>}<SkillCatalogProblems catalog={catalog.value}/>
    <p className="subtle">技能提供工作方法，执行仍遵守当前任务的权限和约束。</p>
  </details>;
}

export function EmployeeSkills({api,member,disabled=false}){
  const [open,setOpen]=useState(false),catalog=useCatalog(api,open,member.id),[selected,setSelected]=useState([]),[dirty,setDirty]=useState(false);
  const binding=catalog.value?.bindings?.find(value=>value.botId===member.id);
  useEffect(()=>{if(catalog.value&&!dirty)setSelected(binding?.names??catalog.value.skills.filter(skill=>skill.assignedBotIds?.includes(member.id)).map(skill=>skill.name));},[catalog.value,member.id,dirty]);
  const operation=useSkillAction(api,result=>{setDirty(false);if(result?.skills)catalog.setValue(result);else catalog.refresh();});
  return <details className="employee-skills" onToggle={event=>setOpen(event.currentTarget.open)}><summary>技能配置</summary>
    {catalog.loading&&<p className="subtle">正在读取技能…</p>}
    {catalog.value&&<><fieldset disabled={disabled||operation.pending||operation.retry}><legend>分配给{member.name}的技能</legend>{catalog.value.skills.map(skill=><label className="task-check" key={skill.name}><input type="checkbox" checked={selected.includes(skill.name)} disabled={!skill.enabled&&!selected.includes(skill.name)} onChange={event=>{setDirty(true);setSelected(event.target.checked?[...selected,skill.name]:selected.filter(name=>name!==skill.name));}}/><span>{skill.name}{!skill.enabled?' · 已停用':''}<small>{skill.description}</small></span></label>)}{!catalog.value.skills.length&&<p className="subtle">暂无技能，可先在技能库中保存。</p>}</fieldset>
      <div className="task-actions"><button type="button" disabled={disabled||operation.pending||!dirty&&!operation.retry} onClick={()=>void (operation.retry?operation.retryLast():operation.send({action:'assign',botId:member.id,names:selected,...(binding?{revision:binding.revision}:{})},'员工技能已保存，后续任务使用新配置。'))}>{operation.pending?'保存中…':operation.retry?'重试保存':'保存技能配置'}</button></div>
      <p className="subtle">不勾选表示不分配技能。更改用于后续任务，正在执行的任务保留本轮技能版本。</p></>}
    {(catalog.error||operation.error)&&<p className="error" role="alert">{operation.error||catalog.error}</p>}{operation.notice&&<p className="subtle" role="status">{operation.notice}</p>}<SkillCatalogProblems catalog={catalog.value}/>
  </details>;
}

export function TaskSkillUsage({detail,currentRun}){
  const skills=runSkills(detail,currentRun);
  if(!skills.length)return null;
  return <details className="task-skill-usage"><summary>本轮使用技能 · {skills.length} 项</summary><ul>{skills.map(skill=><li key={skill.name}><strong>{skill.name}</strong><span>{skillVersionLabel(skill.version)}</span>{skill.description&&<p>{skill.description}</p>}</li>)}</ul><p className="subtle">按本轮保存的版本执行。技能库更新不会替换这条使用记录。</p></details>;
}

function SkillEditor({initial,disabled,onSave,onClose,pending,retry,knownSkills=[]}){
  const [form,setForm]=useState(()=>({name:initial.name??'',description:initial.description??'',content:initial.content??'',enabled:initial.enabled??true}));
  const field=(name,value)=>setForm(current=>({...current,[name]:value}));
  return <form className="skill-edit" onSubmit={event=>{event.preventDefault();if(!disabled&&!pending)void onSave(form);}}>
    <fieldset disabled={disabled||pending||retry}><legend>{initial.candidateId?'保存经验技能':initial.revision?'更新技能':'新建技能'}</legend>
      <label>技能名称<input required maxLength={32} pattern="[a-z][a-z0-9]*(?:-[a-z0-9]+)*" value={form.name} disabled={!!initial.revision&&!initial.candidateId} onChange={event=>field('name',event.target.value)}/></label>
      {initial.candidateId&&knownSkills.some(skill=>skill.name===form.name)&&<p className="subtle">同名技能已存在，保存会生成新版本，旧版本仍可回退。</p>}
      <label>适用场景<textarea required rows={2} maxLength={2000} value={form.description} onChange={event=>field('description',event.target.value)}/></label>
      <label>工作方法<textarea required rows={10} maxLength={32000} value={form.content} onChange={event=>field('content',event.target.value)}/></label>
      <label className="task-check"><input type="checkbox" checked={form.enabled} onChange={event=>field('enabled',event.target.checked)}/>保存后启用</label>
    </fieldset><div className="task-actions"><button type="submit" disabled={disabled||pending}>{pending?'保存中…':retry?'重试保存':'保存技能'}</button><button type="button" disabled={pending||retry} onClick={onClose}>关闭编辑</button></div>
  </form>;
}

export function SkillCandidate({api,candidate,disabled=false,onRefresh}){
  const [editing,setEditing]=useState(false),[checking,setChecking]=useState(false),[sourceError,setSourceError]=useState(''),catalog=useCatalog(api,editing),operation=useSkillAction(api,result=>{setEditing(false);onRefresh?.(result);});
  const extraction=useSkillAction(api,onRefresh,'skill-candidate');
  const binding={taskId:candidate.source?.taskId,runId:candidate.source?.runId,reportId:candidate.source?.reportId,reviewId:candidate.source?.reviewId};
  async function edit(){
    setChecking(true);setSourceError('');
    try{const detail=await api.call('background-task',{id:candidate.source?.taskId});if(!candidateSourceCurrent(detail,candidate))throw Error('skill_source_changed');setEditing(true);}
    catch(error){setSourceError(errorText(error));}finally{setChecking(false);}
  }
  return <article className="skill-candidate"><strong>{candidate.name||'经验技能候选'}</strong><p>{candidate.description}</p>
    {candidate.status==='promoted'?<p className="subtle">已保存为技能</p>:candidate.status==='ready'?<><p className="subtle">来自已验收任务，可检查适用条件和步骤后保存。</p>{editing?<SkillEditor initial={{...candidate,candidateId:candidate.id}} knownSkills={catalog.value?.skills??[]} disabled={disabled||catalog.loading||!catalog.value} pending={operation.pending} retry={operation.retry} onClose={()=>setEditing(false)} onSave={form=>{if(operation.retry)return operation.retryLast();const previous=catalog.value?.skills.find(skill=>skill.name===form.name);return operation.send({action:'promote',candidateId:candidate.id,...form,...(previous?{revision:previous.revision}:{})},'已保存为技能。');}}/>:<div className="task-actions"><button type="button" disabled={disabled||checking} onClick={()=>void edit()}>{checking?'核对来源…':'保存为技能'}</button></div>}</>:candidate.status==='failed'?<><p className="error">整理未完成：{errorText({message:candidate.error||'skill_extraction_failed'})}</p><div className="task-actions"><button type="button" disabled={disabled||extraction.pending} onClick={()=>void (extraction.retry?extraction.retryLast():extraction.send(binding,'已提交重新整理，不会重跑原任务。'))}>{extraction.pending?'正在提交…':extraction.retry?'重试提交':'重新整理'}</button></div></>:<p className="subtle">正在整理工作方法，完成后可检查并保存。</p>}
    {sourceError&&<p className="error" role="alert">{sourceError}</p>}
    {catalog.error&&<p className="error" role="alert">{catalog.error}</p>}<SkillCatalogProblems catalog={catalog.value}/>{extraction.error&&<p className="error" role="alert">{extraction.error}</p>}{extraction.notice&&<p className="subtle" role="status">{extraction.notice}</p>}
    {operation.error&&<p className="error" role="alert">{operation.error}</p>}{operation.notice&&<p className="subtle" role="status">{operation.notice}</p>}
  </article>;
}

export function ResultSkills({api,detail,report,review,latest,disabled=false}){
  const candidates=reportCandidates(detail,report,review),[extra,setExtra]=useState(null);
  useEffect(()=>{setExtra(null);},[report.id,review?.id,detail.skillCandidates]);
  const refresh=result=>{if(result?.candidate)setExtra([...candidates.filter(candidate=>candidate.id!==result.candidate.id),result.candidate]);else if(result?.candidates)setExtra(reportCandidates({...detail,skillCandidates:result.candidates},report,review));};
  const extraction=useSkillAction(api,refresh,'skill-candidate');
  if(!latest||review?.status!=='accepted'||taskUnavailable(detail.task))return null;
  const entries=reportCandidates({...detail,skillCandidates:extra??candidates},report,review);
  return <details className="result-skills"><summary>复用这次工作方法{entries.length?` · ${entries.length} 项`:''}</summary>{entries.length?entries.map(candidate=><SkillCandidate key={candidate.id} api={api} candidate={candidate} disabled={disabled} onRefresh={refresh}/>):<><p className="subtle">整理适用条件、输入、步骤和检查方法，形成可复用的技能候选。</p><div className="task-actions"><button type="button" disabled={disabled||extraction.pending||!review.id} onClick={()=>void extraction.send({taskId:detail.task.id,runId:report.runId,reportId:report.id,reviewId:review.id},'已提交整理工作方法，不会重跑原任务。')}>{extraction.pending?'正在提交…':extraction.retry?'重试提交':'整理为技能'}</button></div></>}{extraction.error&&<p className="error" role="alert">{extraction.error}</p>}{extraction.notice&&<p className="subtle" role="status">{extraction.notice}</p>}</details>;
}

export function SkillLibrary({api,disabled=false}){
  const [open,setOpen]=useState(false),catalog=useCatalog(api,open),[editing,setEditing]=useState(null),[history,setHistory]=useState(null),[loading,setLoading]=useState(''),[localError,setLocalError]=useState('');
  const operation=useSkillAction(api,result=>{setEditing(null);setHistory(null);if(result?.skills)catalog.setValue(result);else catalog.refresh();});
  async function load(skill,edit=false){
    setLoading(skill.name);setLocalError('');
    try{const value=await api.call('skill-history',{name:skill.name}),versions=Array.isArray(value)?value:value.versions??[];
      if(edit){const current=versions.find(version=>version.version===skill.version);if(!current?.content)throw Error('skill_content_unavailable');setEditing({...current,...skill,content:current.content,revision:skill.revision});setHistory(null);}
      else{setHistory({skill,versions});setEditing(null);}
    }catch(error){setLocalError(errorText(error));}finally{setLoading('');}
  }
  return <details className="skill-library" onToggle={event=>setOpen(event.currentTarget.open)}><summary>技能库{catalog.value?` · ${catalog.value.skills.length} 项`:''}</summary>
    <p className="subtle">内置技能与团队经验统一管理。也可以直接说“保存为技能”或“停用这个技能”。</p>
    <div className="task-actions"><button type="button" disabled={disabled||catalog.loading||operation.pending} onClick={catalog.refresh}>刷新技能</button><button type="button" disabled={disabled||operation.pending||operation.retry} onClick={()=>{setHistory(null);setEditing({});}}>新建技能</button></div>
    {catalog.loading&&<p className="subtle">正在读取技能…</p>}{(catalog.error||localError||operation.error)&&<p className="error" role="alert">{operation.error||localError||catalog.error}</p>}{operation.notice&&<p className="subtle" role="status">{operation.notice}</p>}<SkillCatalogProblems catalog={catalog.value}/>
    {operation.retry&&!editing&&<div className="task-actions"><button type="button" disabled={disabled||operation.pending} onClick={()=>void operation.retryLast()}>重试上次操作</button></div>}
    {editing&&<SkillEditor key={editing.name||'new'} initial={editing} disabled={disabled} pending={operation.pending} retry={operation.retry} onClose={()=>setEditing(null)} onSave={form=>operation.retry?operation.retryLast():operation.send({action:'save',...form,...(editing.revision?{revision:editing.revision}:{})},'技能版本已保存。')}/>}
    {(catalog.value?.skills??[]).map(skill=><article className="skill-library-item" key={skill.name}><div className="task-heading"><strong>{skill.name}</strong><span>{skill.enabled?'已启用':'已停用'}</span></div><p>{skill.description}</p><small>{skillSourceLabel(skill.source)} · {skillVersionLabel(skill.version)}</small><div className="task-actions">
      <button type="button" disabled={disabled||operation.pending||!!loading||operation.retry} onClick={()=>void operation.send({action:skill.enabled?'disable':'enable',name:skill.name,revision:skill.revision},skill.enabled?'技能已停用，后续任务不再自动选用。':'技能已启用。')}>{skill.enabled?'停用':'启用'}</button>
      <button type="button" disabled={disabled||operation.pending||!!loading||operation.retry} onClick={()=>void load(skill,true)}>更新内容</button>
      <button type="button" disabled={disabled||operation.pending||!!loading||operation.retry} onClick={()=>void load(skill)}>版本记录</button></div></article>)}
    {history&&<section className="skill-history" aria-label="技能版本记录"><h4>{history.skill.name} · 版本记录</h4>{history.versions.map(version=><article key={version.version}><span>{skillVersionLabel(version.version)}{version.version===history.skill.version?' · 当前版本':''}</span>{version.createdAt&&<small>{new Date(version.createdAt).toLocaleString('zh-CN')}</small>}{version.version!==history.skill.version&&<div className="task-actions"><button type="button" disabled={disabled||operation.pending||operation.retry} onClick={()=>void operation.send({action:'rollback',name:history.skill.name,revision:history.skill.revision,version:version.version},'已切换技能版本，正在执行的任务保留原版本。')}>使用此版本</button></div>}</article>)}</section>}
    {!!catalog.value?.candidates?.length&&<details className="skill-candidates"><summary>经验候选 · {catalog.value.candidates.filter(candidate=>candidate.status==='ready').length} 项待保存</summary>{catalog.value.candidates.map(candidate=><SkillCandidate key={candidate.id} api={api} candidate={candidate} disabled={disabled||operation.pending} onRefresh={catalog.refresh}/>)}</details>}
    {catalog.value?.policy&&<SkillPolicy api={api} policy={catalog.value.policy} disabled={disabled||operation.pending} onRefresh={catalog.refresh}/>}
    {catalog.value&&!catalog.value.skills.length&&<p className="subtle">暂无已保存技能。</p>}
  </details>;
}

function SkillPolicy({api,policy,disabled,onRefresh}){
  const [draft,setDraft]=useState(policy),operation=useSkillAction(api,onRefresh);
  useEffect(()=>setDraft(policy),[policy.revision]);
  return <details className="skill-policy"><summary>经验沉淀设置</summary><form onSubmit={event=>{event.preventDefault();void (operation.retry?operation.retryLast():operation.send({action:'policy',revision:policy.revision,autoCandidate:!!draft.autoCandidate,autoEnable:!!draft.autoEnable},'经验沉淀设置已保存。'));}}>
    <label className="task-check"><input type="checkbox" checked={!!draft.autoCandidate} disabled={disabled||operation.pending||operation.retry} onChange={event=>setDraft({...draft,autoCandidate:event.target.checked})}/>验收通过后自动整理经验候选</label>
    <label className="task-check"><input type="checkbox" checked={!!draft.autoEnable} disabled={disabled||operation.pending||operation.retry} onChange={event=>setDraft({...draft,autoEnable:event.target.checked})}/>允许自动启用符合条件的新技能</label>
    <p className="subtle">默认只整理候选。启用后的技能仍需在实际任务中检查结果。</p>
    <div className="task-actions"><button type="submit" disabled={disabled||operation.pending}>{operation.pending?'保存中…':operation.retry?'重试保存设置':'保存沉淀设置'}</button></div>
    {operation.error&&<p className="error" role="alert">{operation.error}</p>}{operation.notice&&<p className="subtle" role="status">{operation.notice}</p>}
  </form></details>;
}

export function TaskVideoProgress({detail,currentRun}){
  const values=Array.isArray(detail.video)?detail.video:detail.video?.records??[];
  const items=values.filter(item=>currentRun?.id===detail.task.runId||item.runId===currentRun?.id);
  if(!items.length)return null;
  return <details className="task-video-progress" open><summary>视频制作进度</summary>{items.map((item,index)=><article key={item.id||index}><strong>{videoStatusLabel(item.remoteStatus)}</strong>{item.remoteTaskId&&<p>远端任务：{item.remoteTaskId}</p>}{item.localStatus==='stopped'&&<p className="subtle">已停止本地跟进</p>}{item.waitingTimedOut&&<p className="subtle">本次等待已到期，远端任务状态仍以上方记录为准。</p>}{item.artifact?.path&&<p>{item.artifact.path}</p>}{(item.lastError||item.error)&&<p className="error">{errorText({message:item.lastError||item.error})}</p>}</article>)}<p className="subtle">停止本地跟进不代表远端生成已经取消。</p></details>;
}
