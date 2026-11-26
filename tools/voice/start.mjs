import {prepareDesktop} from '../desktop/start.mjs';
import {voiceStandby} from './standby.mjs';
import {spawn} from 'node:child_process';
import {request} from 'node:http';
import {createConnection} from 'node:net';
import {readFileSync, writeFileSync, mkdirSync, openSync, closeSync, rmSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {botSettings, ROOT} from '../../services/bot/settings.mjs';
import {loadResearchConfig,RESEARCH_VERSION} from '../../services/bot/research/config.mjs';
import {runtimePaths} from '../../services/runtime/paths.mjs';

export function researchStartupNotice(health,desired={}){
 const r=health?.research;
 if(!r||r.version!==RESEARCH_VERSION||desired.enabled&&!r.enabled||desired.mode&&r.mode!==desired.mode)return '后台检索版本或模式尚未更新；请在结束当前语音后停止并重启 Bot。普通对话与工程功能仍可用。';
 if(r.available)return `后台检索：DeepSeek 已接入（${r.mode==='legacy'?'旧版回退模式':'DSH 原生联网'}）；实际查询时验证网络与账号权限。`;
 if(!r.enabled)return '后台检索未开启；可在 web.enabled 配置中启用，普通功能可用。';
 const reason={deepseek_api_key_missing:'缺少 DeepSeek 搜索密钥',research_provider_unsupported:'当前 Bot 的搜索后端需要设为 deepseek',invalid_research_configuration:'检索配置无效'}[r.reason]||'当前不可用';
 return `后台检索：${reason}；普通对话与工程功能仍可用。`;
}

const HELP=`OpenNova 一键语音启动（自动使用共享 Bot）
用法：./start.command [选项]
  --ui                  自动打开 Nova 对话窗口（默认，工作窗口按需打开）
  --no-ui               不自动开窗，保留终端控制
  --no-voice            仅文字启动；点击开启语音或输入 /start 后连接音频
  --voice               启动时开启语音（默认）；失败时保留文字与重试入口
  --device 名称          麦克风；省略使用已保存选择，首次使用系统默认输入
  --output-device 名称   播放设备；省略使用已保存选择，首次使用系统默认输出
  --mic-muted           启动时关闭麦克风，仍可播放回复和任务汇报
  --list-devices         只列出设备，不启动 Bot、SSH 或 TTS
  --check                启动缺失服务并检查语音依赖，不打开窗口或麦克风
  --proxy URL            本次新启动 Bot 的云端代理；也可用 OPENNOVA_PROXY
  --studio-host 主机     SSH 别名，默认 agent-control
  --studio-tts-dir 路径  Studio 的 services/tts 绝对路径
  --tts-port 端口        Air 转发端口，默认 18000
  --tts-provider 后端   studio（默认）或 doubao；cloud 为 doubao 别名
  --tts-voice 音色      豆包 2.0 Speaker ID，默认 VV；Studio 仍为 Vivian
  -h, --help             显示帮助
关闭语音：网页“关闭语音”或 /disable，释放设备并保留开启入口。
更换设备：网页“音频设备”可分别选择麦克风和外放，保存后应用并重连。
退出启动器：/quit 或 Ctrl+C。Bot 和 Studio TTS 保留；本次新建的 SSH 转发关闭。
豆包模式直连云端，不连接 Studio；启动含一次不播放的短句合成预检（少量计费用量）。
`;

function normalizeProvider(value) {
  if(value==='cloud')return 'doubao';
  if(!['studio','doubao'].includes(value))throw Error('TTS 后端必须为 studio 或 doubao（cloud 为别名）。');
  return value;
}

function ttsConfig(env,root) {
  let path=env.OPENNOVA_CONFIG||join(root,'config/voice.local.json');
  if(path.startsWith('~/'))path=join(homedir(),path.slice(2));
  let config={};
  try {config=JSON.parse(readFileSync(path,'utf8'));}
  catch(error) {if(error.code!=='ENOENT')throw Error('无法读取 TTS 配置，请检查 config/voice.local.json / OPENNOVA_CONFIG。');}
  if(!config||typeof config!=='object')throw Error('TTS 配置必须是 JSON 对象。');
  return config.tts??{};
}

export function ttsProvider(options,env=process.env,root=ROOT) {
  return normalizeProvider(options.ttsProvider||env.OPENNOVA_TTS_PROVIDER||ttsConfig(env,root).provider||'studio');
}

export function studioSettings(options,env=process.env,root=ROOT) {
  const config=ttsConfig(env,root);
  const studioHost=options.studioHost||env.OPENNOVA_STUDIO_HOST||config.studio_host||'agent-control';
  const studioTtsDir=options.studioTtsDir||env.OPENNOVA_STUDIO_TTS_DIR||config.studio_tts_dir||'';
  if(typeof studioHost!=='string'||!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(studioHost))throw Error('Studio SSH 主机参数无效。');
  if(typeof studioTtsDir!=='string'||(studioTtsDir&&(!studioTtsDir.startsWith('/')||/[\r\n\0]/.test(studioTtsDir))))throw Error('Studio TTS 目录需要绝对路径。');
  return {studioHost,studioTtsDir};
}

export function parseArgs(argv) {
  const options={ttsPort:18000};
  const values={'--device':'device','--output-device':'outputDevice','--proxy':'proxy',
    '--tts-provider':'ttsProvider','--tts-voice':'ttsVoice',
    '--studio-host':'studioHost','--studio-tts-dir':'studioTtsDir','--tts-port':'ttsPort'};
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(['--help','-h'].includes(arg))options.help=true;
    else if(arg==='--ui')options.ui=true;
    else if(arg==='--no-ui')options.ui=false;
    else if(arg==='--no-voice')options.voice=false;
    else if(arg==='--voice')options.voice=true;
    else if(arg==='--check')options.check=true;
    else if(arg==='--mic-muted')options.micMuted=true;
    else if(arg==='--list-devices')options.listDevices=true;
    else if(values[arg]) {
      const value=argv[++i];
      if(!value||value.startsWith('-'))throw Error(`${arg} 需要有效参数。`);
      options[values[arg]]=value;
    }else throw Error(`不支持的参数 ${arg}；请使用 --help。一键入口已使用 Bot 模式，无需 --bot / --web。`);
  }
  options.ui=options.help||options.listDevices||options.check?false:options.ui??true;
  options.voice??=true;
  if(options.check&&options.voice===false)throw Error('--check 检查语音依赖，不能与 --no-voice 同时使用。');
  options.ttsPort=Number(options.ttsPort);
  if(options.ttsProvider)options.ttsProvider=normalizeProvider(options.ttsProvider);
  if(!Number.isInteger(options.ttsPort)||options.ttsPort<1024||options.ttsPort>65535)throw Error('转发端口必须为 1024–65535。');
  if(options.studioHost&&!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(options.studioHost))throw Error('Studio SSH 主机参数无效。');
  if(options.studioTtsDir&&(!options.studioTtsDir.startsWith('/')||/[\r\n\0]/.test(options.studioTtsDir)))throw Error('Studio TTS 目录需要绝对路径。');
  if(options.proxy) {
    const url=new URL(options.proxy);
    if(!['http:','https:'].includes(url.protocol))throw Error('代理需要 http:// 或 https:// 地址。');
  }
  return options;
}

