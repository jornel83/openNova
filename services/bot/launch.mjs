import {spawn} from 'node:child_process';
import {mkdirSync,existsSync,writeFileSync,readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadSettings} from '../agent/settings.mjs';
import {botSettings,ROOT} from './settings.mjs';
import {ALLOWED_TOOLS,MODEL_BUDGET} from './policy.mjs';
import {setup} from './setup.mjs';
import {api} from '../../tools/bot/client.mjs';
import {buildWeb} from './web/build.mjs';
import {PROJECT_PLUGINS} from './project.mjs';

process.umask(0o077);
const b=botSettings(),s=loadSettings();
const options=process.argv.slice(2);
if(options.some(x=>!['--check','--stop'].includes(x)))throw Error('usage: run.command [--check | --stop]');
if(options.includes('--check')){
  try{console.log(JSON.stringify(await api('/health'),null,2));}catch{console.error('Bot 宿主尚未启动。');process.exitCode=1;}
  process.exit(process.exitCode||0);
}
if(options.includes('--stop')){
  try{await api('/shutdown');console.log('已请求停止 Bot 宿主，持久状态保留。');}catch{console.error('无法连接 Bot 宿主。');process.exitCode=1;}
  process.exit(process.exitCode||0);
}
try{const health=await api('/health');if(health.ready){console.log(`Bot 已在运行：${b.url}；请直接启动客户端。`);process.exit(0);}}catch{}

setup();mkdirSync(b.home,{recursive:true,mode:0o700});mkdirSync(b.workspace,{recursive:true,mode:0o700});
const webAssets=join(ROOT,'output/bot/web');
await buildWeb({plugin:b.plugin,harnessRoot:s.harnessRoot,outdir:webAssets});
if(!existsSync(b.tokenPath))writeFileSync(b.tokenPath,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
// The web profile hosts the runtime; experimental interaction is bridge-only.
const wrapper=join(b.home,'plugin');mkdirSync(wrapper,{recursive:true});
const manifest=JSON.parse(readFileSync(join(b.plugin,'package.json'),'utf8'));
writeFileSync(join(wrapper,'package.json'),JSON.stringify({name:'opennova-bot-experiment',version:manifest.version,type:'module',main:'index.js',exports:{'.':'./index.js'}}));
writeFileSync(join(wrapper,'index.js'),`export * from ${JSON.stringify(pathToFileURL(join(ROOT,'services/bot/host.mjs')).href)};\n`);
const patch=[
  ...['llm-deepseek','llm-deepseek-account','llm-pi-ai','session-title-llm','llm-retry','hmr'].map(id=>({id,disabled:true})),
  {id:'agent-default-model',config:{provider:'opennova-chatgpt',model:'gpt-6.1-sol'}},
  {id:'bash-sandbox',config:{timeoutMs:120000}},
  {id:'preset-standard',config:{id:'standard',order:1,plugins:PROJECT_PLUGINS}},
  {insert:[
    {id:'opennova-chatgpt',name:join(ROOT,'services/agent/provider.mjs'),config:{harnessRoot:s.harnessRoot,enableTools:true,allowedTools:ALLOWED_TOOLS,modelBudget:MODEL_BUDGET,requestFilter:join(ROOT,'services/bot/model-policy.mjs'),retiredMemoryPath:join(b.home,'retired.json')}},
    {id:'opennova-bot',name:join(wrapper,'index.js'),config:{...b,harnessRoot:s.harnessRoot,webAssets}},
  ]},
];
// JSON is valid YAML; no shell interpolation or generated executable expressions.
const patchPath=join(b.home,'experiment.patch.yml');writeFileSync(patchPath,JSON.stringify(patch,null,2));
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/(KEY|TOKEN|SECRET|PASSWORD)/.test(k)&&!['DSH_HOME','NODE_OPTIONS'].includes(k)));
Object.assign(env,{DSH_HOME:join(b.home,'harness'),OPENNOVA_BOT_PLUGIN:b.plugin,OPENNOVA_HARNESS_ROOT:s.harnessRoot,
  PATH:dirname(process.execPath)+':'+(env.PATH||'/usr/bin:/bin'),
  OPENNOVA_SIWC_ROOT:s.siwcRoot,OPENNOVA_SIWC_STORAGE:s.storageDir,OPENNOVA_KEYCHAIN_HELPER:s.keychainPath,
  NODE_OPTIONS:`--import=${join(ROOT,'services/bot/resolve.mjs')}`});
if(env.OPENNOVA_PROXY){env.HTTPS_PROXY=env.OPENNOVA_PROXY;env.HTTP_PROXY=env.OPENNOVA_PROXY;}
if(env.HTTPS_PROXY||env.HTTP_PROXY){env.NODE_USE_ENV_PROXY='1';env.NO_PROXY='localhost,127.0.0.1'+(env.NO_PROXY?','+env.NO_PROXY:'');}
console.log(`OpenNova 网页聊天：${b.url}/；内部 Harness 宿主端口：${b.webPort}；Ctrl+C 停止宿主。`);
const child=spawn(process.execPath,[join(s.harnessRoot,'apps/cli/lib/bin.js'),'--profile','web','--patch',patchPath,'--host','127.0.0.1','--port',String(b.webPort),'--no-open'],{cwd:b.workspace,env,stdio:'inherit'});
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>child.kill(sig));
child.once('error',e=>{console.error(e.message);process.exitCode=1;});
child.once('exit',code=>{process.exitCode=code??1;});
