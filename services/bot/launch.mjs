import {spawn} from 'node:child_process';
import {mkdirSync,existsSync,writeFileSync,readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join,dirname} from 'node:path';
import {loadSettings} from '../agent/settings.mjs';
import {botSettings,ROOT} from './settings.mjs';
import {setup} from './setup.mjs';
import {api} from '../../tools/bot/client.mjs';
import {checkBuild} from '../../scripts/build-record.mjs';
import {parseStartArgs} from './start-options.mjs';
import {prepareDesktop} from '../../tools/desktop/start.mjs';
import {loadResearchConfig} from './research/config.mjs';
import {runtimePatch} from './configuration.mjs';
import {assertRestoreLocation} from '../../tools/bot/state-backup.mjs';

process.umask(0o077);
const b=botSettings(),s=loadSettings(),research=loadResearchConfig();
const options=parseStartArgs(process.argv.slice(2));
if(options.help){console.log('OpenNova Bot: pnpm start [-- --no-ui | --check | --stop] (desktop UI opens by default)');process.exit(0);}
async function showUI(health,signal) {
  if(health.workspace!==ROOT)throw Error('现有 Bot 使用了其他工程，请检查端口与数据目录。');
  if(!options.ui)return;
  if(!health.desktopEnabled)throw Error('现有 Bot 尚未启用桌面交互；请在任务结束后 pnpm start -- --stop，再重新启动。');
  await prepareDesktop({config:b,root:ROOT,health,signal,log:console.log});
}
if(options.check){
  try{console.log(JSON.stringify(await api('/health'),null,2));}catch{console.error('Bot 宿主尚未启动。');process.exitCode=1;}
  process.exit(process.exitCode||0);
}
if(options.stop){
  try{await api('/shutdown');console.log('已请求停止 Bot 宿主，持久状态保留。');}catch{console.error('无法连接 Bot 宿主。');process.exitCode=1;}
  process.exit(process.exitCode||0);
}
assertRestoreLocation(b.home);
let existing;
try{existing=await api('/health');}catch{}
if(existing?.ready){await showUI(existing);console.log(`Bot 已在运行：${b.url}；复用现有会话。`);process.exit(0);}


setup();mkdirSync(b.home,{recursive:true,mode:0o700});mkdirSync(b.workspace,{recursive:true,mode:0o700});
const webAssets=join(ROOT,'output/bot/web');
if(!checkBuild().ready)throw Error('build_missing_or_stale: run pnpm run build');
if(!existsSync(b.tokenPath))writeFileSync(b.tokenPath,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
// The web profile hosts the runtime; experimental interaction is bridge-only.
const patch=runtimePatch({bot:b,agent:s,webAssets,desktop:true,research});
// JSON is valid YAML; no shell interpolation or generated executable expressions.
const patchPath=join(b.home,'experiment.patch.yml');writeFileSync(patchPath,JSON.stringify(patch,null,2));
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/(KEY|TOKEN|SECRET|PASSWORD)/.test(k)&&!['DSH_HOME','NODE_OPTIONS'].includes(k)));
Object.assign(env,research.childEnv,{DSH_HOME:join(b.home,'harness'),OPENNOVA_BOT_PLUGIN:b.plugin,OPENNOVA_HARNESS_ROOT:s.harnessRoot,
  PATH:dirname(process.execPath)+':'+(env.PATH||'/usr/bin:/bin'),
  OPENNOVA_SIWC_ROOT:s.siwcRoot,OPENNOVA_SIWC_STORAGE:s.storageDir,OPENNOVA_KEYCHAIN_HELPER:s.keychainPath,
  NODE_OPTIONS:`--import=${JSON.stringify(join(ROOT,'services/bot/resolve.mjs'))}`});
if(env.OPENNOVA_PROXY){env.HTTPS_PROXY=env.OPENNOVA_PROXY;env.HTTP_PROXY=env.OPENNOVA_PROXY;}
if(env.HTTPS_PROXY||env.HTTP_PROXY){env.NODE_USE_ENV_PROXY='1';env.NO_PROXY='localhost,127.0.0.1'+(env.NO_PROXY?','+env.NO_PROXY:'');}
console.log(`OpenNova 网页聊天：${b.url}/；内部 Harness 宿主端口：${b.webPort}；Ctrl+C 停止宿主。`);
const child=spawn(process.execPath,[join(s.harnessRoot,'apps/cli/lib/bin.js'),'--profile','web','--patch',patchPath,'--host','127.0.0.1','--port',String(b.webPort),'--no-open'],{cwd:b.workspace,env,stdio:'inherit'});
const controller=new AbortController();
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{controller.abort(Error('startup_cancelled'));child.kill(sig);});
child.once('error',e=>{console.error(e.message);process.exitCode=1;});
child.once('exit',code=>{process.exitCode=code??1;});

if(options.ui) {
  try {
    const deadline=Date.now()+60000;
    let health;
    while(Date.now()<deadline&&!health?.ready) {
      controller.signal.throwIfAborted();
      if(child.exitCode!==null||child.signalCode!==null)throw Error('bot_startup_failed');
      try{health=await api('/health');}catch{}
      if(!health?.ready)await new Promise(r=>setTimeout(r,300));
    }
    if(!health?.ready)throw Error('bot_startup_timeout');
    await showUI(health,controller.signal);
  }catch(error){console.error(`桌面窗口启动未完成：${error.message}；文字入口 ${b.url}/`);}
}
