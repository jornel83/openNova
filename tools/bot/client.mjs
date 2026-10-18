import {request} from 'node:http';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {setTimeout} from 'node:timers/promises';
import {botSettings} from '../../services/bot/settings.mjs';
const b=botSettings();
export async function api(path,body={}) {
  const token=readFileSync(b.tokenPath,'utf8').trim();
  return new Promise((resolve,reject)=>{
    const req=request(b.url+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},timeout:20000},res=>{
      let text='';res.setEncoding('utf8');res.on('data',x=>text+=x);res.on('end',()=>{
        try{const value=JSON.parse(text);if(res.statusCode!==200)throw Error(value.error||'bot_connection_failed');resolve(value);}catch(e){reject(e);}
      });
    });
    req.on('timeout',()=>req.destroy(Error('bot_connection_timeout')));req.on('error',reject);req.end(JSON.stringify(body));
  });
}
export async function ask(text,{id=randomUUID(),source='text'}={}) {
  await api('/ask',{id,text,source});process.stderr.write(`请求编号：${id}\n`);let previous;
  for(let i=0;i<2100;i++) {
    const r=await api('/result',{id});
    if(!['queued','running'].includes(r.status)){if(r.status!=='completed')throw Error(r.error||r.status);return r;}
    if(r.tool&&previous!==r.tool){process.stderr.write(`工具：${r.tool}\n`);previous=r.tool;}
    await setTimeout(300);
  }
  throw Error('bot_result_timeout');
}
async function main() {
  const health=await api('/health');console.log(`OpenNova Bot 已连接；${health.sessionId}`);
  const flag=process.argv.indexOf('--ask');
  if(flag>=0){console.log(JSON.stringify(await ask(process.argv[flag+1]),null,2));return;}
  if(process.argv.includes('--check'))return;
  console.log('真实工程文件、Shell 和记忆直接执行，无需确认。/operations 查看操作记录；/tasks 查询；/cancel-task ID 取消；/memory 查看记忆；/quit 断开客户端。');
  const cli=createInterface({input:process.stdin,output:process.stdout});
  try{while(true){const text=(await cli.question('你：')).trim();if(!text)continue;if(text==='/quit')break;
    try{const [command,id]=text.split(/\s+/);let result;
      if(command==='/operations')result=await api('/operations');
      else if(command==='/pending')result=(await api('/approvals')).filter(r=>['pending','applying','failed','conflict'].includes(r.status));
      else if(command==='/approve')result=await api('/approve',{id});
      else if(command==='/reject')result=await api('/reject',{id});
      else if(command==='/tasks')result=await api('/tasks');
      else if(command==='/cancel-task')result=await api('/cancel-task',{id});
      else if(command==='/memory')result=await api('/memory');
      else if(command==='/result')result=await api('/result',{id});
      else if(command==='/cancel')result=await api('/cancel',{id});
      else {result=await ask(text);console.log('OpenNova：'+result.text);continue;}
      console.log(JSON.stringify(result,null,2));
    }catch(error){console.error('请求失败：'+error.message);}
  }}finally{cli.close();}
}
if(process.argv[1]===import.meta.filename)main().catch(e=>{console.error('Bot 连接失败：'+e.message);process.exitCode=1;});
