/** Ephemeral native voice lease. No audio or draft transcription is persisted. */
const actions=new Set(['stop','mute','unmute','end','start','retry']);
const id=value=>typeof value==='string'&&value.length>0&&value.length<=128;
export function createVoiceChannel({events,now=Date.now,ttl=6000,pollMs=1000}={}) {
 let state=null,seen=0,closed=false;
 const retired=new Set(),controls=new Map(),waiters=new Set();
 const wake=()=>{for(const resolve of waiters)resolve();};
 const emit=()=>{events?.publish('voice.updated',snapshot());wake();};
 const matches=c=>state&&c.voiceInstanceId===state.voiceInstanceId&&(c.action!=='stop'||(c.generation===state.generation&&c.requestId===state.requestId));
 function expire(){
  if(state?.connected&&now()-seen>ttl){state={...state,connected:false,draft:null};for(const c of controls.values())if(c.status==='queued')c.status='unavailable';emit();}
 }
 function snapshot(){expire();return state?structuredClone({...state,controls:[...controls.values()].slice(-20)}):{connected:false};}
 const timer=setInterval(expire,Math.min(1000,ttl));timer.unref();
 function publish(update){
  if(closed)throw Error('voice_unavailable');
  if(!id(update.voiceInstanceId)||!Number.isSafeInteger(update.seq)||!Number.isSafeInteger(update.generation)||update.generation<0||!Number.isSafeInteger(update.captureEpoch))throw Error('invalid_voice_update');
  expire();
  if(retired.has(update.voiceInstanceId))throw Error('stale_voice_instance');
  if(state&&state.voiceInstanceId!==update.voiceInstanceId){
   if(state.connected)throw Error('voice_in_use');
   retired.add(state.voiceInstanceId);if(retired.size>256)retired.delete(retired.values().next().value);
   controls.clear();state=null;
  }
  if(state&&update.seq<=state.seq)return {ignored:true};
  if(state&&(update.generation<state.generation||update.captureEpoch<state.captureEpoch))throw Error('stale_voice_update');
  if(!['off','listening','muted','error'].includes(update.capture)||!['idle','recognizing'].includes(update.recognition)||!['idle','buffering','playing','paused','error'].includes(update.playback))throw Error('invalid_voice_update');
  if(update.requestId!=null&&!id(update.requestId))throw Error('invalid_voice_update');
  const draft=update.draft;
  if(draft!=null&&(!id(draft.utteranceId)||typeof draft.text!=='string'||draft.text.length>16000))throw Error('invalid_voice_update');
  state={voiceInstanceId:update.voiceInstanceId,seq:update.seq,generation:update.generation,captureEpoch:update.captureEpoch,
   capture:update.capture,recognition:update.recognition,playback:update.playback,requestId:update.requestId??null,
   draft:draft?{text:draft.text,utteranceId:draft.utteranceId,requestId:id(draft.requestId)?draft.requestId:null}:null,connected:update.connected!==false};
  seen=now();
  for(const c of controls.values())if(c.status==='queued'&&!matches(c))c.status='stale';
  emit();return {accepted:true};
 }
 function enqueue(input){
  expire();if(!state?.connected||closed)throw Error('voice_unavailable');
  if(!id(input.id)||!actions.has(input.action))throw Error('invalid_voice_control');
  const prior=controls.get(input.id);
  if(prior){if(['action','voiceInstanceId','generation','requestId'].some(k=>prior[k]!==input[k]))throw Error('control_id_conflict');return structuredClone(prior);}
  const c={id:input.id,action:input.action,voiceInstanceId:input.voiceInstanceId,generation:input.generation,requestId:input.requestId,status:'queued'};
  if(!matches(c))throw Error('stale_voice_control');
  const pending=[...controls.values()].filter(x=>x.status==='queued');
  if(pending.length>=16){
   if(c.action!=='stop')throw Error('voice_control_busy');
   // Reserve effective Stop delivery even while ordinary controls are backed up.
   pending[0].status='stale';
  }
  controls.set(c.id,c);while(controls.size>256){const first=[...controls.values()].find(x=>x.status!=='queued');if(!first)break;controls.delete(first.id);}
  emit();return structuredClone(c);
 }
 async function poll(instanceId,signal){
  expire();if(!state?.connected||state.voiceInstanceId!==instanceId||closed)throw Error('voice_unavailable');
  const read=()=>[...controls.values()].filter(c=>c.status==='queued'&&matches(c)).sort((a,b)=>Number(b.action==='stop')-Number(a.action==='stop'));
  if(!read().length)await new Promise(resolve=>{
   const done=()=>{clearTimeout(timeout);waiters.delete(done);signal?.removeEventListener('abort',done);resolve();};
   const timeout=setTimeout(done,pollMs);waiters.add(done);signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();
  });
  return {commands:structuredClone(read())};
 }
 function ack(result){
  expire();const c=controls.get(result.id);
  if(!state?.connected||!c||!matches(c)||result.voiceInstanceId!==c.voiceInstanceId||result.generation!==c.generation)throw Error('stale_voice_control');
  if(!['applied','stale','failed'].includes(result.status))throw Error('invalid_voice_ack');
  if(c.status==='queued'){c.status=result.status;emit();}
  return structuredClone(c);
 }
 function close(){closed=true;clearInterval(timer);if(state)state.connected=false;wake();}
 return {publish,poll,enqueue,ack,snapshot,close};
}
