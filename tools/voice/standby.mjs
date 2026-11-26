import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';

/** The launcher owns only a control lease here; no audio or speech service runs. */
export async function voiceStandby({call,signal,input=process.stdin,phase='standby',problem=null,interval=1000,getDevices}) {
  const voiceInstanceId=randomUUID();
  let seq=0,closed=false,terminal=null,publishing=Promise.resolve();
  const state={voiceInstanceId,generation:0,captureEpoch:0,capture:'off',recognition:'idle',
    playback:'idle',requestId:null,draft:null,audioEnabled:false,phase,problem};
  const publish=()=>{
    // Serialize the heartbeat with phase changes and the final ownership release.
    publishing=publishing.catch(()=>{}).then(async()=>{
      if(!closed&&getDevices)Object.assign(state,await getDevices());
      return call('/voice/publish',{...state,seq:++seq,connected:!closed},{cleanup:closed});
    });
    return publishing;
  };
  // A crashed child may leave its lease until the host's six-second TTL expires.
  // Never force ownership away from a client that is still publishing.
  for(let attempt=0;;attempt++){
    try{await publish();break;}
    catch(error){
      if(error.message!=='voice_in_use'||attempt>=8)throw error;
      await delay(1000,undefined,{signal});
    }
  }
  let heartbeatError,heartbeatFailures=0;
  const timer=setInterval(()=>{if(!closed)void publish().then(()=>{heartbeatError=null;heartbeatFailures=0;})
    .catch(error=>{heartbeatError=error;heartbeatFailures++;});},interval);
  const close=async({handoff=false}={})=>{
    if(closed)return;closed=true;clearInterval(timer);
    if(!handoff)state.phase='standby';
    terminal?.close();
    await publish().catch(()=>{});
  };
  return {
    async wait(){
      const lines=[];let pollFailures=0;
      if(input){terminal=createInterface({input,terminal:false});terminal.on('line',line=>lines.push(line.trim()));}
      try {
        while(true){
          signal?.throwIfAborted();
          if(heartbeatError&&(['stale_voice_instance','voice_in_use'].includes(heartbeatError.message)||heartbeatFailures>=4))throw heartbeatError;
          const line=lines.shift();
          if(['/quit','/exit'].includes(line))return false;
          if(['/start','/retry'].includes(line))return true;
          let result;
          try{result=await call('/voice/poll',{voiceInstanceId});pollFailures=0;}
          catch(error){
            signal?.throwIfAborted();
            if(['stale_voice_instance','voice_in_use'].includes(error.message)||++pollFailures>=6)throw error;
            await delay(500,undefined,{signal});continue;
          }
          for(const command of result.commands??[]){
            if(command.voiceInstanceId!==voiceInstanceId)continue;
            const starts=['start','retry'].includes(command.action);
            await call('/voice/ack',{id:command.id,voiceInstanceId,generation:command.generation,
              status:starts||command.action==='disable'?'applied':'stale'});
            if(starts)return true;
          }
          // Also support hosts returning immediately, without a busy poll loop.
          await delay(50,undefined,{signal});
        }
      }finally{terminal?.close();terminal=null;}
    },
    async starting(){state.phase='starting';state.problem=null;await publish();},
    async finish(){state.phase='standby';await publish().catch(()=>{});},
    close,
  };
}
