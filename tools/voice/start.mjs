import {spawn} from 'node:child_process';
import {request} from 'node:http';
import {createConnection} from 'node:net';
import {readFileSync, writeFileSync, mkdirSync, openSync, closeSync, rmSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {botSettings, ROOT} from '../../services/bot/settings.mjs';

const HELP=`OpenNova 一键语音启动（自动使用共享 Bot）
用法：./start.command [选项]
  --device 名称          麦克风；省略使用系统默认输入
  --output-device 名称   播放设备；省略使用系统默认输出
  --list-devices         只列出设备，不启动 Bot、SSH 或 TTS
  --check                启动缺失服务并检查语音依赖，不开启麦克风
  --proxy URL            本次新启动 Bot 的云端代理；也可用 OPENNOVA_PROXY
  --studio-host 主机     SSH 别名，默认 agent-control
  --studio-tts-dir 路径  Studio 的 services/tts 绝对路径
  --tts-port 端口        Air 转发端口，默认 18000
  --tts-provider 后端   studio（默认）或 doubao；cloud 为 doubao 别名
  --tts-voice 音色      豆包 2.0 Speaker ID，默认 VV；Studio 仍为 Vivian
  -h, --help             显示帮助
退出语音：/quit 或 Ctrl+C。Bot 和 Studio TTS 保留；本次新建的 SSH 转发关闭。
豆包模式直连云端，不连接 Studio；启动含一次不播放的短句合成预检（少量计费用量）。
`;

function normalizeProvider(value) {
  if(value==='cloud')return 'doubao';
  if(!['studio','doubao'].includes(value))throw Error('TTS 后端必须为 studio 或 doubao（cloud 为别名）。');
  return value;
}

export function ttsProvider(options,env=process.env,root=ROOT) {
  if(options.ttsProvider||env.OPENNOVA_TTS_PROVIDER)return normalizeProvider(options.ttsProvider||env.OPENNOVA_TTS_PROVIDER);
  let path=env.OPENNOVA_CONFIG||join(root,'config/voice.local.json');
  if(path.startsWith('~/'))path=join(homedir(),path.slice(2));
  let config={};
  try {config=JSON.parse(readFileSync(path,'utf8'));}
  catch(error) {if(error.code!=='ENOENT')throw Error('无法读取 TTS 配置，请检查 config/voice.local.json / OPENNOVA_CONFIG。');}
  if(!config||typeof config!=='object')throw Error('TTS 配置必须是 JSON 对象。');
  return normalizeProvider(config.tts?.provider||'studio');
}

export function parseArgs(argv) {
  const options={studioHost:'agent-control',studioTtsDir:'/Users/nova/Documents/project/openNova/services/tts',ttsPort:18000};
  const values={'--device':'device','--output-device':'outputDevice','--proxy':'proxy',
    '--tts-provider':'ttsProvider','--tts-voice':'ttsVoice',
    '--studio-host':'studioHost','--studio-tts-dir':'studioTtsDir','--tts-port':'ttsPort'};
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(['--help','-h'].includes(arg))options.help=true;
    else if(arg==='--check')options.check=true;
    else if(arg==='--list-devices')options.listDevices=true;
    else if(values[arg]) {
      const value=argv[++i];
      if(!value||value.startsWith('-'))throw Error(`${arg} 需要有效参数。`);
      options[values[arg]]=value;
    }else throw Error(`不支持的参数 ${arg}；请使用 --help。一键入口已使用 Bot 模式，无需 --bot / --web。`);
  }
  options.ttsPort=Number(options.ttsPort);
  if(options.ttsProvider)options.ttsProvider=normalizeProvider(options.ttsProvider);
  if(!Number.isInteger(options.ttsPort)||options.ttsPort<1024||options.ttsPort>65535)throw Error('转发端口必须为 1024–65535。');
  if(!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(options.studioHost))throw Error('Studio SSH 主机参数无效。');
  if(!options.studioTtsDir.startsWith('/')||/[\r\n\0]/.test(options.studioTtsDir))throw Error('Studio TTS 目录需要绝对路径。');
  if(options.proxy) {
    const url=new URL(options.proxy);
    if(!['http:','https:'].includes(url.protocol))throw Error('代理需要 http:// 或 https:// 地址。');
  }
  return options;
}

