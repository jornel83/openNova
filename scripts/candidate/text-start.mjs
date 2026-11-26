// Exercise the actual start.command and browser-facing Bot API in an isolated installation.
import {spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {createServer,createConnection} from 'node:net';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const runner=fileURLToPath(new URL('./stage-runner.mjs',import.meta.url));
const guard=fileURLToPath(new URL('./no-audio.cjs',import.meta.url));
function requireProbe(value,code){if(!value)throw Error('candidate_probe_'+code);}

async function allocatePorts(){
  // Keep the first port bound while allocating the second. Port collisions after
  // release cannot authorize another service: health uses a fresh per-run token.
  const servers=[];
  try{
    for(let i=0;i<2;i++){
      const server=createServer();servers.push(server);
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    }
    return servers.map(s=>s.address().port);
  }finally{await Promise.all(servers.filter(s=>s.listening).map(s=>new Promise(resolve=>s.close(resolve))));}
}
function listening(port){
  return new Promise(resolve=>{
    const socket=createConnection({host:'127.0.0.1',port});
    const finish=result=>{socket.destroy();resolve(result);};
    socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.setTimeout(750,()=>finish(true));
  });
}
async function waitFor(probe,timeout,reason,signal){
  const end=Date.now()+timeout;
  for(;;){
    signal?.throwIfAborted();
    const result=await probe();
    if(result)return result;
    requireProbe(Date.now()<end,reason);
    await delay(150,undefined,{signal});
  }
}
// Keep the launcher's raw output private. The Harness prints a bootstrap URL
// on startup whose token must not enter the sharable receipt bundle.
export function redactProbeLog(text,secrets=[]){
  for(const secret of secrets)if(secret)text=text.replaceAll(secret,'[redacted]');
  return text.replace(/([?&#](?:token|access_token|refresh_token|auth|pairing_code|code|key)=)[^&#\s"'<>]+/gi,'$1[redacted]')
    .replace(/(Bearer\s+)[a-z\d._~+\/-]+=*/gi,'$1[redacted]')
    .replace(/((?:一次性配对码|pairing code)[\s:：]*)([\w-]{5,})/gi,'$1[redacted]');
}
function startStage({name,file,args,candidate,env,attemptDir,runtimeDir,secrets}){
  const log=name+'.log',rawLog=join(runtimeDir,log),trace=join(runtimeDir,name+'.calls.jsonl');
  const stage={log,calls:[],exitCode:null,stillRunning:false,terminatedAfterProbe:false};
  writeFileSync(trace,'',{mode:0o600,flag:'wx'});
  const owner=spawn(process.execPath,[runner],{cwd:runtimeDir,stdio:['ignore','ignore','ignore','ipc'],detached:true,env:{PATH:process.env.PATH}});
  let ended=false,outcome,closing=false;
  const closed=new Promise(resolve=>{owner.once('error',()=>{ended=true;resolve();});owner.once('exit',()=>{ended=true;resolve();});});
  const send=message=>{if(owner.connected)owner.send(message,()=>{});};
  owner.on('message',value=>{outcome=value;});
  send({type:'start',file,args,cwd:candidate,log:rawLog,env:{...env,NODE_OPTIONS:'--require='+JSON.stringify(guard),
    OPENNOVA_PROBE_CALLS:trace,OPENNOVA_PROBE_CONTAIN_CHILDREN:'1'}});
  function running(){
    requireProbe(!ended&&!outcome,'unexpected_'+name+'_exit');
    return true;
  }
  function runningOrHandedOff(){
    // The stage guardian must still be alive even when its launcher has exited.
    requireProbe(!ended&&(!outcome||(!outcome.error&&outcome.code===0&&!outcome.signal)),'unexpected_'+name+'_exit');
    return Boolean(outcome);
  }
  return {stage,running,runningOrHandedOff,rawLog,
    async exit(timeout,signal){
      const result=await waitFor(()=>{if(!outcome)running();return outcome;},timeout,name+'_exit_timeout',signal);
      requireProbe(!result.error,name+'_spawn_failed');
      return result;
    },
    async stop(signal){
      running();stage.stillRunning=true;
      send({type:'stop'});
      const result=await this.exit(10000,signal);
      stage.terminatedAfterProbe=true;stage.termination={exitCode:result.code,signal:result.signal};
    },
    async close(){
      if(!closing){closing=true;send({type:'close'});}
      if(!ended){
        const timer=setTimeout(()=>{
          if(!ended&&owner.pid)try{process.kill(-owner.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
        },4000);
        try{await closed;}finally{clearTimeout(timer);}
      }
      if(!stage.terminatedAfterProbe&&outcome&&!outcome.error)stage.exitCode=outcome.code;
      stage.calls=readFileSync(trace,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
      if(existsSync(rawLog))writeFileSync(join(attemptDir,log),redactProbeLog(readFileSync(rawLog,'utf8'),secrets),{mode:0o600,flag:'wx'});
    }};
}

function standby(voice){
  return voice?.connected===true&&voice.audioEnabled===false&&voice.phase==='standby'&&voice.capture==='off'&&
    voice.playback==='idle'&&voice.recognition==='idle'&&typeof voice.voiceInstanceId==='string'&&voice.voiceInstanceId.length>0;
}
function disconnected(voice){
  return voice?.connected===false&&voice.audioEnabled!==true&&
    (voice.capture==null||voice.capture==='off')&&(voice.playback==null||voice.playback==='idle')&&
    (voice.recognition==null||voice.recognition==='idle');
}
function safeDiagnostic(d){
  if(!d||typeof d.code!=='string'||!/^[a-z_][a-z_0-9]{0,80}$/.test(d.code))return;
  const info={code:d.code};
  if(['authorization','model_catalog','harness_start','conversation','context_maintenance','agent'].includes(d.stage))info.stage=d.stage;
  if(Number.isInteger(d.status)&&d.status>=400&&d.status<=599)info.status=d.status;
  return info;
}
async function webChat({url,signal,receipt,running,secrets}){
  const origin={'Origin':url,'Content-Type':'application/json','X-OpenNova-Web':'1'};
  const req=(path,options={})=>fetch(url+path,{...options,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});
  const page=await req('/'),webPageStatus=page.status;await page.body?.cancel();
  requireProbe(webPageStatus===200,'web_page_failed');
  const session=await req('/web/session',{method:'POST',headers:origin,body:'{}'});
  requireProbe(session.ok,'web_session_failed');
  const cookie=session.headers.get('set-cookie')?.split(';')[0],{csrf}=await session.json();
  requireProbe(cookie?.startsWith('opennova_web=')&&csrf,'web_session_invalid');
  secrets.add(cookie.slice('opennova_web='.length));secrets.add(csrf);
  const call=async(name,body)=>{
    const result=await req('/web/api/'+name,{method:'POST',headers:{...origin,Cookie:cookie,'X-OpenNova-CSRF':csrf},body:JSON.stringify(body)});
    requireProbe(result.ok,'web_'+name+'_failed');return result.json();
  };
  const snap=await call('snapshot',{}),project=snap.projects?.state;
  requireProbe(snap.health?.runtimeId===receipt.runtimeId&&snap.health?.workspace===receipt.healthWorkspace,'web_runtime_changed');
  const id=randomUUID(),expected='NOVA-'+randomBytes(8).toString('hex').toUpperCase();
  receipt.chat={id,expected,webPageStatus,status:'submitted'};
  await call('ask',{id,text:'请只回复以下校验码，不要包含任何其他字符：'+expected,
    ...(project?{expectedProject:{projectId:project.projectId??null,revision:project.revision}}:{})});
  const row=await waitFor(async()=>{
    await running();
    const response=await call('result',{id});
    requireProbe(response.id===id,'web_request_changed');
    receipt.chat.status=response.status;
    if(['failed','cancelled','interrupted'].includes(response.status)){
      if(/^[\w-]{1,100}$/.test(response.error??''))receipt.chat.error=response.error;
      receipt.chat.diagnostic=safeDiagnostic(response.diagnostic);
      throw Error('candidate_probe_chat_'+response.status);
    }
    return response.status==='completed'&&response;
  },150000,'chat_timeout',signal);
  if(row.text!==expected){
    const reply=typeof row.text==='string'?row.text:'';
    const mismatch={length:reply.length,sha256:createHash('sha256').update(reply).digest('hex'),containsExpected:reply.includes(expected)};
    if(/^route_[a-z_]{1,80}$/.test(row.routing?.reason??''))mismatch.routeReason=row.routing.reason;
    if(Array.isArray(row.routing?.diagnostics?.failures))mismatch.diagnostics=row.routing.diagnostics.failures.slice(0,3).map(safeDiagnostic).filter(Boolean);
    if(reply==='话题识别服务暂时不可用，当前项目保持不变，请稍后重试。')mismatch.knownReply='route_unavailable';
    receipt.chat.mismatch=mismatch;
    throw Error('candidate_probe_chat_echo_mismatch');
  }
  receipt.chat.text=row.text;
}

/** Update the receipt even on failure so the caller can retain a failed attempt. */
export async function probeTextStart({candidate,attemptDir,runtimeDir,env={},signal=new AbortController().signal,receipt}){
  candidate=realpathSync(candidate);attemptDir=realpathSync(attemptDir);runtimeDir=realpathSync(runtimeDir);
  const home=join(runtimeDir,'bot-home');mkdirSync(home,{mode:0o700});
  const token=randomBytes(32).toString('hex');writeFileSync(join(home,'client.token'),token,{mode:0o600,flag:'wx'});
  const secrets=new Set([token]);
  receipt.ports=await allocatePorts();receipt.bothPortsClosed=false;
  const [port,webPort]=receipt.ports,url='http://127.0.0.1:'+port;
  const childEnv={...env,PATH:env.PATH??process.env.PATH,OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(port),
    OPENNOVA_BOT_WEB_PORT:String(webPort),OPENNOVA_NODE:process.execPath,DSH_HOME:join(home,'harness')};
  for(const key of ['OPENNOVA_BOT_PLUGIN','OPENNOVA_HARNESS_ROOT','OPENNOVA_SIWC_ROOT','OPENNOVA_KEYCHAIN_HELPER'])delete childEnv[key];
  const stages=[],api=async(path,requestSignal=signal)=>{
    const res=await fetch(url+path,{redirect:'error',method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:'{}',signal:AbortSignal.any([requestSignal,AbortSignal.timeout(2500)])});
    requireProbe(res.ok,'api_'+res.status);return res.json();
  };
  function launch(name,file,args){
    const proc=startStage({name,file,args,candidate,attemptDir,runtimeDir,env:childEnv,secrets});
    stages.push(proc);receipt[name]=proc.stage;return proc;
  }
  async function health(){
    let h;try{h=await api('/health');}catch{signal.throwIfAborted();return;}
    if(!h?.ready)return;
    requireProbe(h.workspace===candidate&&typeof h.runtimeId==='string'&&h.runtimeId,'wrong_instance');
    if(receipt.runtimeId)requireProbe(h.runtimeId===receipt.runtimeId,'instance_changed');
    return h;
  }
  const entry=join(candidate,'start.command');
  try{
    signal.throwIfAborted();
    const cold=launch('coldStart',entry,['--no-voice','--no-ui']);
    const h=await waitFor(()=>{cold.runningOrHandedOff();return health();},60000,'health_timeout',signal);
    receipt.runtimeId=h.runtimeId;receipt.healthWorkspace=h.workspace;
    async function currentVoice(){
      const snapshot=await api('/snapshot');
      requireProbe(snapshot.health?.runtimeId===h.runtimeId&&snapshot.health?.workspace===candidate,'snapshot_instance_changed');
      return snapshot.desktop?.voice;
    }
    let standbyId;
    async function observeCold(){
      cold.runningOrHandedOff();
      const state=await currentVoice();
      if(standby(state)){
        cold.running();
        requireProbe(!standbyId||state.voiceInstanceId===standbyId,'cold_voice_instance_changed');
        standbyId=state.voiceInstanceId;
      }else requireProbe(!standbyId&&disconnected(state),'audio_not_off');
      return state;
    }
    // The same lock can protect a plain foreground text launcher or a standby client
    // still attaching. Observe the actual voice state during and after the text reply.
    const attachGrace=Date.now()+1500;
    await waitFor(async()=>{
      await observeCold();
      return standbyId||cold.runningOrHandedOff()||!existsSync(join(home,'voice-launch.lock'))||Date.now()>=attachGrace;
    },15000,'audio_not_off',signal);
    await webChat({url,signal,receipt,running:observeCold,secrets});
    const voice=await observeCold(),usesStandby=standby(voice);
    receipt.audioState=usesStandby?{connected:voice.connected,audioEnabled:voice.audioEnabled,phase:voice.phase,capture:voice.capture,
      playback:voice.playback,recognition:voice.recognition,voiceInstanceId:voice.voiceInstanceId}:{connected:voice.connected};
    if(usesStandby){
      receipt.launchMode='voice-standby';cold.stage.voiceInstanceId=voice.voiceInstanceId;
      await cold.stop(signal);requireProbe(await health(),'warm_host_lost');
    }else{
      requireProbe(await health(),'cold_text_host_lost');
      cold.stage.runtimeId=h.runtimeId;
    }
    const warm=launch('warmStart',entry,['--no-voice','--no-ui','--tts-provider','doubao']);
    const reuseLogged=()=>{
      if(!existsSync(warm.rawLog))return false;
      const lines=readFileSync(warm.rawLog,'utf8').split(/\r?\n/).map(line=>line.trim());
      return lines.includes('复用 Bot：'+url+'/')||lines.includes('Bot 已在运行：'+url+'；复用现有会话。');
    };
    if(usesStandby){
      const next=await waitFor(async()=>{
        warm.running();const state=await currentVoice();
        requireProbe(disconnected(state)||standby(state),'warm_audio_not_off');
        return standby(state)&&state.voiceInstanceId!==voice.voiceInstanceId&&reuseLogged()&&state;
      },20000,'warm_standby_missing',signal);
      Object.assign(warm.stage,{voiceInstanceId:next.voiceInstanceId,previousVoiceInstanceId:voice.voiceInstanceId,runtimeId:(await health())?.runtimeId});
      await warm.stop(signal);
    }else{
      const result=await warm.exit(20000,signal);
      Object.assign(warm.stage,{exitCode:result.code,signal:result.signal});
      requireProbe(result.code===0&&!result.signal,'warm_failed');
      requireProbe(disconnected(await currentVoice()),'warm_audio_not_off');
      Object.assign(warm.stage,{runtimeId:h.runtimeId,audioState:{connected:false}});
    }
    requireProbe(reuseLogged()&&await health(),'warm_identity_mismatch');
    // The guard exits the voice process with 72. The outer product launcher
    // may map that to exit 1; preserve both observations separately.
    const control=launch('oldDefault',entry,['--no-ui','--tts-provider','doubao']);
    control.stage.entry='start.command';
    const defaultResult=await control.exit(30000,signal);
    control.stage.exitCode=defaultResult.code;requireProbe([1,72].includes(defaultResult.code)&&!defaultResult.signal,'default_voice_missing');
    if(!usesStandby){
      if(cold.runningOrHandedOff()){
        requireProbe(await health()&&disconnected(await currentVoice()),'detached_host_lost');
        const result=await cold.exit(1000,signal);
        Object.assign(cold.stage,{exitCode:result.code,signal:result.signal});
        receipt.launchMode='detached-text';
      }else await cold.stop(signal);
    }
  }finally{
    // Only send shutdown to a host authenticated by this run's new token and
    // whose workspace/instance identity matches. Group teardown covers partial startups.
    const cleanupSignal=AbortSignal.timeout(5000);
    try{
      const h=await api('/health',cleanupSignal);
      if(h.workspace===candidate&&h.runtimeId&&(!receipt.runtimeId||h.runtimeId===receipt.runtimeId))await api('/shutdown',cleanupSignal);
    }catch{}
    await Promise.all(stages.map(stage=>stage.close()));
    receipt.bothPortsClosed=await waitFor(async()=>(await Promise.all(receipt.ports.map(listening))).every(open=>!open),5000,'ports_still_open').catch(()=>false);
  }
  requireProbe(receipt.bothPortsClosed,'ports_still_open');
  requireProbe(!receipt.coldStart.calls.length&&!receipt.warmStart.calls.length,'unexpected_audio_or_ssh');
  const calls=receipt.oldDefault.calls;
  requireProbe(calls.length===1&&calls[0].method==='spawn'&&calls[0].entry==='run-continuous.command'&&calls[0].injectedExitCode===72,'wrong_default_entry');
}
