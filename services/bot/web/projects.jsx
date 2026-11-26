import React,{useEffect,useId,useRef,useState} from 'react';
import {errorText} from './api.mjs';
import {ProjectExperiments} from './project-experiments.jsx';

const recordTypes={decision:'已确认决定',option:'备选方案',question:'未决问题',next_step:'下一步'};
const referenceTypes={file:'文件',directory:'目录',url:'网页',selection:'选区',artifact:'任务成果'};
const taskStatuses={queued:'等待中',running:'进行中',completed:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断',needs_user:'待补充',paused:'已暂停',timed_out:'已超时'};
const projectErrors={project_changed:'项目已更新，请核对最新内容后重新编辑。',project_state_changed:'当前项目已变化，请核对后重试。',project_action_conflict:'这次操作与之前提交的内容不一致，请刷新后核对。',project_revision_conflict:'项目已更新，请核对最新内容后重新编辑。',stale_project:'当前项目已变化，请核对后重试。',unknown_project:'没有找到这个项目，请刷新项目列表。',project_archived:'这个项目已归档，恢复后可以继续编辑。'};
const messageFor=error=>projectErrors[error?.code||error?.message]||errorText(error);
export function expectedProject(view){return view?.state?{projectId:view.state.projectId??null,revision:view.state.revision}:undefined;}
export function activeProjectContext(view,context){return view?.state?.focus==='daily'?null:context;}

function StaleDraft({stale,onReload}){return stale?<p className="project-stale" role="status">内容已更新，当前草稿保留。<button type="button" onClick={onReload}>载入最新内容</button></p>:null;}
function ProjectEditor({project,disabled,onSave,onClose}){
  const values=()=>({name:project?.name||'',goal:project?.goal||'',directory:project?.directory||'',revision:project?.revision??0});
  const [form,setForm]=useState(values),stale=!!project&&form.revision!==project.revision;
  const field=(name,value)=>setForm(current=>({...current,[name]:value}));
  return <form className="project-form" onSubmit={async event=>{event.preventDefault();if(disabled||stale||!form.name.trim())return;if(await onSave(form))onClose();}}>
    <label>项目名称<input value={form.name} maxLength={120} required onChange={event=>field('name',event.target.value)}/></label>
    <label>项目目标<textarea value={form.goal} maxLength={2000} rows={2} onChange={event=>field('goal',event.target.value)}/></label>
    <label>项目目录（可留空）<input value={form.directory} placeholder="例如 /Users/me/Documents/project" onChange={event=>field('directory',event.target.value)}/></label>
    <StaleDraft stale={stale} onReload={()=>setForm(values())}/>
    <div className="project-actions"><button type="submit" disabled={disabled||stale||!form.name.trim()}>{project?'保存项目':'创建项目'}</button><button type="button" onClick={onClose} disabled={disabled}>取消</button></div>
  </form>;
}

function ReferenceEditor({reference,project,currentContext,disabled,onSave,onClose}){
  const values=()=>({kind:reference?.kind||'file',title:reference?.title||'',location:reference?.url||reference?.path||'',purpose:reference?.purpose||'',revision:project.revision});
  const [form,setForm]=useState(values),stale=form.revision!==project.revision;
  const selection=form.kind==='selection',selected=currentContext?.kind==='browser'&&currentContext.selection;
  const valid=selection?!!reference||!!selected?.text:!!form.location.trim();
  const field=(name,value)=>setForm(current=>({...current,[name]:value}));
  return <form className="project-form" onSubmit={async event=>{event.preventDefault();if(disabled||stale||!valid)return;const {location,...value}=form;const source=selection?(reference?{}:{expectedSelection:{documentId:selected.documentId,revision:selected.revision,text:selected.text}}):{[form.kind==='url'?'url':'path']:location};if(await onSave({...value,...source}))onClose();}}>
    <label>资料类型<select value={form.kind} disabled={!!reference} onChange={event=>field('kind',event.target.value)}>{Object.entries(referenceTypes).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
    <label>资料名称<input value={form.title} maxLength={200} onChange={event=>field('title',event.target.value)}/></label>
    {selection?<p className="subtle">{reference?'保留原选区来源':selected?.text||'请先在工作网页中选择要关联的文字。'}</p>:<label>{form.kind==='url'?'网页地址':'资料路径或来源'}<input required value={form.location} onChange={event=>field('location',event.target.value)}/></label>}
    <label>资料用途<input value={form.purpose} maxLength={1000} onChange={event=>field('purpose',event.target.value)}/></label>
    <StaleDraft stale={stale} onReload={()=>setForm(values())}/>
    <div className="project-actions"><button type="submit" disabled={disabled||stale||!valid}>保存资料</button><button type="button" disabled={disabled} onClick={onClose}>取消</button></div>
  </form>;
}

function RecordEditor({record,project,disabled,onSave,onClose}){
  const values=()=>({type:record?.type||'decision',text:record?.text||'',revision:project.revision});
  const [form,setForm]=useState(values),stale=form.revision!==project.revision;
  return <form className="project-form" onSubmit={async event=>{event.preventDefault();if(disabled||stale||!form.text.trim())return;if(await onSave(form))onClose();}}>
    <label>记录类型<select value={form.type} onChange={event=>setForm(current=>({...current,type:event.target.value}))}>{Object.entries(recordTypes).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
    <label>记录内容<textarea value={form.text} required maxLength={4000} rows={3} onChange={event=>setForm(current=>({...current,text:event.target.value}))}/></label>
    <StaleDraft stale={stale} onReload={()=>setForm(values())}/>
    <div className="project-actions"><button type="submit" disabled={disabled||stale||!form.text.trim()}>保存记录</button><button type="button" disabled={disabled} onClick={onClose}>取消</button></div>
  </form>;
}

function referenceAccess(reference){
  if(['missing','invalid','changed'].includes(reference.availability))return {missing:'原资料不存在',invalid:'来源已失效',changed:'资料已更新，使用前需重新读取'}[reference.availability];
  if(reference.readStatus==='stale')return '读取记录已失效，使用前需重新读取';
  if(reference.kind==='directory')return '已关联目录 · 使用时按需读取文件';
  if(reference.readCapability==='metadata_only')return '仅关联文件信息 · 正文未接入';
  if(reference.readCapability==='native_file')return reference.readStatus==='read'?'已有读取记录 · 使用时核对版本':'正文可按需读取 · 读取结果见对话记录';
  if(reference.readCapability==='text_file')return reference.readStatus==='read'?'已读取文本 · 使用时核对版本':'文本可按需读取 · 尚未读取';
  return reference.readStatus==='read'?'已读取来源 · 使用时核对版本':'已关联来源 · 尚未读取';
}

function ResumeSummary({summary,onOpenTask}){
  if(typeof summary==='string')return <p>{summary}</p>;
  const groups=[['decisions','已确认决定'],['options','备选方案'],['questions','未决问题'],['nextSteps','下一步']];
  const hasContent=groups.some(([key])=>summary?.[key]?.length)||summary?.tasks?.length||summary?.reports?.length;
  return <>{!hasContent&&<p className="subtle">还没有接续摘要。</p>}{groups.map(([key,label])=>!!summary?.[key]?.length&&<div key={key}><h5>{label}</h5><ul>{summary[key].map((record,index)=><li key={record.id||index}>{typeof record==='string'?record:record.text}</li>)}</ul></div>)}
    {!!summary?.tasks?.length&&<div><h5>任务进展</h5><ul>{summary.tasks.map(task=><li key={task.id}><button type="button" className="project-summary-task" onClick={()=>onOpenTask?.(task.id)}>{task.title||task.id} · {taskStatuses[task.status]||'查看任务状态'}</button></li>)}</ul></div>}
    {!!summary?.reports?.length&&<div><h5>最近成果</h5><ul>{summary.reports.map((report,index)=><li key={report.id||index}>{report.summary||report.title||'查看任务成果'}{report.taskId&&<button type="button" onClick={()=>onOpenTask?.(report.taskId)}>查看成果</button>}</li>)}</ul></div>}
    {summary?.truncated&&<p className="subtle">摘要展示最近内容，更多记录见下方项目资料与任务。</p>}</>;
}

function ProjectDetail({detail,currentContext,disabled,mutate,onOpenTask,onSelectProject}){
  const {project}=detail,[editor,setEditor]=useState(null);
  const records=detail.records||[],references=detail.references||[],tasks=Array.isArray(detail.tasks)?detail.tasks:detail.tasks?.tasks||[];
  const editable=!disabled&&project.status!=='archived';
  const submit=(name,body)=>mutate(name,{projectId:project.id,...body});
  const selectedReference=editor?.kind==='reference'&&references.find(item=>item.id===editor.id);
  const selectedRecord=editor?.kind==='record'&&records.find(item=>item.id===editor.id);
  return <div className="project-detail">
    <div className="project-detail-heading"><h3>{project.name}</h3>{project.status==='archived'&&<span>已归档</span>}</div>
    {project.goal&&<p className="project-goal">{project.goal}</p>}
    <p className="project-location">{project.directory||'未关联外部目录'}</p>
    {project.availability&&project.availability!=='available'&&<p className="project-error" role="status">项目目录暂时不可用。可编辑目录后继续，原项目记录仍保留。</p>}
    <div className="project-actions"><button type="button" disabled={!editable} onClick={()=>onSelectProject(project.id)}>接续项目</button><button type="button" disabled={!editable} onClick={()=>setEditor({kind:'project'})}>编辑项目信息</button><button type="button" disabled={disabled} onClick={()=>void submit('project-action',{action:project.status==='archived'?'restore':'archive',id:project.id,revision:project.revision})}>{project.status==='archived'?'恢复项目':'归档项目'}</button></div>
    {editor?.kind==='project'&&<ProjectEditor project={project} disabled={!editable} onSave={value=>submit('project-action',{action:'update',id:project.id,...value})} onClose={()=>setEditor(null)}/>}
    <section className="project-summary"><h4>接续摘要</h4><ResumeSummary summary={detail.summary} onOpenTask={onOpenTask}/></section>
    <section><div className="project-section-heading"><h4>项目资料</h4><button type="button" disabled={!editable} onClick={()=>setEditor({kind:'reference'})}>添加资料</button></div>
      {!references.length&&<p className="subtle">可以关联文件、目录或网页，稍后也能补充。</p>}
      <ul className="project-items">{references.filter(reference=>reference.status!=='removed').map(reference=><li key={reference.id}><div><strong>{reference.title||reference.path||reference.url||referenceTypes[reference.kind]}</strong><small>{referenceTypes[reference.kind]} · {referenceAccess(reference)}</small>{(reference.path||reference.url)&&<small>{reference.path||reference.url}</small>}{reference.purpose&&<p>{reference.purpose}</p>}</div><div className="project-actions"><button type="button" disabled={!editable} onClick={()=>setEditor({kind:'reference',id:reference.id})}>编辑资料</button><button type="button" disabled={!editable} onClick={()=>void submit('project-reference',{action:'remove',referenceId:reference.id,revision:project.revision})}>移除关联</button></div></li>)}</ul>
      {editor?.kind==='reference'&&<ReferenceEditor key={editor.id||'new'} reference={selectedReference} project={project} currentContext={currentContext} disabled={!editable} onSave={value=>submit('project-reference',{action:editor.id?'update':'add',...(editor.id?{referenceId:editor.id}:{}),...value})} onClose={()=>setEditor(null)}/>}
    </section>
    <section><div className="project-section-heading"><h4>决定与未决事项</h4><button type="button" disabled={!editable} onClick={()=>setEditor({kind:'record'})}>添加记录</button></div>
      {!records.length&&<p className="subtle">把已确认决定、备选方案和待办分开记录。</p>}
      <ul className="project-items">{records.filter(record=>!['retired','superseded'].includes(record.status)).map(record=><li key={record.id}><div><small>{recordTypes[record.type]||'项目记录'}</small><p>{record.text}</p></div><div className="project-actions"><button type="button" disabled={!editable} onClick={()=>setEditor({kind:'record',id:record.id})}>更正记录</button><button type="button" disabled={!editable} onClick={()=>void submit('project-record',{action:'retire',recordId:record.id,type:record.type,text:record.text,revision:project.revision})}>作废记录</button></div></li>)}</ul>
      {editor?.kind==='record'&&<RecordEditor key={editor.id||'new'} record={selectedRecord} project={project} disabled={!editable} onSave={value=>submit('project-record',{action:editor.id?'update':'add',...(editor.id?{recordId:editor.id}:{}),...value})} onClose={()=>setEditor(null)}/>}
    </section>
    <section><h4>关联任务</h4>{!tasks.length?<p className="subtle">暂无关联任务，日常讨论不需要创建任务。</p>:<ul className="project-items">{tasks.map(task=><li key={task.id}><button type="button" className="project-task" onClick={()=>onOpenTask?.(task.id)}><strong>{task.title||task.name||task.id}</strong><span>{taskStatuses[task.status]||'查看任务状态'}</span></button></li>)}</ul>}</section>
  </div>;
}

export function ProjectContext({api,view,currentContext,onRefresh,onOpenTask,disabled=false}){
  const [catalog,setCatalog]=useState(view),[open,setOpen]=useState(false),[inspectId,setInspectId]=useState(view?.state?.projectId||''),[creating,setCreating]=useState(false);
  const [detail,setDetail]=useState(null),[loading,setLoading]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(null),[refreshVersion,setRefreshVersion]=useState(0);
  const inflight=useRef(false),listOrder=useRef(0),detailOrder=useRef(0),panelId=useId();
  useEffect(()=>{setCatalog(view);},[view]);
  const projects=catalog?.projects||[],state=catalog?.state,current=projects.find(project=>project.id===state?.projectId),inspected=projects.find(project=>project.id===inspectId);
  const locked=disabled||pending||!!retry;
  async function loadCatalog(){const order=++listOrder.current;const value=await api.call('projects');if(order===listOrder.current)setCatalog(value);return value;}
  useEffect(()=>{
    if(!open)return;
    let stopped=false;void loadCatalog().catch(cause=>{if(!stopped)setError(messageFor(cause));});
    return()=>{stopped=true;listOrder.current++;};
  },[open,refreshVersion]);
  useEffect(()=>{
    if(!open||!inspectId){setDetail(null);setLoading(false);return;}
    let stopped=false;const order=++detailOrder.current;setLoading(true);
    if(detail?.project?.id!==inspectId)setDetail(null);
    void api.call('project-detail',{id:inspectId}).then(value=>{if(!stopped&&order===detailOrder.current)setDetail(value);}).catch(cause=>{if(!stopped)setError(messageFor(cause));}).finally(()=>{if(!stopped)setLoading(false);});
    return()=>{stopped=true;};
  },[open,inspectId,inspected?.revision,refreshVersion]);
  async function execute(request){
    if(inflight.current||disabled)return false;inflight.current=true;setPending(true);setError('');
    try{
      await api.call(request.name,request.body);setRetry(null);
      if(request.body.action==='create')setCreating(false);
      try{const value=await loadCatalog();if(request.body.action==='select')setInspectId(value.state.projectId||'');await onRefresh?.();}catch(cause){setError('操作已保存，刷新未完成。'+messageFor(cause));}
      setRefreshVersion(value=>value+1);return true;
    }catch(cause){
      if(cause?.code==='network')setRetry(request);else{setRetry(null);setRefreshVersion(value=>value+1);void onRefresh?.().catch(()=>{});}
      setError(messageFor(cause));return false;
    }finally{inflight.current=false;setPending(false);}
  }
  const mutate=(name,body)=>locked?Promise.resolve(false):execute({name,body:{...body,actionId:crypto.randomUUID()}});
  if(!view?.state)return null;
  return <div className="project-context">
    <div className="project-context-row"><button type="button" className="project-toggle" aria-expanded={open} aria-controls={panelId} onClick={()=>{if(!open)setInspectId(state?.projectId||projects[0]?.id||'');setOpen(value=>!value);}}><span>{state?.focus==='daily'?'可接续项目':'当前项目'}</span><strong>{current?.name||'未选择'}</strong><span aria-hidden="true">{open?'⌃':'⌄'}</span></button>
      <select aria-label="切换项目" disabled={locked} value={state?.projectId||''} onChange={event=>void mutate('project-action',{action:'select',projectId:event.target.value,revision:state.revision})}><option value="" disabled>选择项目</option>{projects.filter(project=>project.status!=='archived'||project.id===state?.projectId).map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select>
    </div>
    {error&&<p className="error" role="alert">{error}</p>}{retry&&<button type="button" disabled={pending||disabled} onClick={()=>void execute(retry)}>重试上次项目操作</button>}
    {open&&<section id={panelId} className="project-overview" aria-label="项目概览" aria-busy={loading||pending}>
      <div className="project-section-heading"><h2>项目概览</h2><div className="project-actions"><button type="button" disabled={disabled||pending} onClick={()=>{setError('');setRefreshVersion(value=>value+1);}}>刷新项目</button><button type="button" disabled={locked} onClick={()=>setCreating(value=>!value)}>新建项目</button></div></div>
      {creating&&<ProjectEditor disabled={locked} onSave={value=>mutate('project-action',{action:'create',...value})} onClose={()=>setCreating(false)}/>}
      <label className="project-browse">查看项目<select value={inspectId} onChange={event=>setInspectId(event.target.value)}><option value="">选择要查看的项目</option>{projects.map(project=><option key={project.id} value={project.id}>{project.name}{project.status==='archived'?'（已归档）':''}</option>)}</select></label>
      {loading&&<p className="subtle" role="status">正在加载项目…</p>}
      {detail?.project?.id===inspectId&&<ProjectDetail key={inspectId} detail={detail} currentContext={currentContext} disabled={locked||loading} mutate={mutate} onOpenTask={onOpenTask} onSelectProject={id=>void mutate('project-action',{action:'select',projectId:id,revision:state.revision})}/>}
      {detail?.project?.id===inspectId&&state?.focus==='work'&&state.projectId===inspectId&&
        <ProjectExperiments key={state.projectId+'-'+state.revision} api={api} project={state} refreshKey={refreshVersion+'-'+disabled}/>}
      {!inspectId&&!loading&&<p className="subtle">选择一个项目查看背景，也可以先创建没有外部目录的项目。</p>}
    </section>}
  </div>;
}