// Explicit agent:false keeps local health traffic off Node's global proxy agent.
async function jsonRequest(url,{token,signal,timeout=2000,body={}}={}) {
  return new Promise((resolve,reject)=>{
    const req=request(url,{agent:false,signal,method:token?'POST':'GET',
      headers:token?{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}:{}},res=>{
      let data='';
      res.setEncoding('utf8');res.on('data',chunk=>{
        data+=chunk;if(data.length>2_000_000)req.destroy(Error('response_too_large'));
      });
      res.on('error',reject);
      res.on('end',()=>{
        try {const value=JSON.parse(data);if(res.statusCode!==200)throw Object.assign(Error(value.error||'http_error'),{status:res.statusCode});resolve(value);}catch(e){reject(e);}
      });
    });
    const timer=setTimeout(()=>req.destroy(Error('health_timeout')),timeout);
    req.once('close',()=>clearTimeout(timer));req.on('error',reject);req.end(token?JSON.stringify(body):undefined);
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
    if(!stale)throw Object.assign(Error('已有一键启动或语音会话正在运行，请先在原终端 /quit。'),{code:'launch_busy'});
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

export async function launch(options,{root=ROOT,env=process.env,waitMs=120000,pollMs=500,signal,log=console.log,openBrowser,uiWaitMs=8000,input=process.stdin,onBotStarted=()=>{}}={}) {
  const runEnv={...env};if(options.proxy)runEnv.OPENNOVA_PROXY=options.proxy;
  const voice=join(root,'tools/voice/run-continuous.command');
  if(options.listDevices) {
    const child=spawn(voice,['--list-devices'],{env:runEnv,cwd:root,stdio:'inherit'});
    try{return await commandExit(child,{signal});}finally{await stop(child);}
  }
  const b=botSettings(runEnv),ttsUrl=`http://127.0.0.1:${options.ttsPort}`;
  let release,existingLaunch=false;
  try{release=acquireLock(join(b.home,'voice-launch.lock'));}
  catch(error){if(error.code!=='launch_busy'||!options.ui||options.check)throw error;existingLaunch=true;}
  const paths=runtimePaths(runEnv,root);
  const logDir=paths.packaged?join(paths.logsRoot,'voice'):join(root,'output/voice/launcher');
  mkdirSync(logDir,{recursive:true,mode:0o700});
  let bot,tunnel,remote,client,standby,handoff,botReady=false,health;
  const call=(path,body,{cleanup=false}={})=>jsonRequest(b.url+path,{body,token:readFileSync(b.tokenPath,'utf8').trim(),signal:cleanup?undefined:signal});
  let deviceRevision=null,selectedDevices={input:options.device??null,output:options.outputDevice??null},settingsSupported=true;
  const refreshDevices=async()=>{
    if(settingsSupported){
      let settings;
      try{settings=await call('/voice-device-settings',{});}
      catch(error){if(error.status!==404)throw error;settingsSupported=false;}
      if(settingsSupported){
        const selection=settings?.selection,valid=value=>value===null||(typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\r\n\0]/.test(value));
        if(!Number.isSafeInteger(settings?.revision)||settings.revision<0||!selection||!valid(selection.input)||!valid(selection.output))throw Error('音频设备设置无效，请检查 Bot 服务。');
        if(deviceRevision!==null&&settings.revision<deviceRevision)throw Error('音频设备设置版本已回退，请重新启动语音。');
        if(deviceRevision===null){
          selectedDevices={input:options.device??selection.input,output:options.outputDevice??selection.output};
        }else if(settings.revision!==deviceRevision){
          // A later UI choice supersedes both initial CLI overrides, including
          // an explicit return to system defaults. Closing/reopening keeps it.
          selectedDevices={...selection};
        }
        deviceRevision=settings.revision;
      }
    }
    return {devices:{...selectedDevices,switching:false},...(deviceRevision===null?{}:{deviceRevision})};
  };
  const timing={signal,waitMs,pollMs};
  const botHealth=async()=>{
    let data;
    try {data=await jsonRequest(b.url+'/health',{token:readFileSync(b.tokenPath,'utf8').trim(),signal});}
    catch {signal?.throwIfAborted();return false;}
    if(data.ready&&data.workspace!==b.workspace)throw Error('现有 Bot 使用了其他工程，请先检查 Bot 配置。');
    health=data;return data.ready===true;
  };
  try {
    log('检查 Bot 服务……');
    if(existingLaunch)await waitReady(botHealth,null,timing,'已有启动正在进行，但 Bot 尚未就绪；请查看原终端。');
    if(await botHealth()) {
      log(`复用 Bot：${b.url}/。运行中的 Bot 在下次启动时加载服务端代码更新。`);
      if(runEnv.OPENNOVA_PROXY)log('已有 Bot 沿用启动时的代理设置；如需更换，请先 tools/bot/run.command --stop 后重新启动。');
    }
    else {
      if(await portOpen(b.port)||await portOpen(b.webPort))throw Error('Bot 端口已占用但宿主未就绪；请检查现有进程，未自动终止。');
      log(`正在后台启动 Bot，日志：${join(logDir,'bot.log')}`);
      bot=spawnLogged(join(root,'tools/bot/run.command'),['--no-ui'],{env:runEnv,cwd:root,logPath:join(logDir,'bot.log'),detached:true});
      await waitReady(botHealth,bot,timing,`Bot 启动失败或超时，请查看 ${join(logDir,'bot.log')}。`);
      botReady=true;onBotStarted({child:bot,health,settings:b});bot.unref();log(`Bot 已就绪：${b.url}/`);
    }
    log(researchStartupNotice(health,loadResearchConfig({env:runEnv,configFile:paths.configFile,secretsFile:paths.secretsFile})));
    if(options.ui&&!options.check)await prepareDesktop({config:b,root,health,signal,log,env:runEnv,openBrowser,waitMs:uiWaitMs});
    if(!options.check){
      const snapshot=await jsonRequest(b.url+'/snapshot',{token:readFileSync(b.tokenPath,'utf8').trim(),signal});
      if(existingLaunch||snapshot.desktop?.voice?.connected){
        log('已有语音会话，复用当前会话；可在窗口“音频设备”更换麦克风和外放。更换 TTS 配置时请先在原终端 /quit。');
        return 0;
      }
    }
    const attempt=async()=>{
      await refreshDevices();
      if(deviceRevision!==null)runEnv.OPENNOVA_VOICE_DEVICE_REVISION=String(deviceRevision);
      const provider=ttsProvider(options,runEnv,root);
      const studio=provider==='studio'?studioSettings(options,runEnv,root):null;
      runEnv.OPENNOVA_TTS_PROVIDER=provider;
      if(options.ttsVoice)runEnv.OPENNOVA_DOUBAO_TTS_VOICE=options.ttsVoice;
      try {
        if(provider==='doubao') {
          log('使用豆包云端 TTS，跳过 Studio / SSH；语音入口将验证云端权限。');
        } else {
        log('检查 Studio TTS 与连接……');
        if(await probeTts(ttsUrl,signal))log('复用现有 TTS 连接。');
        else {
          if(!studio.studioTtsDir)throw Error('请通过 tts.studio_tts_dir、OPENNOVA_STUDIO_TTS_DIR 或 --studio-tts-dir 指定 Studio 上部署的 services/tts 绝对路径。');
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
          log(`连接 Studio（${studio.studioHost}），按需启动已安装的 TTS……`);
          remote=spawnLogged('ssh',[...ssh,studio.studioHost,`sh -s -- ${quote(studio.studioTtsDir)}`],
            {env:runEnv,cwd:root,logPath:join(logDir,'studio.log'),input:readFileSync(join(ROOT,'tools/voice/ensure-studio-tts.sh'))});
          if(await commandExit(remote,{signal,timeout:waitMs})!==0)throw Error(`Studio SSH / TTS 启动失败；请确认主机在线、SSH 免密连接和已安装的 TTS，详见 ${join(logDir,'studio.log')}。`);
          if(!occupied) {
            tunnel=spawnLogged('ssh',[...ssh,'-N','-o','ExitOnForwardFailure=yes','-L',
              `127.0.0.1:${options.ttsPort}:127.0.0.1:8000`,studio.studioHost],
              {env:runEnv,cwd:root,logPath:join(logDir,'tunnel.log')});
          }
          await waitReady(()=>probeTts(ttsUrl,signal),tunnel,timing,
            `TTS 转发未就绪，请检查 ${join(logDir,'tunnel.log')}；现有转发若失效，请在原终端关闭后重试。`);
          log('Studio TTS 连接已就绪。');
        }
        }
        log(options.check?'检查语音依赖，不打开麦克风……':'启动语音对话；/quit 或 Ctrl+C 退出。');
        const args=['--bot'];
        if(provider==='studio')args.push('--tts-url',ttsUrl);
        else args.push('--tts-provider','doubao');
        if(options.ttsVoice)args.push('--tts-voice',options.ttsVoice);
        if(selectedDevices.input)args.push('--device',selectedDevices.input);
        if(selectedDevices.output)args.push('--output-device',selectedDevices.output);
        if(options.micMuted)args.push('--mic-muted');
        if(options.check)args.push('--check');
        // Isolate terminal signals, forwarding one SIGINT so Python can run its
        // async microphone/playback cleanup instead of receiving duplicate interrupts.
        handoff=standby;await standby?.close({handoff:true});standby=null;
        client=spawn(voice,args,{env:runEnv,cwd:root,stdio:'inherit',detached:true});
        const code=await commandExit(client,{signal,timeout:0});
        return code;
      }finally{
        await stop(client,{signal:'SIGINT',graceMs:20000,group:true});client=null;
        await handoff?.finish();handoff=null;
        await stop(remote);remote=null;await stop(tunnel);tunnel=null;
      }
    };
    if(options.check)return await attempt();
    let waiting=options.voice===false,problem=null;
    while(true){
      signal?.throwIfAborted();
      standby=await voiceStandby({call,signal,input,phase:waiting?'standby':'starting',problem,getDevices:refreshDevices});
      if(waiting){
        log(`文字对话已就绪：${b.url}/。语音未开启，点击“开启语音”或输入 /start；/quit 退出。`);
        if(!await standby.wait())return 0;
        await standby.starting();
      }
      try {
        const code=await attempt();
        signal?.throwIfAborted();
        if(code===0||code===130)return code;
        problem=code===20?null:'语音未能启动或已断开，请查看具体错误，处理后重新开启语音。';
      }catch(error){
        signal?.throwIfAborted();
        problem=String(error.message).slice(0,1000);
        log('语音暂不可用：'+problem);
      }finally{await standby?.close();standby=null;}
      if(problem)log(`语音未就绪，文字对话仍可使用：${b.url}/。请处理上述错误后重新开启语音。`);
      waiting=true;
    }
  }catch(error){
    if(health?.ready&&options.ui&&!options.check&&!signal?.aborted)log(`语音启动未完成，文字对话仍可使用：${b.url}/。Studio 不在线时可改用 --tts-provider doubao。`);
    throw error;
  }finally {
    await standby?.close();
    await stop(client,{signal:'SIGINT',graceMs:20000,group:true});await stop(remote);await stop(tunnel);
    if(bot&&!botReady)await stop(bot,{group:true});
    release?.();
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
