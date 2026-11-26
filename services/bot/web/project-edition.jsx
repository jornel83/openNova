import React,{useEffect,useRef,useState} from 'react';
import {errorText} from './api.mjs';

const kinds={brief:'交接说明',review:'验收记录',decision:'处理决定',experiment:'实验记录'};
const diskLabels={changed:'磁盘文件已修改',missing:'磁盘文件已移走',unknown:'磁盘状态待核对'};

export function EditionLink({sourceId,title,api,project,offline}){
  const [edition,setEdition]=useState(null),[trail,setTrail]=useState([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const active=useRef(0);
  useEffect(()=>()=>{active.current++;},[]);

  async function work(fn){
    const ticket=++active.current;
    setBusy(true);setError('');
    try{await fn(()=>active.current===ticket);}
    catch(e){if(active.current===ticket)setError(errorText(e));}
    finally{if(active.current===ticket)setBusy(false);}
  }
  function show(id,history){
    return work(async current=>{
      const result=await api.call('project-edition',{sourceId:id,expectedProject:project});
      if(result.sourceId!==id||result.projectId!==project.projectId)throw Error('invalid_project_edition');
      if(current()){setEdition(result);setTrail(history);}
    });
  }
  function download(file){
    return work(async current=>{
      const blob=await api.call('project-edition-file',{sourceId:edition.sourceId,artifactId:file.id,expectedProject:project});
      if(!current())return;
      const url=URL.createObjectURL(blob),link=document.createElement('a');
      link.href=url;link.download=file.path.split(/[\\/]/).at(-1);link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
  }
  const locked=busy||offline;
  function toggle(){
    if(edition){setEdition(null);setError('');}
    else void show(sourceId,[]);
  }
  return <div className="edition-link" aria-busy={busy}>
    <button type="button" className="nova-secondary" aria-expanded={!!edition} disabled={busy||(!edition&&offline)}
      onClick={toggle}>{edition?'收起版本':title||'查看固定版本'}</button>
    {edition&&<section aria-label="成果版本" className="edition-body">
      {!!trail.length&&<button type="button" className="nova-secondary" disabled={locked} onClick={()=>void show(trail.at(-1),trail.slice(0,-1))}>返回上一份记录</button>}
      <strong>{edition.title}</strong>
      <small>{[kinds[edition.kind],edition.round?'第 '+edition.round+' 轮':null].filter(Boolean).join(' · ')}</small>
      <pre className="tool-output">{edition.text}</pre>
      {!!edition.links?.length&&<div className="project-actions" aria-label="关联版本">{edition.links.map(link=>
        <button key={link.sourceId} type="button" disabled={locked} onClick={()=>void show(link.sourceId,[...trail,edition.sourceId])}>{link.title}</button>)}</div>}
      {edition.exports?.map(file=><div key={file.id} className="edition-file">
        <span className="operation-path">{file.path.split(/[\\/]/).at(-1)}</span>
        {diskLabels[file.diskStatus]&&<small>{diskLabels[file.diskStatus]}</small>}
        <button type="button" className="nova-secondary" disabled={locked} onClick={()=>void download(file)}>下载已导出的 {file.format==='docx'?'Word':'PDF'}</button>
      </div>)}
    </section>}
    {error&&<p role="alert" className="error">{error}</p>}
  </div>;
}
