// Minimal loopback host for exercising probe orchestration and error cleanup.
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {browserHandler} from '../../../services/bot/web-http.mjs';

const home=process.env.OPENNOVA_BOT_HOME,port=Number(process.env.OPENNOVA_BOT_PORT),webPort=Number(process.env.OPENNOVA_BOT_WEB_PORT);
const workspace=process.cwd(),lock=join(home,'voice-launch.lock'),leasePath=join(home,'lease.json');
const pendingLease=join(home,'pending-lease.json');
const url='http://127.0.0.1:'+port,token=readFileSync(join(home,'client.token'),'utf8');
const healthToken=()=>fetch(url+'/health',{method:'POST',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(1000)}).then(r=>r.ok).catch(()=>false);
if(!process.argv.includes('serve')&&!process.argv.includes('--no-voice')&&!process.env.PROBE_TEST_ALWAYS_TEXT){
  spawn(join(workspace,'tools/voice/run-continuous.command'),[]);
}else if(process.argv.includes('serve')||process.env.PROBE_TEST_MODE==='foreground'&&!await healthToken()){
  if(process.env.PROBE_TEST_FOREGROUND_LOCK)mkdirSync(lock);
  const runtimeId=randomUUID(),requests=new Map();
  const health=()=>({ready:true,runtimeId:process.env.PROBE_TEST_SWITCH_RUNTIME&&existsSync(join(home,'warm'))?'other':runtimeId,workspace});
  const snapshot=()=>({health:health(),desktop:{voice:existsSync(leasePath)?JSON.parse(readFileSync(leasePath,'utf8')):{connected:false}}});
  const web=browserHandler({assets:workspace},async(path,body)=>{
    if(path==='/snapshot')return snapshot();
    if(path==='/ask'){
      const expected=/NOVA-[0-9A-F]{16}/.exec(body.text)[0];
      if(process.env.PROBE_TEST_STALL)writeFileSync(process.env.PROBE_TEST_STALL,JSON.stringify([port,webPort]));
      requests.set(body.id,{id:body.id,status:process.env.PROBE_TEST_STALL?'running':'completed',text:process.env.PROBE_TEST_BAD_REPLY?'wrong':expected});return {id:body.id};
    }
    if(path==='/result'){
      if(existsSync(pendingLease))writeFileSync(leasePath,readFileSync(pendingLease));
      if(process.env.PROBE_TEST_AUDIO_AFTER_REPLY)writeFileSync(leasePath,process.env.PROBE_TEST_AUDIO_AFTER_REPLY);
      return requests.get(body.id);
    }
    throw Error('unsupported');
  });
  const server=http.createServer(async(req,res)=>{
    if(await web(req,res))return;
    if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end();return;}
    res.setHeader('Content-Type','application/json');
    if(req.url==='/shutdown'){res.end('{}');setTimeout(()=>process.exit(0),25);return;}
    res.end(JSON.stringify(req.url==='/health'?health():snapshot()));
  });
  server.listen(port,'127.0.0.1');
  http.createServer().listen(webPort,'127.0.0.1');
}else if(process.env.PROBE_TEST_MODE==='detached'){
  if(await healthToken()){
    writeFileSync(join(home,'warm'),'');
    if(process.env.PROBE_TEST_WARM_AUDIO)writeFileSync(leasePath,JSON.stringify({connected:true,audioEnabled:true,capture:'listening'}));
    if(!process.env.PROBE_TEST_SILENT_REUSE)console.log('复用 Bot：'+url+'/');
  }else{
    if(process.env.PROBE_TEST_STALE_LOCK)mkdirSync(lock);
    if(!process.env.PROBE_TEST_NO_SERVER){
      const host=spawn(process.execPath,[import.meta.filename,'serve'],{detached:true,stdio:'ignore'});host.unref();
    }
    if(process.env.PROBE_TEST_COLD_FAILURE)process.exitCode=1;
  }
}else if(process.env.PROBE_TEST_MODE==='foreground'){
  console.log('Bot 已在运行：'+url+'；复用现有会话。');
}else{
  mkdirSync(lock);
  const lease={connected:true,audioEnabled:false,voiceInstanceId:randomUUID(),phase:'standby',recognition:'idle',capture:'off',playback:'idle'};
  const reuse=await healthToken();
  if(process.env.PROBE_TEST_LATE_STANDBY&&!reuse)writeFileSync(pendingLease,JSON.stringify(lease));
  else writeFileSync(leasePath,JSON.stringify(lease));
  if(!reuse){
    const host=spawn(process.execPath,[import.meta.filename,'serve'],{detached:true,stdio:'ignore'});host.unref();
  }else console.log('复用 Bot：'+url+'/');
  process.on('SIGTERM',()=>{rmSync(lock,{recursive:true});rmSync(leasePath);process.exit(0);});
  setInterval(()=>{},1000);
}
