import React,{useEffect,useRef,useState} from 'react';
import {errorText} from './api.mjs';

const downloads=[['gif','GIF'],['firstFrame','首帧 PNG'],['video','源 MP4']];
const filename=path=>path.split('/').at(-1);

export function GeneratedImage({record,api,project,disabled,onAction}){
  const holder=useRef(null);
  const [visible,setVisible]=useState(false),[url,setUrl]=useState(''),[error,setError]=useState(''),[working,setWorking]=useState(false);
  const [playing,setPlaying]=useState(false);
  const {id,artifact,file}=record;
  const isGif=record.operation==='gif_generate';
  const previewPart=isGif?(playing?'gif':'firstFrame'):undefined;
  const name=isGif?filename(artifact.path):file.name;
  const projectId=project.projectId,revision=project.revision;
  useEffect(()=>{
    const observer=new IntersectionObserver(([entry])=>setVisible(entry.isIntersecting),{rootMargin:'160px'});
    observer.observe(holder.current);
    return ()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    let active=true,objectUrl;
    setUrl('');setError('');
    if(visible){
      api.call('image-preview',{operationId:id,expectedProject:{projectId,revision},artifact:previewPart})
        .then(blob=>{if(active){objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);}})
        .catch(e=>{if(active)setError(errorText(e));});
    }
    return ()=>{active=false;if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[api,id,visible,projectId,revision,previewPart]);
  async function act(name){
    setWorking(true);setError('');
    try{await onAction(name,id);}
    catch(e){setError(errorText(e));}
    finally{setWorking(false);}
  }
  async function download(part){
    setWorking(true);setError('');
    try{
      const blob=await api.call('image-preview',{operationId:id,expectedProject:{projectId,revision},artifact:part});
      const link=document.createElement('a');
      const fileUrl=URL.createObjectURL(blob);
      link.href=fileUrl;
      link.download=filename(record.artifacts[part].path);
      link.click();
      setTimeout(()=>URL.revokeObjectURL(fileUrl),1000);
    }catch(e){setError(errorText(e));}
    finally{setWorking(false);}
  }
  return <figure className="generated-image" ref={holder}>
    <div className="generated-image-preview" style={{aspectRatio:artifact.width+'/'+artifact.height}}>
      {url&&<img src={url} alt={name} width={artifact.width} height={artifact.height}/>}
    </div>
    <figcaption><strong>{name}</strong><small>{artifact.width} × {artifact.height}{isGif&&artifact.frames>0?' · '+artifact.frames+' 帧':''}
      {!isGif&&record.generation?.provider==='spark'?' · Minimax H3 Image':''}
      {isGif&&record.generation?.provider==='ark'?' · Seedance 视频转 GIF':''}</small></figcaption>
    {isGif?<div className="generated-image-actions">
      <button type="button" onClick={()=>setPlaying(value=>!value)} disabled={disabled}>{playing?'停止预览':'播放 GIF'}</button>
      <button type="button" onClick={()=>void act('gif-open')} disabled={working||disabled}>在本机打开</button>
      {downloads.filter(([part])=>record.artifacts[part]?.path).map(([part,label])=><button key={part} type="button" onClick={()=>void download(part)} disabled={working||disabled}>下载 {label}</button>)}
    </div>:<div className="generated-image-actions">
      <button type="button" onClick={()=>void act('image-open')} disabled={working||disabled}>打开原图</button>
      <button type="button" onClick={()=>void act('image-select')} disabled={working||disabled}>用这版继续改</button>
    </div>}
    {error&&<p className="error" role="alert">{error}</p>}
  </figure>;
}
