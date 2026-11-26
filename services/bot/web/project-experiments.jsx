import React,{useEffect,useState} from 'react';
import {errorText} from './api.mjs';

const roles={data:'输入数据',config:'配置',log:'日志',sample:'样音',model:'模型',artifact:'产物'};
const sourceStates={content_matches:'原件内容与登记时一致',version_matches:'原件版本信息与登记时一致',changed:'原件版本已变化',missing:'原件已移除',unavailable:'暂时无法核对原件',workspace_changed:'项目目录已变更'};

function Evidence({api,expectedProject,runId,file}) {
  const [show,setShow]=useState(false), [value,setValue]=useState(null), [error,setError]=useState('');
  const [source,setSource]=useState(null);
  const {projectId,revision}=expectedProject, {path,sha256}=file,reference=file.mode==='reference';
  useEffect(()=>{
    if(!show)return;
    let active=true, url;
    setError('');setValue(null);setSource(null);
    const target={expectedProject:{projectId,revision},runId,path,sha256};
    api.call('project-experiments',{...target,checkSource:true}).then(result=>{if(active)setSource(result);})
      .catch(()=>{if(active)setSource({state:'unavailable'});});
    if(!reference)api.call('experiment-evidence',target)
      .then(async blob=>{
        if(!active)return;
        if(blob.type.startsWith('text/')) {
          const content=await blob.text();
          if(active)setValue({text:content});
        } else {
          url=URL.createObjectURL(blob);
          setValue({url});
        }
      }).catch(e=>{if(active)setError(errorText(e));});
    return ()=>{active=false;if(url)URL.revokeObjectURL(url);};
  },[api,projectId,revision,runId,path,sha256,show,reference]);
  return <li>
    <button type="button" aria-expanded={show} onClick={()=>setShow(!show)}>{roles[file.role]} · {file.name}</button>
    {show&&<div><small>{reference?'仅引用原件':'已保存固定版本'} · {file.location??file.path} · SHA-256 {sha256}</small>
      <small>{source?sourceStates[source.state]:'正在核对原件…'}</small>
      {error&&<p role="alert">{error}</p>}
      {!reference&&!error&&!value&&<p role="status">正在读取固定版本…</p>}
      {value?.text!==undefined&&<pre style={{whiteSpace:'pre-wrap',maxHeight:'16rem',overflow:'auto'}}>{value.text}</pre>}
      {value?.url&&(file.contentType.startsWith('audio/')?<audio aria-label={file.name} src={value.url} controls preload="metadata" style={{width:'100%'}}/>:
        <a href={value.url} download={file.name}>下载{file.name}</a>)}
    </div>}
  </li>;
}

function Run({run,api,expectedProject}) {
  return <article style={{minWidth:0,overflowWrap:'anywhere'}}>
    <h5>{run.title}</h5><small>{run.modelVersion??'模型版本待补充'}{run.modelEvidence?.length?' · 见 '+run.modelEvidence.join('、'):run.modelVersion?' · 登记值':''}</small>
    <ul>{run.files.map(file=><Evidence key={file.path} api={api} expectedProject={expectedProject} runId={run.id} file={file}/>)}</ul>
    {run.findings.map((finding,index)=><p key={index}>{finding.kind==='measured'?'实测':'记录结论'} · {finding.text}<small>依据 · {finding.evidence.join('、')}</small></p>)}
  </article>;
}

