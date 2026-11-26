/** Internal macOS application controller. stdout is a JSON-lines protocol for Launcher.swift. */
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {request} from 'node:http';
import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync,rmSync,appendFileSync,chmodSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {writableRuntimePath} from '../../services/runtime/paths.mjs';

const HERE=dirname(fileURLToPath(import.meta.url));
export function runtimeLayout(root=resolve(HERE,'../..'),env=process.env,home=homedir()){
  const runtime=resolve(root,'../runtime');
  const data=resolve(env.OPENNOVA_APP_DATA||join(home,'Library/Application Support/OpenNova'));
  const config=join(data,'config'),bin=join(runtime,'bin');
  const port=Number(env.OPENNOVA_BOT_PORT||19560),webPort=Number(env.OPENNOVA_BOT_WEB_PORT||19561);
  if(![port,webPort].every(n=>Number.isInteger(n)&&n>1024&&n<65536)||port===webPort)throw Error('应用端口配置无效。');
  return {root,runtime,data,config,bin,port,webPort,logs:join(data,'logs'),workspace:resolve(env.OPENNOVA_WORKSPACE||join(data,'Workspace')),
    botHome:resolve(env.OPENNOVA_BOT_HOME||join(data,'bot')),settings:join(config,'voice.local.json'),secrets:join(config,'secrets.local.json'),
    node:join(bin,'node'),python:join(runtime,'python/bin/python3.11'),url:`http://127.0.0.1:${port}`};
}
const readJSON=(path,fallback={})=>{try{return JSON.parse(readFileSync(path,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw Error('配置文件无法读取，请查看配置目录。');}};
function atomicJSON(path,value){
  const tmp=path+'.'+randomUUID()+'.tmp';
  try{writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(tmp,path);chmodSync(path,0o600);}
  finally{rmSync(tmp,{force:true});}
}
export function validateWritableLayout(layout){
  // Validate every destination before the first write, including existing symlinks.
  for(const path of [layout.data,layout.config,layout.logs,layout.botHome,layout.workspace,layout.settings,layout.secrets,
    join(layout.data,'auth'),join(layout.data,'application.lock'),join(layout.logs,'application.log')]){
    try{writableRuntimePath(path,{OPENNOVA_PACKAGED:'1'},layout.root);}
    catch(error){if(error.message==='packaged_state_must_be_outside_application')throw Error('用户数据、配置和工作目录必须位于 OpenNova.app 之外，请检查 OPENNOVA_APP_DATA / OPENNOVA_WORKSPACE / OPENNOVA_BOT_HOME。');throw error;}
  }
}
export function ensureConfiguration(layout){
  validateWritableLayout(layout);
  for(const path of [layout.data,layout.config,layout.logs,layout.botHome,layout.workspace,join(layout.data,'auth')])mkdirSync(path,{recursive:true,mode:0o700});
  if(!existsSync(layout.settings))atomicJSON(layout.settings,{agent:{},web:{enabled:false,provider:'deepseek'},tts:{provider:'doubao',doubao_voice:'zh_female_vv_uranus_bigtts'},desktop:{},app:{proxy:''}});
  if(!existsSync(layout.secrets))atomicJSON(layout.secrets,{doubao:{api_key:'',tts_api_key:''}});
}
export function saveSettings(layout,input){
  validateWritableLayout(layout);
  if(!input||typeof input!=='object')throw Error('设置内容无效。');
  const proxy=typeof input.proxy==='string'?input.proxy.trim():'';
  if(proxy){let url;try{url=new URL(proxy);}catch{throw Error('代理地址需要以 http:// 或 https:// 开头。');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('代理需要 HTTP/HTTPS 地址，且不包含用户名或密码。');}
  for(const key of ['asrKey','ttsKey'])if(input[key]!==undefined&&(typeof input[key]!=='string'||input[key].length>8192||/[\r\n\0]/.test(input[key])))throw Error('语音密钥格式无效。');
  const config=readJSON(layout.settings),secrets=readJSON(layout.secrets);
  config.app={...config.app,proxy};config.tts={provider:'doubao',...config.tts};
  secrets.doubao={...secrets.doubao};
  if(input.asrKey?.trim())secrets.doubao.api_key=input.asrKey.trim();
  if(input.ttsKey?.trim())secrets.doubao.tts_api_key=input.ttsKey.trim();
  atomicJSON(layout.secrets,secrets);atomicJSON(layout.settings,config);
  return settingsSummary(layout);
}
export function settingsSummary(layout){
  const config=readJSON(layout.settings),secrets=readJSON(layout.secrets);
  return {proxy:config.app?.proxy||'',hasAsrKey:!!secrets.doubao?.api_key,hasTtsKey:!!secrets.doubao?.tts_api_key};
}
export function appEnvironment(layout,source=process.env){
  const settings=readJSON(layout.settings);
  const configuredProvider=settings.tts?.provider||'doubao';
  const provider=configuredProvider==='cloud'?'doubao':configuredProvider;
  if(!['studio','doubao'].includes(provider))throw Error('TTS 后端必须为 studio 或 doubao（cloud 为 doubao 别名）。');
  const env={...source};
  // A Finder launch must not inherit developer-side account, model, or proxy credentials.
  for(const key of Object.keys(env))if(/^(OPENNOVA_|DSH_|NODE_OPTIONS$|PYTHONHOME$|PYTHONPATH$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|http_proxy$|https_proxy$|all_proxy$|DOUBAO_)/.test(key)||/(KEY|TOKEN|SECRET|PASSWORD)/.test(key))delete env[key];
  Object.assign(env,{OPENNOVA_PACKAGED:'1',OPENNOVA_APP_DATA:layout.data,OPENNOVA_CONFIG:layout.settings,
    OPENNOVA_SECRETS_FILE:layout.secrets,OPENNOVA_SECRETS:layout.secrets,OPENNOVA_BOT_HOME:layout.botHome,
    OPENNOVA_ARK_KEY_FILE:join(layout.config,'ark.key'),OPENNOVA_IMAGE_ARK_KEY_FILE:join(layout.config,'ark.key'),OPENNOVA_GITHUB_TOKEN_FILE:join(layout.config,'github.token'),
    OPENNOVA_BOT_PORT:String(layout.port),OPENNOVA_BOT_WEB_PORT:String(layout.webPort),OPENNOVA_WORKSPACE:layout.workspace,
    OPENNOVA_SIWC_STORAGE:join(layout.data,'auth'),OPENNOVA_NODE:layout.node,OPENNOVA_PYTHON:layout.python,
    OPENNOVA_IMAGE_PYTHON:layout.python,OPENNOVA_BIN_DIR:layout.bin,OPENNOVA_VAD_MODEL:join(layout.runtime,'models/silero_vad.onnx'),
    OPENNOVA_TTS_PROVIDER:provider,PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1',
    GIT_EXEC_PATH:join(layout.runtime,'libexec/git-core'),FONTCONFIG_FILE:join(layout.runtime,'share/fonts.conf'),
    PATH:[layout.bin,join(layout.runtime,'python/bin'),'/usr/bin','/bin','/usr/sbin','/sbin'].join(':'),NO_PROXY:'localhost,127.0.0.1'});
  const certificate=join(layout.runtime,'python/lib/python3.11/site-packages/certifi/cacert.pem');
  if(existsSync(certificate))env.SSL_CERT_FILE=certificate;
  const proxy=settings.app?.proxy;
  if(proxy){env.OPENNOVA_PROXY=proxy;env.HTTPS_PROXY=proxy;env.HTTP_PROXY=proxy;env.NODE_USE_ENV_PROXY='1';}
  return env;
}
function query(layout,path,body={}){
  return new Promise((done,reject)=>{
    let token;try{token=readFileSync(join(layout.botHome,'client.token'),'utf8').trim();}catch(error){reject(error);return;}
    const req=request(layout.url+path,{agent:false,method:'POST',timeout:2500,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;if(text.length>2000000)req.destroy(Error('响应过大。'));});
      res.on('error',reject);res.on('end',()=>{try{const value=JSON.parse(text);if(res.statusCode!==200)throw Error(value.error||'服务请求失败。');done(value);}catch(error){reject(error);}});
    });
    req.on('error',reject);req.on('timeout',()=>req.destroy(Error('服务响应超时。')));req.end(JSON.stringify(body));
  });
}
const health=async layout=>{try{const value=await query(layout,'/health');return value.ready===true&&value.workspace===layout.workspace?value:null;}catch{return null;}};
function acquireInstance(layout){
  const directory=join(layout.data,'application.lock');
  try{mkdirSync(directory,{mode:0o700});}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    let stale=false;
    try{const owner=readJSON(join(directory,'owner.json'));if(!Number.isInteger(owner.pid)||owner.pid<2)throw Error('应用锁无效，请检查日志目录。');
      try{process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH')stale=true;else throw error;}
    }catch(error){throw Error('应用锁缺失或损坏，未自动删除。请先完全退出 OpenNova；确认没有实例运行后，将此目录移到备份位置再重新打开：'+directory);}
    if(!stale)throw Error('OpenNova 已在运行，请切换到已打开的应用。');
    rmSync(directory,{recursive:true});mkdirSync(directory,{mode:0o700});
  }
  const id=randomUUID();writeFileSync(join(directory,'owner.json'),JSON.stringify({pid:process.pid,id}),{mode:0o600,flag:'wx'});
  return ()=>{try{if(readJSON(join(directory,'owner.json')).id===id)rmSync(directory,{recursive:true});}catch{}};
}
export async function main(args=process.argv.slice(2)){
  process.umask(0o077);
  const layout=runtimeLayout();
  if(args.includes('--diagnose')){
    const required={node:layout.node,python:layout.python,keychain:join(layout.root,'output/bin/siwc-keychain'),web:join(layout.root,'output/bot/web/index.html'),harness:join(layout.root,'engine/harness/apps/cli/lib/bin.js'),vad:join(layout.runtime,'models/silero_vad.onnx')};
    const files=Object.fromEntries(Object.entries(required).map(([key,path])=>[key,{path,exists:existsSync(path)}]));
    console.log(JSON.stringify({type:'diagnostic',platform:process.platform,arch:process.arch,node:process.versions.node,data:layout.data,files},null,2));
    process.exitCode=Object.values(files).every(item=>item.exists)?0:1;return;
  }
  ensureConfiguration(layout);
  const env=appEnvironment(layout);for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);
  if(args.includes('--authorize')){
    const {authorizeAccount}=await import('../../services/agent/authorize.mjs');
    const abort=new AbortController();for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>abort.abort());
    try{await authorizeAccount([],{port:0,signal:abort.signal});}catch(error){console.error('授权未完成：'+String(error.code||error.message||'authorization_failed').slice(0,200));process.exitCode=1;}
    return;
  }
  const unlock=acquireInstance(layout);
  const logFile=join(layout.logs,'application.log');
  let closing=false,launchTask=null,stopTask=null,abort=null,ownRuntime=null,ownedBot=null,login=null,lastStatus='',poll=null;
  const redact=value=>{
    let text=String(value).slice(0,4000);
    try{const secret=readJSON(layout.secrets).doubao||{};for(const key of [secret.api_key,secret.tts_api_key])if(key)text=text.replaceAll(key,'[已隐藏]');}catch{}
    return text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,'$1[已隐藏]');
  };
  const emit=(type,value={})=>{if(!process.stdout.destroyed)process.stdout.write(JSON.stringify({type,...value})+'\n');};
  const log=value=>{const text=redact(value);appendFileSync(logFile,new Date().toISOString()+' '+text+'\n',{mode:0o600});emit('log',{text});};
  // Imported launch code may write console messages. Keep the controller wire valid JSON.
  console.log=(...values)=>log(values.join(' '));console.error=(...values)=>log(values.join(' '));console.warn=(...values)=>log(values.join(' '));
  process.stdout.on('error',()=>void quit());
  const setStatus=(state,text)=>{const value=state+text;if(lastStatus===value)return;lastStatus=value;emit('status',{state,text,url:layout.url});};
  const checkStatus=async()=>{
    if(closing)return;
    const h=await health(layout);
    if(h){setStatus('ready','服务已就绪；可在对话窗口控制语音。');}
    else if(launchTask)setStatus('starting','正在启动 OpenNova…');
    else setStatus('stopped','服务未启动。');
  };
  async function start(){
    if(launchTask||stopTask||closing)return;
    // Refresh non-secret network preferences only when starting a fresh launch.
    const next=appEnvironment(layout);for(const key of ['OPENNOVA_PROXY','HTTPS_PROXY','HTTP_PROXY','NODE_USE_ENV_PROXY'])delete process.env[key];Object.assign(process.env,next);
    const controller=new AbortController();abort=controller;setStatus('starting','正在启动 OpenNova…');
    launchTask=(async()=>{
      const {launch}=await import('../../tools/voice/start.mjs');
      controller.signal.throwIfAborted();
      return launch({voice:false,ui:false,ttsPort:18000},{root:layout.root,env:process.env,signal:controller.signal,input:null,
        onBotStarted:({child,health:startedHealth})=>{ownedBot=child;ownRuntime=startedHealth.runtimeId;},
        log:message=>{log(message);void checkStatus();}});
    })().catch(error=>{if(!closing&&!controller.signal.aborted){log('启动未完成：'+error.message);emit('error',{text:'启动未完成，请查看下方日志。'});}})
      .finally(()=>{launchTask=null;void checkStatus();});
  }
  async function stop(){
    if(stopTask)return stopTask;
    stopTask=(async()=>{
      if(login?.exitCode===null)login.kill('SIGTERM');
      abort?.abort(Error('应用请求停止。'));
      if(launchTask)await Promise.race([launchTask,delay(24000)]);
      const h=await health(layout);
      if(ownedBot&&h&&ownRuntime===h.runtimeId){
        await query(layout,'/shutdown').catch(error=>log('服务退出请求未完成：'+error.message));
        for(let i=0;i<40&&await health(layout);i++)await delay(250);
      }
      // The detached process group comes from our own child handle, never a PID file.
      if(ownedBot&&ownedBot.exitCode===null&&ownedBot.signalCode===null&&!ownedBot.spawnError){
        const child=ownedBot;
        try{process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')log('服务进程退出未完成。');}
        for(let i=0;i<20&&child.exitCode===null&&child.signalCode===null;i++)await delay(100);
        if(child.exitCode===null&&child.signalCode===null)try{process.kill(-child.pid,'SIGKILL');}catch{}
      }
      ownedBot=null;ownRuntime=null;
      if(!closing){
        if(await health(layout)){log('已有实例仍在运行，本窗口没有停止其他实例。');setStatus('ready','已有实例仍在运行。');}
        else setStatus('stopped','本次启动的服务已停止。');
      }
    })();
    try{return await stopTask;}finally{stopTask=null;}
  }
  async function quit(){
    if(closing)return;closing=true;clearInterval(poll);
    try{await stop();}catch(error){log('退出清理：'+error.message);}finally{unlock();process.exit(0);}
  }
  async function open(){
    await start();
    for(let i=0;i<120;i++){
      const h=await health(layout);if(h){
        const {prepareDesktop}=await import('../../tools/desktop/start.mjs');
        const {botSettings}=await import('../../services/bot/settings.mjs');
        await prepareDesktop({config:botSettings(),root:layout.root,health:h,log,env:process.env});return;
      }
      if(!launchTask)throw Error('服务尚未就绪，请查看日志。');await delay(500);
    }
    throw Error('等待服务超时，请查看日志。');
  }
  async function pair(){
    if(!await health(layout))throw Error('请先启动服务，再连接浏览器扩展。');
    const pairing=await query(layout,'/desktop/pair');
    emit('pairing',{url:layout.url,code:pairing.code,expiresAt:pairing.expiresAt,extensionPath:join(layout.root,'extensions/browser')});
  }
  function authorize(){
    if(login?.exitCode===null){emit('error',{text:'登录窗口已打开，请先完成当前授权。'});return;}
    const child=spawn(layout.node,[fileURLToPath(import.meta.url),'--authorize'],{env:process.env,cwd:layout.workspace,stdio:['ignore','pipe','pipe']});login=child;
    for(const stream of [child.stdout,child.stderr]){
      const lines=createInterface({input:stream});lines.on('line',line=>{
        log(line);const match=line.match(/http:\/\/127\.0\.0\.1:\d+\/login\b/);
        if(match)emit('open-url',{url:match[0]});
      });
    }
    child.on('error',()=>emit('error',{text:'无法启动登录程序，请查看应用日志。'}));
    child.on('exit',code=>{if(login===child)login=null;if(!closing)emit(code===0?'notice':'error',{text:code===0?'ChatGPT 授权已就绪，可以开始对话。':'授权未完成；可再次点击登录 ChatGPT。'});});
  }
  const lines=createInterface({input:process.stdin});
  lines.on('line',line=>{void(async()=>{
    if(line.length>20000)throw Error('请求过大。');const message=JSON.parse(line);
    switch(message.action){
      case 'start':await start();break;
      case 'open':await open();break;
      case 'authorize':authorize();break;
      case 'pair':await pair();break;
      case 'save-settings':emit('settings',saveSettings(layout,message));emit('notice',{text:'设置已保存。已有语音请关闭后再开启；更换代理需停止服务后重新启动。'});break;
      case 'status':emit('settings',settingsSummary(layout));await checkStatus();break;
      case 'stop':await stop();break;
      case 'quit':await quit();break;
      default:throw Error('未知的应用操作。');
    }
  })().catch(error=>emit('error',{text:redact(error.message||'应用操作失败。')}));});
  lines.on('close',()=>void quit());
  for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>void quit());
  poll=setInterval(()=>void checkStatus(),2000);poll.unref();
  emit('settings',settingsSummary(layout));emit('paths',{data:layout.data,logs:layout.logs,workspace:layout.workspace});
  setStatus('stopped','准备就绪。先登录 ChatGPT，再启动对话；语音可稍后配置。');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{
  process.stdout.write(JSON.stringify({type:'error',text:String(error.message||'应用控制器启动失败。').slice(0,500)})+'\n');process.exitCode=1;
});
