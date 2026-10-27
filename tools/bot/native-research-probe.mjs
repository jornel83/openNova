/** Real native-tool baseline and disposable Bot acceptance. No audio or browser windows. */
import {spawn} from 'node:child_process';
import {request} from 'node:http';
import {mkdirSync,writeFileSync,readFileSync,openSync,closeSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {ROOT} from '../../services/bot/settings.mjs';
import {loadSettings} from '../../services/agent/settings.mjs';
import {loadResearchConfig} from '../../services/bot/research/config.mjs';
import {freePort} from './research-execution-probe.mjs';

const scenarios={acceptance:[
 ['beijing','帮我查一下北京下周六的天气，告诉我具体日期、最高最低温度和来源。'],
 ['guangzhou','再查一下广州下周六的天气，告诉我具体日期、最高最低温度和来源。'],
 ['stock','帮我查一下华润微上周五的收盘价格，核对证券代码和交易日期，给出来源。'],
 ['official-docs','请从 Python 官方文档查询 asyncio.TaskGroup 的作用和出现版本，用两句话说明并给出官方来源。'],
 ['source-followup','刚才 Python 信息的来源是什么？请回查已有来源，不要再次联网。'],
 ['json-report','请用 bash 获取 https://api.github.com/repos/python/cpython 的公开 JSON 并提取 full_name 和 default_branch，保存为 output/research/native-acceptance.json。然后读取文件核对。不要修改其他文件。'],
 ],cancel:[['cancel','用 bash 运行 sleep 30，保持前台运行，等待执行结果。'] ],
 smoke:[['smoke','请后台搜索 Python asyncio.TaskGroup 官方文档，读取一个实际结果并简短说明。']]};

async function baseline(report,persist){
 const root=loadSettings().harnessRoot,c=loadResearchConfig();
 const require=createRequire(join(root,'packages/bundle/base/package.json'));
 const mod=name=>import(pathToFileURL(require.resolve(name)));
 const {installProxyFromEnvironment}=await import(pathToFileURL(join(root,'packages/util/http-proxy/lib/index.js')));
 const env={...process.env,...(process.env.OPENNOVA_PROXY?{HTTPS_PROXY:process.env.OPENNOVA_PROXY,HTTP_PROXY:process.env.OPENNOVA_PROXY}:{})};
 const dispose=await installProxyFromEnvironment({get:name=>env[name]?{value:env[name]}:undefined},()=>{});
 const {Context}=await mod('@deepseek-ai/cordis'),ctx=new Context(),fibers=[];
 const mount=async(name,config)=>{const m=await mod(name),f=ctx.plugin(m.default??m,config);fibers.push(f);await f;};
 try{
  await mount('@deepseek-ai/dsh-system-prompt');await mount('@deepseek-ai/dsh-tools');
  await mount('@deepseek-ai/dsh-web',{searchProvider:'deepseek-official',fetchProvider:'http'});
  await mount('@deepseek-ai/dsh-web-search-deepseek',{apiKey:c.childEnv.DEEPSEEK_API_KEY});
  await mount('@deepseek-ai/dsh-web-fetch-http');await mount('@deepseek-ai/dsh-tool-web',{search:true,fetch:true,searchTimeoutMs:60000});
  for(const [name,args] of [['web_search',{queries:['北京 2026年10月31日 天气 预报']}],['web_fetch',{url:'https://www.nmc.cn/publish/forecast/ABJ/beijing.html'}],['web_fetch',{url:'https://docs.python.org/3/library/asyncio-task.html'}]]){
   const started=Date.now(),result=await ctx.tools.execute({name,arguments:args,callId:randomUUID(),signal:AbortSignal.timeout(name==='web_search'?60000:30000)});
   report.results.push({name,args,isError:result.isError,error:result.error,meta:result.meta,content:result.content,elapsedMs:Date.now()-started});persist();console.log(name+' '+(result.isError?'failed':'returned')+' '+(Date.now()-started)+'ms');
  }
 }finally{for(const f of fibers.reverse())await f.dispose();await dispose();}
}

async function main(){
 if(Number(process.versions.node.split('.')[0])<24)throw Error('Use Node 24');
 const argv=process.argv.slice(2);let scenario='acceptance',output;
 for(let i=0;i<argv.length;i+=2){if(argv[i]==='--scenario')scenario=argv[i+1];else if(argv[i]==='--output')output=resolve(argv[i+1]);else throw Error('usage: --scenario baseline|acceptance|cancel|smoke --output PATH');}
 if(scenario!=='baseline'&&!scenarios[scenario])throw Error('invalid_scenario');
 output??=join(ROOT,'output/bot/native-research-verification',scenario+'-'+Date.now()+'.json');mkdirSync(dirname(output),{recursive:true});
 const report={startedAt:new Date().toISOString(),scenario,mode:process.env.OPENNOVA_RESEARCH_MODE||'native',results:[]};
 const persist=()=>writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 if(scenario==='baseline'){try{await baseline(report,persist);}catch(error){report.error=error.message;process.exitCode=1;}finally{report.completedAt=new Date().toISOString();persist();console.log('Report: '+output);}return;}
 const home=join(ROOT,'output/bot/native-research-verification','home-'+randomUUID()),port=await freePort(),webPort=await freePort();mkdirSync(home,{recursive:true});
 Object.assign(report,{home,port,webPort});
 const env={...process.env,OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(port),OPENNOVA_BOT_WEB_PORT:String(webPort)};
 const log=openSync(join(home,'host.log'),'w',0o600),child=spawn(process.execPath,[join(ROOT,'services/bot/launch.mjs')],{cwd:ROOT,env,stdio:['ignore',log,log]});closeSync(log);
 let exited=false;child.on('exit',()=>{exited=true;});child.on('error',()=>{exited=true;});
 const api=(path,body={})=>new Promise((resolve,reject)=>{
  let token;try{token=readFileSync(join(home,'client.token'),'utf8').trim();}catch(error){reject(error);return;}
  const req=request(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},timeout:20000},res=>{
   let text='';res.setEncoding('utf8');res.on('data',s=>text+=s);res.on('end',()=>{try{const v=JSON.parse(text);if(res.statusCode!==200)throw Error(v.error);resolve(v);}catch(error){reject(error);}});
  });req.on('error',reject);req.on('timeout',()=>req.destroy(Error('probe_timeout')));req.end(JSON.stringify(body));
 });
 const records=()=>{const db=new DatabaseSync(join(home,'bridge.sqlite'),{readOnly:true});try{return db.prepare('SELECT body FROM records').all().map(r=>JSON.parse(r.body));}finally{db.close();}};
 try{
  for(let i=0;i<160;i++){try{report.health=await api('/health');if(report.health.ready)break;}catch{}if(exited)throw Error('isolated_host_exited');await delay(250);}
  if(!report.health?.ready)throw Error('isolated_host_not_ready');persist();
  for(const [name,text] of scenarios[scenario]){
   const id=randomUUID(),started=Date.now();console.log('START '+name);await api('/ask',{id,text,source:'text'});let result,cancelled=false;
   for(let i=0;i<2500;i++){
    result=await api('/result',{id});if(!['running','queued'].includes(result.status))break;
    if(name==='cancel'&&!cancelled&&records().some(r=>r.kind==='tool'&&r.requestId===id&&r.tool==='bash'&&r.status==='running')){await api('/cancel',{id});cancelled=true;}
    await delay(250);
   }
   if(['running','queued'].includes(result.status))await api('/cancel',{id});
   const rows=records().filter(r=>r.requestId===id),tools=rows.filter(r=>r.kind==='tool');
   report.results.push({name,id,input:text,result,tools,sources:rows.filter(r=>r.kind==='research_observation'),elapsedMs:Date.now()-started,
    checks:{settled:!['running','queued'].includes(result.status),noBrowser:!tools.some(r=>r.tool.startsWith('browser_')),noLegacyTools:!tools.some(r=>['web_request','research_exec','research_derive'].includes(r.tool)),cancelled:name==='cancel'?result.status==='cancelled':undefined}});
   persist();console.log('END '+name+' '+result.status+' '+Math.round((Date.now()-started)/1000)+'s');
  }
 }catch(error){report.error=error.message;process.exitCode=1;}
 finally{report.completedAt=new Date().toISOString();persist();try{await api('/shutdown');}catch{}if(!exited){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(5000)]);}if(!exited)child.kill('SIGKILL');console.log('Report: '+output);}
}
if(process.argv[1]===import.meta.filename)main().catch(error=>{console.error(error.message);process.exitCode=1;});
