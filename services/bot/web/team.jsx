import React,{useRef,useState} from 'react';
import {errorText} from './api.mjs';
import {taskLabels} from './task-view.mjs';
const fresh={name:'',role:'',instructions:'',taskTypes:[],enabled:true};
const labels={idle:'空闲',working:'执行中',queued:'排队中',waiting_input:'等待信息',paused:'已暂停或等待事件'};
export function TeamPanel({api,team,disabled,onSelect}){
  const [edit,setEdit]=useState(null),[error,setError]=useState(''),[pending,setPending]=useState(false),submission=useRef(null);
  if(!team)return null;
  async function save(e){e.preventDefault();setPending(true);setError('');submission.current??={...edit,action:edit.id?'update':'create',actionId:crypto.randomUUID()};
    try{await api.call('team-member',submission.current);submission.current=null;setEdit(null);}catch(e){setError(errorText(e));if(e.code!=='network')submission.current=null;}finally{setPending(false);}}
  return <section className="team-panel" aria-label="员工团队"><div className="task-heading"><h3>员工团队</h3><button disabled={disabled||pending||!team.enabled} onClick={()=>{submission.current=null;setEdit({...fresh});}}>添加员工</button></div>
    <p className="subtle">按职责分工，每位员工都可承接通用任务。总管可检查成果并跟进返工，需要你判断的事项集中显示。</p>
    <label className="task-check"><input type="checkbox" checked={team.enabled} disabled={disabled||pending} onChange={async e=>{setPending(true);setError('');try{await api.call('team-member',{actionId:crypto.randomUUID(),action:'toggle',enabled:e.target.checked});}catch(e){setError(errorText(e));}finally{setPending(false);}}}/>启用团队派工</label>
    {error&&<p role="alert" className="error">{error}</p>}
    <div className="team-members">{team.members.map(m=><article key={m.id} className="team-member"><strong>{m.name}{m.chief?' · 总管':''}</strong><span>{m.role} · {m.enabled?labels[m.status]:'已停用'}</span><small>{m.taskTypes?.length?'擅长：'+m.taskTypes.map(t=>({code:'代码',documents:'资料',command:'命令'})[t]).join(' / '):'通用工作'}</small>
      {m.tasks.map(t=><button key={t.id} onClick={()=>onSelect(t.id)}>{t.title} · {taskLabels[t.status]||'待接续'}</button>)}
      {!m.chief&&<button disabled={disabled||pending||!team.enabled} onClick={()=>{submission.current=null;setEdit({id:m.id,revision:m.revision,name:m.name,role:m.role,instructions:m.instructions,taskTypes:m.taskTypes??[],enabled:m.enabled,chief:m.chief});}}>编辑员工</button>}</article>)}</div>
    {edit&&<form className="team-edit" onSubmit={save}><h4>{edit.id?'编辑员工':'添加员工'}</h4>
      <label>姓名<input required maxLength={40} value={edit.name} onChange={e=>setEdit({...edit,name:e.target.value})}/></label>
      <label>职责名称<input required maxLength={24} value={edit.role} onChange={e=>setEdit({...edit,role:e.target.value})}/></label>
      <label>工作要求<textarea rows={3} required maxLength={4000} value={edit.instructions} onChange={e=>setEdit({...edit,instructions:e.target.value})}/></label>
      <fieldset><legend>擅长方向（选填）</legend>{[['code','代码工程'],['documents','资料整理'],['command','命令与脚本']].map(([value,label])=><label className="task-check" key={value}><input type="checkbox" checked={edit.taskTypes.includes(value)} onChange={e=>setEdit({...edit,taskTypes:e.target.checked?[...edit.taskTypes,value]:edit.taskTypes.filter(t=>t!==value)})}/>{label}</label>)}</fieldset>
      <p className="subtle">不选表示通用工作。擅长方向帮助总管分工，不限制员工可用的工具。</p>
      {!edit.chief&&<label className="task-check"><input type="checkbox" checked={edit.enabled} onChange={e=>setEdit({...edit,enabled:e.target.checked})}/>允许承接任务</label>}
      {submission.current&&<p className="subtle">再次提交会核对同一操作，当前编辑不会替换上次提交。</p>}
      <div className="task-actions"><button disabled={disabled||pending} type="submit">{pending?'保存中…':'保存员工'}</button><button type="button" disabled={pending} onClick={()=>{setEdit(null);submission.current=null;}}>关闭编辑</button></div>
    </form>}
  </section>;
}
export function AssigneeSelect({team,value,onChange}){
  if(!team)return null;
  return <label>负责人<select value={value||''} onChange={e=>onChange(e.target.value)}><option value="">总管负责</option>{team.enabled&&team.members.filter(m=>!m.chief&&m.enabled).map(m=><option key={m.id} value={m.id}>{m.name} · {m.role}</option>)}</select></label>;
}
