import React,{useEffect,useId,useRef,useState} from 'react';
import {errorText} from './api.mjs';
import {deviceChoices,deviceConnection,selectedDevices,sameDevices} from './voice-devices-state.mjs';

export function VoiceDevices({api,voice={},online=false,onRefresh}){
  const [open,setOpen]=useState(false),[catalog,setCatalog]=useState(null),[form,setForm]=useState({input:null,output:null});
  const [revision,setRevision]=useState(null),[dirty,setDirty]=useState(false),[loading,setLoading]=useState(false),[saving,setSaving]=useState(false);
  const [pending,setPending]=useState(null),[notice,setNotice]=useState(''),[error,setError]=useState('');
  const names=useRef({}),edit=useRef(false),order=useRef(0),inflight=useRef(false),latestVoice=useRef(voice),button=useRef();
  const panelId=useId();latestVoice.current=voice;
  const status=deviceConnection(voice,online),active=!!voice.connected&&voice.audioEnabled!==false;
  const switching=!!voice.devices?.switching,starting=voice.phase==='starting';
  const stale=dirty&&catalog&&revision!==catalog.revision;
  const locked=!online||loading||saving||!!pending||switching||starting;
  const inputChoices=deviceChoices(catalog,'input',form.input,names.current),outputChoices=deviceChoices(catalog,'output',form.output,names.current);
  const unavailable=[...inputChoices,...outputChoices].some(item=>item.unavailable);

  async function load(){
    const ticket=++order.current;setLoading(true);setError('');
    try{
      const next=await api.call('voice-devices');
      if(ticket!==order.current)return;
      for(const device of next.devices||[])names.current[device.id]=device.name;
      setCatalog(next);
      if(!edit.current){setForm(selectedDevices(next,latestVoice.current));setRevision(next.revision);}
    }catch(cause){if(ticket===order.current)setError(errorText(cause));}
    finally{if(ticket===order.current)setLoading(false);}
  }
  useEffect(()=>{
    if(open&&online)void load();
    return()=>{order.current++;};
  },[open,online]);
  useEffect(()=>{
    if(!catalog||dirty||saving||pending)return;
    setForm(selectedDevices(catalog,voice));setRevision(catalog.revision);
  },[catalog,dirty,saving,pending,voice.connected,voice.voiceInstanceId,voice.devices?.input,voice.devices?.output,voice.deviceRevision]);
  useEffect(()=>{
    if(!pending)return;
    const control=voice.controls?.find(item=>item.id===pending.id);
    if(control&&['failed','stale','unavailable'].includes(control.status)){
      setPending(null);setNotice('');
      setError(control.status==='failed'?'设备选择已保存，但连接未完成。请检查设备后重试或重新选择。':'设备选择已保存，语音连接已变化。请核对设备后重新开启或重连。');
    }else if(control?.status==='applied'&&!switching&&status.active&&voice.deviceRevision>=pending.revision&&sameDevices(selectedDevices({...catalog,revision:0},voice),pending.selection)){
      setPending(null);setNotice('音频设备已连接。');
    }else if(!online||!voice.connected||voice.voiceInstanceId!==pending.voiceInstanceId){
      setPending(null);setNotice('');setError('设备选择已保存，语音连接已变化。请核对设备后重新开启或重连。');
    }
  },[pending,voice.controls,voice.connected,voice.voiceInstanceId,voice.deviceRevision,voice.devices,online,switching,status.active,catalog]);
  useEffect(()=>{if(active&&notice==='设备选择已保存，下次开启语音时使用。')setNotice('');},[active,notice]);

  const change=(direction,value)=>{edit.current=true;setDirty(true);setForm(current=>({...current,[direction]:value||null}));setNotice('');setError('');};
  const reloadSaved=()=>{edit.current=true;setDirty(true);setForm(catalog.selection);setRevision(catalog.revision);setNotice('已载入保存的设备选择。');setError('');};
  async function save(event){
    event.preventDefault();if(inflight.current||locked||stale||unavailable||!catalog)return;
    inflight.current=true;setSaving(true);setError('');setNotice('');
    try{
      const next=await api.call('voice-devices-select',{expectedRevision:revision,...form,...(voice.connected?{voiceInstanceId:voice.voiceInstanceId}:{})});
      setCatalog(current=>({...current,selection:next.selection,revision:next.revision}));setRevision(next.revision);
      edit.current=false;setDirty(false);setForm(next.selection);
      if(next.apply==='queued'&&next.control){
        setPending({id:next.control.id,voiceInstanceId:voice.voiceInstanceId,selection:next.selection,revision:next.revision});setNotice('选择已保存，正在重连音频设备…');
      }else setNotice('设备选择已保存，下次开启语音时使用。');
      try{await onRefresh?.();}catch{setNotice('设备选择已保存，状态刷新暂未完成。');}
    }catch(cause){setError(errorText(cause));if(['voice_devices_changed','voice_device_settings_changed'].includes(cause.code||cause.message))void load();}
    finally{inflight.current=false;setSaving(false);}
  }
  return <div className={'voice-devices'+(open?' is-open':'')}>
    <div className="voice-devices-heading"><button ref={button} type="button" className="voice-devices-toggle" aria-expanded={open} aria-controls={panelId} onClick={()=>setOpen(value=>!value)}>音频设备<span aria-hidden="true">{open?'⌃':'⌄'}</span></button>{!open&&status.active&&voice.devices?.activeOutput&&<span className="voice-device-current" title={`外放：${voice.devices.activeOutput}`}>外放 · {voice.devices.activeOutput}</span>}</div>
    {open&&<section id={panelId} className="voice-device-panel" aria-label="音频设备设置" aria-busy={loading||saving||!!pending} onKeyDown={event=>{if(event.key==='Escape'){setOpen(false);button.current?.focus();}}}>
      <form onSubmit={event=>void save(event)}>
        <div className="voice-device-fields">{[['input','麦克风',inputChoices],['output','外放',outputChoices]].map(([direction,label,choices])=><label key={direction}>{label}<select aria-label={label} disabled={locked||!catalog} value={form[direction]||''} onChange={event=>change(direction,event.target.value)}>{choices.map(item=><option key={item.value} value={item.value} disabled={item.unavailable}>{item.label}</option>)}</select></label>)}</div>
        <p className="voice-device-status" role="status">{status.label}{status.active&&voice.devices?.activeInput&&<span>麦克风：{voice.devices.activeInput}</span>}{status.active&&voice.devices?.activeOutput&&<span>外放：{voice.devices.activeOutput}</span>}</p>
        <p className="voice-device-hint">先在系统设置连接设备，再刷新。麦克风和外放可以使用不同设备。</p>
        {stale&&<p className="voice-device-warning" role="status">设备设置已在其他窗口更新，当前选择已保留。<button type="button" onClick={reloadSaved}>载入已保存选择</button></p>}
        {unavailable&&<p className="voice-device-warning" role="status">所选设备不在可用列表中。请连接后刷新，或选择其他设备。</p>}
        {error&&<p className="error" role="alert">{error}</p>}
        {notice&&<p className="voice-device-notice" role="status">{notice}</p>}
        <div className="voice-device-actions"><button type="button" disabled={!online||loading||saving||!!pending} onClick={()=>void load()}>{loading?'正在刷新…':'刷新设备'}</button><button type="submit" disabled={locked||stale||unavailable||!catalog}>{saving?'正在保存…':pending||switching?'正在重连…':active?'应用并重连':'保存选择'}</button></div>
      </form>
    </section>}
  </div>;
}
