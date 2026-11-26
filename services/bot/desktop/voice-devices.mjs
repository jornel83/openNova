import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {accessSync,constants,mkdirSync,readFileSync,writeFileSync,renameSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const exec=promisify(execFile);
const selector=value=>value===null||(typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\r\n\0]/.test(value));
export function voiceDeviceSelection(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||!selector(value.input)||!selector(value.output))throw Error('invalid_voice_devices');
 return {input:value.input,output:value.output};
}

/** Enumerating CoreAudio devices does not initialize an engine or request the microphone. */
export function nativeVoiceDevices({root,platform=process.platform,run=exec,env=process.env}={}){
 let preparing=null;
 async function helper(){
  if(platform!=='darwin')throw Error('voice_devices_unsupported');
  if(env.OPENNOVA_PACKAGED==='1'){
   if(!env.OPENNOVA_BIN_DIR)throw Error('voice_devices_runtime_missing');
   const binary=join(env.OPENNOVA_BIN_DIR,'opennova-audio');
   try{accessSync(binary,constants.X_OK);}catch{throw Error('voice_devices_runtime_missing');}
   return binary;
  }
  const sources=['PlaybackQueue.swift','AudioDevices.swift','AudioBridge.swift'].map(name=>join(root,'tools/voice/native',name));
  const binary=join(root,'output/voice/bin/opennova-audio');
  let current=false;
  try{current=statSync(binary).mtimeMs>=Math.max(...sources.map(path=>statSync(path).mtimeMs));}catch{}
  if(!current){
   if(!preparing)preparing=(async()=>{
    mkdirSync(join(root,'output/voice/bin'),{recursive:true});
    const temporary=binary+'.'+randomUUID();
    try{
     await run('xcrun',['swiftc','-O',...sources,'-o',temporary],{timeout:120000,maxBuffer:2_000_000});
     renameSync(temporary,binary);
    }catch{throw Error('voice_devices_build_failed');}
    finally{rmSync(temporary,{force:true});}
   })().finally(()=>{preparing=null;});
   await preparing;
  }
  return binary;
 }
 return async()=>{
  const binary=await helper();let value;
  try{
   const {stdout}=await run(binary,['--list-devices'],{timeout:15000,maxBuffer:1_000_000});
   value=JSON.parse(stdout);
  }catch{throw Error('voice_devices_unavailable');}
  if(value?.type!=='devices'||!Array.isArray(value.devices)||value.devices.length>512)throw Error('voice_devices_unavailable');
  const devices=[],seen=new Set();
  for(const device of value.devices){
   if(typeof device.uid!=='string'||!device.uid||!selector('uid:'+device.uid)||seen.has(device.uid))continue;
   if(typeof device.name!=='string'||!device.name||device.name.length>1024)continue;
   if(!Number.isInteger(device.input_channels)||!Number.isInteger(device.output_channels)||device.input_channels<0||device.output_channels<0)continue;
   if(!device.input_channels&&!device.output_channels)continue;
   seen.add(device.uid);
   devices.push({id:'uid:'+device.uid,name:device.name,inputChannels:device.input_channels,outputChannels:device.output_channels,
    ...(device.id===value.default_input?{defaultInput:true}:{}),...(device.id===value.default_output?{defaultOutput:true}:{})});
  }
  return {devices,defaultInput:devices.find(d=>d.defaultInput)?.id??null,defaultOutput:devices.find(d=>d.defaultOutput)?.id??null};
 };
}

/** Desired devices are durable; actual audio ownership stays with the voice lease. */
export function createVoiceDevices({home,root,voice,events,enumerate=nativeVoiceDevices({root})}){
 const path=join(home,'voice-devices.json');
 let saved;
 function settings(){
  if(!saved){
   try{
    const value=JSON.parse(readFileSync(path,'utf8'));
    if(value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<0)throw Error();
    saved={selection:voiceDeviceSelection(value.selection),revision:value.revision};
   }catch(error){
    if(error.code!=='ENOENT')throw Error('voice_device_settings_invalid');
    saved={selection:{input:null,output:null},revision:0};
   }
  }
  return structuredClone(saved);
 }
 function save(next){
  const temporary=path+'.'+randomUUID();
  try{
   mkdirSync(home,{recursive:true,mode:0o700});
   writeFileSync(temporary,JSON.stringify({version:1,...next})+'\n',{mode:0o600,flag:'wx'});
   renameSync(temporary,path);saved=next;
  }catch{throw Error('voice_device_settings_save_failed');}
  finally{rmSync(temporary,{force:true});}
 }
 async function list(){return {...await enumerate(),...settings()};}
 async function select(input){
  const selection=voiceDeviceSelection(input);
  if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw Error('invalid_voice_devices');
  const catalog=await enumerate();
  for(const [direction,channels] of [['input','inputChannels'],['output','outputChannels']]){
   if(selection[direction]!==null&&!catalog.devices.some(d=>d.id===selection[direction]&&d[channels]>0))throw Error('voice_device_not_available');
  }
  // All awaits finish before this CAS, lease check, durable save and queue commit.
  const prior=settings();
  if(prior.revision!==input.expectedRevision)throw Error('voice_device_settings_changed');
  const state=voice?.snapshot()??{};
  if(state.phase==='starting')throw Error('voice_control_unavailable');
  if(state.connected&&(state.devices?.switching||state.controls?.some(c=>c.action==='devices'&&c.status==='queued')))throw Error('voice_control_busy');
  const next={selection,revision:prior.revision+1};
  let control;
  if(state.connected&&state.audioEnabled!==false){
   if(input.voiceInstanceId!==state.voiceInstanceId)throw Error('stale_voice_control');
   control=voice.enqueue({id:randomUUID(),action:'devices',devices:selection,deviceRevision:next.revision,
    voiceInstanceId:state.voiceInstanceId,generation:state.generation,requestId:state.requestId},
    {beforeQueue:()=>save(next)});
  }else save(next);
  events?.publish('voice.devices',next);
  return {...structuredClone(next),apply:control?'queued':'next_start',...(control?{control}: {})};
 }
 return {settings,list,select};
}