// Explicit agent:false keeps local health traffic off Node's global proxy agent.
async function jsonRequest(url,{token,signal,timeout=2000}={}) {
  return new Promise((resolve,reject)=>{
    const req=request(url,{agent:false,signal,method:token?'POST':'GET',
      headers:token?{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}:{}},res=>{
      let data='';
      res.setEncoding('utf8');res.on('data',chunk=>{
        data+=chunk;if(data.length>2_000_000)req.destroy(Error('response_too_large'));
      });
      res.on('error',reject);
      res.on('end',()=>{
        try {if(res.statusCode!==200)throw Error('http_error');resolve(JSON.parse(data));}catch(e){reject(e);}
      });
    });
    const timer=setTimeout(()=>req.destroy(Error('health_timeout')),timeout);
    req.once('close',()=>clearTimeout(timer));req.on('error',reject);req.end(token?'{}':undefined);
  });
}

export async function probeTts(url,signal) {
  try {const schema=await jsonRequest(url+'/openapi.json',{signal});return !!schema.paths?.['/v1/audio/speech']?.post;}
  catch {signal?.throwIfAborted();return false;}
}

async function portOpen(port) {
  return new Promise(resolve=>{
    const socket=createConnection({host:'127.0.0.1',port});
    const finish=value=>{socket.destroy();resolve(value);};
    socket.setTimeout(800,()=>finish(false));socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));
  });
}

function acquireLock(path) {
  mkdirSync(resolve(path,'..'),{recursive:true,mode:0o700});
  try {mkdirSync(path,{mode:0o700});}
  catch(e) {
    if(e.code!=='EEXIST')throw e;
    let stale=false;
    try {
      const pid=Number(readFileSync(join(path,'pid'),'utf8'));
      if(Number.isInteger(pid)&&pid>1) {
        try {process.kill(pid,0);}catch(err){stale=err.code==='ESRCH';}
      }else stale=Date.now()-statSync(path).mtimeMs>120000;
    }catch {stale=Date.now()-statSync(path).mtimeMs>120000;}
    if(!stale)throw Error('已有一键启动或语音会话正在运行，请先在原终端 /quit。');
    rmSync(path,{recursive:true});mkdirSync(path,{mode:0o700});
  }
  writeFileSync(join(path,'pid'),String(process.pid),{mode:0o600});
  return ()=>rmSync(path,{recursive:true,force:true});
}

function spawnLogged(command,args,{env,cwd,logPath,input,detached=false}) {
  const fd=openSync(logPath,'a',0o600);
  let child;
  try {child=spawn(command,args,{env,cwd,detached,stdio:[input===undefined?'ignore':'pipe',fd,fd]});}
  finally {closeSync(fd);}
  child.on('error',error=>{child.spawnError=error;});
  if(input!==undefined){child.stdin.on('error',()=>{});child.stdin.end(input);}
  return child;
}

async function stop(child,{signal='SIGTERM',graceMs=3000,group=false}={}) {
  if(!child||child.exitCode!==null||child.signalCode!==null||child.spawnError)return;
  const exited=new Promise(resolve=>child.once('exit',resolve));
  const kill=sig=>{try {if(group)process.kill(-child.pid,sig);else child.kill(sig);}catch{}};
  kill(signal);
  const timer=setTimeout(()=>kill('SIGKILL'),graceMs);
  try {await exited;}finally{clearTimeout(timer);}
}

