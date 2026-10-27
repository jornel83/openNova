/** Live research acceptance in a disposable Bot home. Does not open audio or browser windows. */
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {request} from 'node:http';
import {mkdirSync,writeFileSync,readFileSync,openSync,closeSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {ROOT} from '../../services/bot/settings.mjs';

export async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
export function scenarios(which,now=new Date()){
 const date=new Date(now.toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'})+'T12:00:00Z');let days=(date.getUTCDay()+2)%7;if(!days)days=7;date.setUTCDate(date.getUTCDate()-days);
 const friday=date.toISOString().slice(0,10);date.setUTCDate(date.getUTCDate()-7);const historical=date.toISOString().slice(0,10),cases=[];
 if(['stocks','all'].includes(which)){
  for(const name of ['华润微（688396）','光迅科技（002281）','华工科技（000988）'])for(let round=1;round<=3;round++)cases.push({name:name+'-'+round,date:friday,input:`请重新联网查询${name}最近周五（${friday}）的收盘价。不要复用前轮答案。核对交易日期、证券代码和收盘字段，给出来源与口径；不要打开浏览器。`});
  cases.push({name:'historical',date:historical,input:`请查华润微（688396）${historical}的收盘价，用历史日线而非最新报价核对。不要打开浏览器。`});
 }
 if(['general','all'].includes(which))cases.push(
  {name:'weather',input:'请后台查询今天北京天气和最高最低温度，说明预报日期及来源。不要打开浏览器。'},
  {name:'official-docs',input:'请从 Python 官方文档查询 asyncio.TaskGroup 的作用和出现版本，用两句话说明并给出官方来源。不要打开浏览器。'},
  {name:'json-script',input:'请后台获取 https://api.github.com/repos/python/cpython 的公开 JSON，用研究脚本提取 full_name 与 default_branch，保存结果并用 research_derive 关联实际输入 observationId。不要打开浏览器。'},
  {name:'report',input:'请用现有证据，不再联网，将刚才公开 JSON 的研究结果和实际来源用 write 保存到 output/research/acceptance-report.md。然后用 bash 检查文件存在，不修改其他工程文件。'},
  {name:'source-followup',input:'请用 research_sources 回查刚才 GitHub 仓库数据的来源和脚本结果，不要重新联网。'});
 if(['cancel','all'].includes(which))cases.push({name:'cancel',cancel:true,input:'测试停止功能：只用 research_exec 执行 sleep 30，timeoutMs 设为 45000。等待命令结束，不要后台运行，不要修改文件。'});
 return cases;
}
async function main(){
 if(Number(process.versions.node.split('.')[0])<24)throw Error('Use Node 24');
 const argv=process.argv.slice(2);let scenario='all',output=join(ROOT,'output/bot/research-execution-verification/report.json');
 for(let i=0;i<argv.length;i+=2){if(argv[i]==='--scenario')scenario=argv[i+1];else if(argv[i]==='--output')output=resolve(argv[i+1]);else throw Error('usage: --scenario stocks|general|cancel|all --output PATH');}
 if(!['stocks','general','cancel','all'].includes(scenario))throw Error('invalid_scenario');
 const home=join(ROOT,'output/bot/research-execution-verification','home-'+randomUUID()),port=await freePort(),webPort=await freePort();mkdirSync(home,{recursive:true});mkdirSync(dirname(output),{recursive:true});
 const env={...process.env,OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(port),OPENNOVA_BOT_WEB_PORT:String(webPort)};
 const log=openSync(join(home,'host.log'),'w',0o600),child=spawn(process.execPath,[join(ROOT,'services/bot/launch.mjs')],{cwd:ROOT,env,stdio:['ignore',log,log]});closeSync(log);let exited=false;child.on('exit',()=>{exited=true;});
 const api=(path,body={})=>new Promise((resolve,reject)=>{
  let token;try{token=readFileSync(join(home,'client.token'),'utf8').trim();}catch(error){reject(error);return;}
  const req=request(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},timeout:20000},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>{try{const value=JSON.parse(text);if(res.statusCode!==200)throw Error(value.error);resolve(value);}catch(error){reject(error);}});});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('probe_timeout')));req.end(JSON.stringify(body));
 });
 const report={startedAt:new Date().toISOString(),scenario,home,port,webPort,results:[],scope:'Tool-path checks; factual answers require reviewing recorded response fields.'};
 const persist=()=>writeFileSync(output,JSON.stringify(report,null,2)+'\n');
 const records=()=>{const db=new DatabaseSync(join(home,'bridge.sqlite'),{readOnly:true});try{return db.prepare('SELECT body FROM records').all().map(r=>JSON.parse(r.body));}finally{db.close();}};
 try{
  for(let i=0;i<120;i++){try{report.health=await api('/health');if(report.health.ready)break;}catch{}if(exited)throw Error('isolated_host_exited');await delay(250);}
  if(!report.health?.ready)throw Error('isolated_host_not_ready');
  for(const c of scenarios(scenario)){
   const id=randomUUID(),started=Date.now();console.log('START '+c.name);await api('/ask',{id,text:c.input,source:'text'});let result,cancelled=false;
   for(let i=0;i<1300;i++){
    result=await api('/result',{id});if(!['running','queued'].includes(result.status))break;
    if(c.cancel&&!cancelled&&records().some(r=>r.kind==='research_execution'&&r.requestId===id&&r.status==='running')){await api('/cancel',{id});cancelled=true;}
    await delay(250);
   }
   if(['running','queued'].includes(result.status))await api('/cancel',{id});
   const rows=records().filter(r=>r.requestId===id),tools=rows.filter(r=>r.kind==='tool'),sources=rows.filter(r=>r.kind==='research_observation'),failures=rows.filter(r=>['failed','cancelled','timed_out'].includes(r.status));
   const checks={settled:!['running','queued'].includes(result.status),noBrowser:!tools.some(r=>r.tool.startsWith('browser_')),hasEvidence:sources.length>0,dateMentioned:!c.date||result.text?.includes(c.date),cancelled:c.cancel?result.status==='cancelled':undefined,
    hasScript:c.name==='json-script'?rows.some(r=>r.kind==='research_derivation'):undefined};
   const status=c.cancel?(checks.cancelled?'passed':'failed'):result.status!=='completed'?'failed':sources.length||['report','source-followup'].includes(c.name)?'review_required':'graceful_failure';
   report.results.push({id,name:c.name,input:c.input,targetDate:c.date,status,answer:result.text,error:result.error,tools,sources,failures,derivations:rows.filter(r=>r.kind==='research_derivation'),elapsedMs:Date.now()-started,checks});persist();console.log('END '+c.name+' '+status+' '+Math.round((Date.now()-started)/1000)+'s');
  }
 }catch(error){report.error=error.message;process.exitCode=1;}
 finally{report.completedAt=new Date().toISOString();persist();try{await api('/shutdown');}catch{}if(!exited){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(5000)]);}if(!exited)child.kill('SIGKILL');console.log('Report: '+output);}
}
if(process.argv[1]===import.meta.filename)main().catch(error=>{console.error(error.message);process.exitCode=1;});