function ExperimentList({api,project,refreshKey}) {
  const [page,setPage]=useState({runs:[],nextOffset:null}),[error,setError]=useState('');
  const [baseline,setBaseline]=useState(''),[chosen,setChosen]=useState(''),[comparison,setComparison]=useState(null);
  const [loadThrough,setLoadThrough]=useState(0);
  const {projectId,revision}=project;
  useEffect(()=>{
    let active=true;
    async function load() {
      const runs=[];let result, offset=0;
      do {
        result=await api.call('project-experiments',{expectedProject:{projectId,revision},offset});
        if(!active)return;
        runs.push(...result.runs);
        offset=result.nextOffset;
      } while(offset!==null&&offset<=loadThrough);
      setPage({runs,nextOffset:result.nextOffset});setError('');
    }
    load().catch(e=>{if(active)setError(errorText(e));});
    return ()=>{active=false;};
  },[api,projectId,revision,refreshKey,loadThrough]);
  const latest=page.runs[0];
  const previous=latest&&page.runs.find(run=>run.experiment===latest.experiment&&run.id!==latest.id);
  const first=page.runs.find(run=>run.id===baseline)||previous||latest;
  const others=first?page.runs.filter(run=>run.experiment===first.experiment&&run.id!==first.id):[];
  const second=others.find(run=>run.id===chosen)||others[0];
  const firstId=first?.id,secondId=second?.id;
  useEffect(()=>{
    let active=true;
    setComparison(null);
    if(firstId&&secondId) {
      api.call('project-experiments',{expectedProject:{projectId,revision},runIds:[firstId,secondId]})
        .then(result=>{if(active)setComparison(result);})
        .catch(e=>{if(active)setError(errorText(e));});
    }
    return ()=>{active=false;};
  },[api,projectId,revision,firstId,secondId]);
  if(!page.runs.length&&!error)return null;
  const compared=comparison?.runs[0].id===firstId&&comparison?.runs[1].id===secondId?comparison:null;
  return <section className="project-experiments"><h4>实验成果</h4>
    {error&&<p role="alert" className="error">{error}</p>}
    {first&&<><div className="project-actions"><label>基准轮次 <select value={firstId} onChange={event=>{setBaseline(event.target.value);setChosen('');}}>
      {page.runs.map(run=><option key={run.id} value={run.id}>{run.experiment} · {run.title} · {run.id.slice(-8)}</option>)}
    </select></label>
    {!!others.length&&<label>对照轮次 <select value={secondId} onChange={event=>setChosen(event.target.value)}>
      {others.map(run=><option key={run.id} value={run.id}>{run.title} · {run.id.slice(-8)}</option>)}
    </select></label>}
    {page.nextOffset!==null&&<button type="button" onClick={()=>setLoadThrough(page.nextOffset)}>更早的实验</button>}</div>
    {compared&&<div>
      <p>{compared.sameInput===null?'输入资料待补充':compared.sameInput?'两轮输入文件相同':'两轮输入文件有变化'}{compared.duration&&
        ` · 样音时长 ${compared.duration.beforeSeconds} → ${compared.duration.afterSeconds} 秒`}</p>
      {compared.changes.map(change=><p key={change.key}>{change.key} · {JSON.stringify(change.before)??'未设置'} → {JSON.stringify(change.after)??'未设置'}</p>)}
      {compared.configurationSummary&&<p>{compared.configurationSummary}</p>}
    </div>}
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit, minmax(min(100%, 15rem), 1fr))',gap:'1rem'}}>
      {(compared?.runs || [first]).map(run=><Run key={run.id} run={run} api={api} expectedProject={{projectId,revision}}/>)}</div></>}
  </section>;
}

export function ProjectExperiments({api,project,refreshKey}) {
  if(!project?.projectId||project.focus!=='work')return null;
  return <ExperimentList key={project.projectId+'-'+project.revision} api={api} project={project} refreshKey={refreshKey}/>;
}

export function ExperimentReceipt({api,project,record}) {
  const [expanded,setExpanded]=useState(false),[view,setView]=useState(null),[error,setError]=useState('');
  const {projectId,revision}=project??{}, valid=projectId&&record.projectId===projectId&&project?.focus!=='daily';
  const ids=record.sourceIds??[], key=JSON.stringify(ids);
  useEffect(()=>{
    let active=true;
    setView(null);setError('');
    if(expanded&&valid) {
      api.call('project-experiments',{expectedProject:{projectId,revision},runIds:JSON.parse(key)})
        .then(result=>{if(active)setView({key,result});})
        .catch(e=>{if(active)setError(errorText(e));});
    }
    return ()=>{active=false;};
  },[api,expanded,valid,projectId,revision,key]);
  if(!valid||!ids.length)return null;
  const stored=view?.key===key?view.result:null;
  return <div className="experiment-receipt">
    <button type="button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>
      {expanded?'收起实验记录':ids.length===2?'查看本次实验对照':'查看本轮实验成果'}</button>
    {expanded&&<div>
      {error&&<p className="error" role="alert">{error}</p>}
      {!error&&!stored&&<p role="status">正在读取固定版本…</p>}
      {stored?.duration&&<p>样音时长 {stored.duration.beforeSeconds} → {stored.duration.afterSeconds} 秒</p>}
      {stored?.configurationSummary&&<p>{stored.configurationSummary}</p>}
      {stored?.runs.map(run=><Run key={run.id} run={run} api={api} expectedProject={{projectId,revision}}/>)}
    </div>}
  </div>;
}
