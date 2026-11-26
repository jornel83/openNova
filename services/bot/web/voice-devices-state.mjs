const normalize=value=>value.replace(/\s/g,'').toLocaleLowerCase();
const channel=direction=>direction==='input'?'inputChannels':'outputChannels';

/** Resolve legacy launcher names for display without choosing an ambiguous device. */
export function deviceSelection(value,devices,direction){
  if(!value)return null;
  if(value.startsWith('uid:'))return value;
  const eligible=devices.filter(device=>device[channel(direction)]>0),name=normalize(value);
  const exact=eligible.filter(device=>normalize(device.name)===name);
  const matches=exact.length?exact:eligible.filter(device=>normalize(device.name).includes(name));
  return matches.length===1?matches[0].id:value;
}

export function selectedDevices(catalog,voice){
  const liveCurrent=!Number.isSafeInteger(voice?.deviceRevision)||voice.deviceRevision>=(catalog?.revision??0);
  const source=voice?.connected&&voice.devices&&liveCurrent?voice.devices:catalog?.selection||{};
  return Object.fromEntries(['input','output'].map(direction=>[direction,deviceSelection(source[direction],catalog?.devices||[],direction)]));
}

export function deviceChoices(catalog,direction,selected,knownNames={}){
  const devices=catalog?.devices||[],eligible=devices.filter(device=>device[channel(direction)]>0);
  const defaultId=catalog?.[direction==='input'?'defaultInput':'defaultOutput'];
  const defaultName=eligible.find(device=>device.id===defaultId)?.name;
  const result=[{value:'',label:defaultName?`系统默认（${defaultName}）`:'系统默认'},...eligible.map(device=>({value:device.id,label:device.name}))];
  if(selected&&!eligible.some(device=>device.id===selected)){
    const name=knownNames[selected]||(selected.startsWith('uid:')?'上次选择的设备':selected);
    result.push({value:selected,label:`${name}（未连接或不可用于${direction==='input'?'麦克风':'外放'}）`,unavailable:true});
  }
  return result;
}

export const sameDevices=(a,b)=>a?.input===b?.input&&a?.output===b?.output;

export function deviceConnection(voice,online){
  if(!online)return {label:'服务连接中断',active:false};
  if(voice?.devices?.switching)return {label:'正在切换音频设备…',active:false};
  if(voice?.phase==='starting')return {label:'正在连接音频设备…',active:false};
  if(!voice?.connected)return {label:'语音未启动',active:false};
  if(voice.capture==='error'||voice.playback==='error')return {label:'音频连接异常，请检查设备后重连',active:false};
  if(voice.audioEnabled===false)return {label:'语音未开启，保存后将在开启时使用',active:false};
  return {label:'当前音频设备',active:true};
}