async function waitReady(probe,child,{signal,waitMs,pollMs},error) {
  const deadline=Date.now()+waitMs;
  do {
    signal?.throwIfAborted();
    if(await probe())return;
    if(child&&(child.spawnError||child.exitCode!==null||child.signalCode!==null))break;
    await delay(pollMs,undefined,{signal});
  }while(Date.now()<deadline);
  throw Error(error);
}

async function commandExit(child,{signal,timeout=120000}={}) {
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>{cleanup();reject(signal.reason);};
    const timer=timeout?setTimeout(()=>{cleanup();reject(Error('子进程超时，请检查启动日志。'));},timeout):null;
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    signal?.addEventListener('abort',abort,{once:true});
    child.once('error',()=>{cleanup();reject(Error('无法启动子进程，请检查依赖和启动日志。'));});
    child.once('exit',(code,sig)=>{cleanup();resolve(code??(sig==='SIGINT'?130:1));});
  });
}

export async function launch(options,{root=ROOT,env=process.env,waitMs=120000,pollMs=500,signal,log=console.log}={}) {
  const runEnv={...env};if(options.proxy)runEnv.OPENNOVA_PROXY=options.proxy;
  const voice=join(root,'tools/voice/run-continuous.command');
  if(options.listDevices) {
    const child=spawn(voice,['--list-devices'],{env:runEnv,cwd:root,stdio:'inherit'});
    try{return await commandExit(child,{signal});}finally{await stop(child);}
  }
  const provider=ttsProvider(options,runEnv,root);
  // Children and the launcher resolve the same CLI override over local settings.
  runEnv.OPENNOVA_TTS_PROVIDER=provider;
  if(options.ttsVoice)runEnv.OPENNOVA_DOUBAO_TTS_VOICE=options.ttsVoice;
  const b=botSettings(runEnv),ttsUrl=`http://127.0.0.1:${options.ttsPort}`;
  const release=acquireLock(join(b.home,'voice-launch.lock'));
  const logDir=join(root,'output/voice/launcher');
  mkdirSync(logDir,{recursive:true,mode:0o700});
  let bot,tunnel,remote,client,botReady=false;
  const timing={signal,waitMs,pollMs};
  const botHealth=async()=>{
    let data;
    try {data=await jsonRequest(b.url+'/health',{token:readFileSync(b.tokenPath,'utf8').trim(),signal});}
    catch {signal?.throwIfAborted();return false;}
    if(data.ready&&data.workspace!==root)throw Error('现有 Bot 使用了其他工程，请先检查 Bot 配置。');
    return data.ready===true;
  };
  try {
    log('[1/3] 检查 Bot 服务……');
    if(await botHealth()) {
      log(`复用 Bot：${b.url}/`);
      if(runEnv.OPENNOVA_PROXY)log('已有 Bot 沿用启动时的代理设置；如需更换，请先 tools/bot/run.command --stop 后重新启动。');
    }
    else {
      if(await portOpen(b.port)||await portOpen(b.webPort))throw Error('Bot 端口已占用但宿主未就绪；请检查现有进程，未自动终止。');
      log('正在后台启动 Bot，日志：output/voice/launcher/bot.log');
      bot=spawnLogged(join(root,'tools/bot/run.command'),[],{env:runEnv,cwd:root,logPath:join(logDir,'bot.log'),detached:true});
      await waitReady(botHealth,bot,timing,'Bot 启动失败或超时，请查看 output/voice/launcher/bot.log。');
      botReady=true;bot.unref();log(`Bot 已就绪：${b.url}/`);
    }
    if(provider==='doubao') {
      log('[2/3] 使用豆包云端 TTS，跳过 Studio / SSH；语音入口将验证云端权限。');
    } else {
    log('[2/3] 检查 Studio TTS 与连接……');
    if(await probeTts(ttsUrl,signal))log('复用现有 TTS 连接。');
    else {
      // A live but unhealthy tunnel may point at a stopped remote service. Allow it
      // only when lsof identifies an SSH listener; never replace unrelated listeners.
      const occupied=await portOpen(options.ttsPort);
      if(occupied) {
        const {execFileSync}=await import('node:child_process');
        let names='';
        try {names=execFileSync('/usr/sbin/lsof',['-nP',`-iTCP:${options.ttsPort}`,'-sTCP:LISTEN','-F','c'],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','ignore']});}catch{}
        if(!names.split('\n').includes('cssh'))throw Error(`TTS 端口 ${options.ttsPort} 已占用但不是可用 TTS；请检查占用程序。`);
      }
      // Own a foreground connection even when ~/.ssh/config enables multiplexing
      // or backgrounding; otherwise killing this child may leave its -L behind.
      const ssh=['-T','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','ConnectionAttempts=1',
        '-o','ControlMaster=no','-o','ControlPath=none','-o','ControlPersist=no',
        '-o','ForkAfterAuthentication=no','-o','StdinNull=no',
        '-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3'];
      const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
      log(`连接 Studio（${options.studioHost}），按需启动已安装的 TTS……`);
      remote=spawnLogged('ssh',[...ssh,options.studioHost,`sh -s -- ${quote(options.studioTtsDir)}`],
        {env:runEnv,cwd:root,logPath:join(logDir,'studio.log'),input:readFileSync(join(ROOT,'tools/voice/ensure-studio-tts.sh'))});
      if(await commandExit(remote,{signal,timeout:waitMs})!==0)throw Error('Studio SSH / TTS 启动失败；请确认主机在线、SSH 免密连接和已安装的 TTS，详见 output/voice/launcher/studio.log。');
      if(!occupied) {
        tunnel=spawnLogged('ssh',[...ssh,'-N','-o','ExitOnForwardFailure=yes','-L',
          `127.0.0.1:${options.ttsPort}:127.0.0.1:8000`,options.studioHost],
          {env:runEnv,cwd:root,logPath:join(logDir,'tunnel.log')});
      }
      await waitReady(()=>probeTts(ttsUrl,signal),tunnel,timing,
        'TTS 转发未就绪，请检查 output/voice/launcher/tunnel.log；现有转发若失效，请在原终端关闭后重试。');
      log('Studio TTS 连接已就绪。');
    }
    }
    log(options.check?'[3/3] 检查语音依赖，不打开麦克风……':'[3/3] 启动语音对话；/quit 或 Ctrl+C 退出。');
    const args=['--bot'];
    if(provider==='studio')args.push('--tts-url',ttsUrl);
    else args.push('--tts-provider','doubao');
    if(options.ttsVoice)args.push('--tts-voice',options.ttsVoice);
    if(options.device)args.push('--device',options.device);
    if(options.outputDevice)args.push('--output-device',options.outputDevice);
    if(options.check)args.push('--check');
    // Isolate terminal signals, forwarding one SIGINT so Python can run its
    // async microphone/playback cleanup instead of receiving duplicate interrupts.
    client=spawn(voice,args,{env:runEnv,cwd:root,stdio:'inherit',detached:true});
    return await commandExit(client,{signal,timeout:0});
  }finally {
    await stop(client,{signal:'SIGINT',graceMs:20000,group:true});await stop(remote);await stop(tunnel);
    if(bot&&!botReady)await stop(bot,{group:true});
    release();
  }
}

async function main() {
  process.umask(0o077);
  const options=parseArgs(process.argv.slice(2));
  if(options.help){console.log(HELP);return;}
  const controller=new AbortController();
  const interrupt=()=>controller.abort(Error('启动或对话已取消。'));
  process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
  try {process.exitCode=await launch(options,{signal:controller.signal});}
  catch(error) {
    console.error(controller.signal.aborted?'OpenNova 已停止。':`启动失败：${error.message}`);
    process.exitCode=controller.signal.aborted?130:1;
  }finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}
}
if(process.argv[1]===import.meta.filename)main().catch(error=>{console.error('启动失败：'+error.message);process.exitCode=1;});
