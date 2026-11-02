#!/usr/bin/env node
/** Explicit real-service benchmark in disposable Bot homes; no daily chat or microphone. */
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {ROOT,requireBuiltHarness} from '../services/runtime/sources.mjs';
import {botSettings} from '../services/bot/settings.mjs';
import {runtimePatch} from '../services/bot/configuration.mjs';

const CASES={
  short:'这是性能测试。请只用一句简短中文解释什么是光合作用，不调用工具。',
  long:'这是性能测试。请用六个完整的中文句子解释光合作用，每句约二十五字，不要列表、标题或工具。',
  tool:'请用 read 读取当前工作目录的 fixture.txt，然后用三个完整中文句子解释其中的两个数值。不要修改文件，不要使用其他工具。',
};
const children=new Set();let interrupted=false;
function startChild(...args){
  const child=spawn(...args);children.add(child);
  child.on('error',error=>{child.spawnError=error;children.delete(child);});
  child.once('exit',()=>children.delete(child));return child;
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  interrupted=true;for(const child of children)void stop(child).catch(()=>{});
});
async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
async function stop(child){
  if(!child||child.spawnError||child.exitCode!==null||child.signalCode!==null)return;
  const exit=once(child,'exit');child.kill('SIGTERM');const kill=setTimeout(()=>child.kill('SIGKILL'),5000);
  try{await exit;}finally{clearTimeout(kill);}
}
function options(args){
  const opts={provider:'doubao',repeats:1,mode:'both',case:'all',ttsUrl:'http://127.0.0.1:18000'};
  for(let i=0;i<args.length;i++){
    const name=args[i];if(name==='--run'){opts.run=true;continue;}
    if(name==='--help'){opts.help=true;continue;}
    const key={'--provider':'provider','--repeats':'repeats','--mode':'mode','--case':'case','--output':'output','--tts-url':'ttsUrl'}[name];
    if(!key||!args[i+1]||args[i+1].startsWith('--'))throw Error('invalid_benchmark_option');opts[key]=args[++i];
  }
  opts.repeats=Number(opts.repeats);
  if(!['doubao','studio'].includes(opts.provider)||!['both','streaming','settled'].includes(opts.mode)
    ||!['all',...Object.keys(CASES)].includes(opts.case)||!Number.isInteger(opts.repeats)||opts.repeats<1||opts.repeats>20)throw Error('invalid_benchmark_option');
  return opts;
}
async function main(){
  const opts=options(process.argv.slice(2));
  if(!opts.run||opts.help){console.log('node scripts/benchmark-replies.mjs --run --provider doubao|studio [--mode both|streaming|settled] [--case short|long|tool|all] [--repeats 1] [--output NEW_DIRECTORY] [--tts-url http://127.0.0.1:18000]\nUses real model/TTS quota. Creates disposable Bot sessions; no microphone/speaker. Measures software latency and simulated playout, not acoustic first sound.');return;}
  if(Number(process.versions.node.split('.')[0])!==24)throw Error('Node_24_required');
  const sources=requireBuiltHarness(),directory=resolve(opts.output||join(ROOT,'output/reply-latency',new Date().toISOString().replace(/[:.]/g,'-')));
  mkdirSync(dirname(directory),{recursive:true});mkdirSync(directory,{mode:0o700});
  const rows=[],cases=opts.case==='all'?Object.keys(CASES):[opts.case];
  // Alternate the order across repetitions to reduce warmup/order bias.
  for(let repeat=0;repeat<opts.repeats;repeat++)for(const scenario of cases){
    const modes=opts.mode==='both'?(repeat%2?['streaming','settled']:['settled','streaming']):[opts.mode];
    for(const mode of modes){
      if(interrupted)throw Error('benchmark_cancelled');
      const home=mkdtempSync(join(tmpdir(),'nova-reply-bench-'));
      let child,probe,hostLog='';const token=randomBytes(24).toString('hex');
      try{
        const port=await freePort();let webPort=await freePort();while(webPort===port)webPort=await freePort();
        const b={...botSettings({OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(port),OPENNOVA_BOT_WEB_PORT:String(webPort),OPENNOVA_REPLY_MODE:mode}),workspace:join(home,'workspace')};
        mkdirSync(b.workspace);writeFileSync(join(b.workspace,'fixture.txt'),'太阳能板额定功率为 120 瓦，储能电池容量为 240 瓦时。\n');writeFileSync(b.tokenPath,token,{mode:0o600});
        const patch=runtimePatch({bot:b,agent:{harnessRoot:sources.harnessRoot},root:ROOT,desktop:false});
        const patchPath=join(home,'benchmark.patch.json');writeFileSync(patchPath,JSON.stringify(patch));
        const env={...process.env,OPENNOVA_REPLY_MODE:mode,OPENNOVA_TTS_PREFETCH:mode==='settled'?'0':'1',OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(port),
          OPENNOVA_BOT_PLUGIN:sources.botRoot,OPENNOVA_HARNESS_ROOT:sources.harnessRoot,
          DSH_HOME:join(home,'harness'),NODE_OPTIONS:'--import='+JSON.stringify(join(ROOT,'services/bot/resolve.mjs')),
          PATH:dirname(process.execPath)+':'+process.env.PATH};
        child=startChild(process.execPath,[join(sources.harnessRoot,'apps/cli/lib/bin.js'),'--profile','web','--patch',patchPath,'--host','127.0.0.1','--port',String(webPort),'--no-open'],{cwd:b.workspace,env,stdio:['ignore','pipe','pipe']});
        for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{hostLog=(hostLog+data).slice(-64000);});
        let ready=false;
        for(let n=0;n<300;n++){
          if(interrupted)throw Error('benchmark_cancelled');
          if(child.spawnError||child.exitCode!==null)throw Error('benchmark_host_exited');
          try{const r=await fetch(b.url+'/health',{method:'POST',headers:{Authorization:'Bearer '+token},body:'{}',signal:AbortSignal.timeout(1000)});if((await r.json()).ready){ready=true;break;}}catch{}
          await delay(100);
        }
        if(!ready)throw Error('benchmark_host_timeout');
        console.log(`${scenario} / ${mode} / ${repeat+1}: running`);
        if(interrupted)throw Error('benchmark_cancelled');
        probe=startChild(process.env.OPENNOVA_PYTHON||'python3.11',[join(ROOT,'scripts/measure-reply.py'),'--provider',opts.provider,'--tts-url',opts.ttsUrl,'--text',CASES[scenario]],{cwd:ROOT,env,stdio:['ignore','pipe','ignore']});
        const chunks=[];probe.stdout.on('data',chunk=>chunks.push(chunk));const [code]=await once(probe,'exit');
        let report;try{report=JSON.parse(Buffer.concat(chunks).toString());}catch{throw Error('invalid_benchmark_report');}
        const row={scenario,mode,repeat:repeat+1,...report};rows.push(row);
        writeFileSync(join(directory,`${scenario}-${mode}-${repeat+1}.json`),JSON.stringify(row,null,2),{mode:0o600});
        writeFileSync(join(directory,'summary.json'),JSON.stringify({provider:opts.provider,acoustic_validation:false,asr_included:false,rows:rows.map(({record,result,...r})=>r)},null,2),{mode:0o600});
        console.log(JSON.stringify({scenario,mode,status:row.status,timing_ms:row.timing_ms}));
        if(code!==0)throw Error('benchmark_case_failed');
      }catch(error){writeFileSync(join(directory,`${scenario}-${mode}-${repeat+1}-host.log`),hostLog.replaceAll(token,'[redacted]'),{mode:0o600});throw error;}
      finally{await stop(probe);await stop(child);rmSync(home,{recursive:true,force:true});}
    }
  }
  console.log('Reports: '+directory);
}
main().catch(error=>{console.error(error?.code==='ENOENT'?'benchmark_dependency_missing':error.message);process.exitCode=1;});
