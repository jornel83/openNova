#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {AgentClient} from './client.mjs';
if(Number(process.versions.node.split('.')[0])<24)throw Error('请使用 Node 24 运行。');
const args=process.argv.slice(2);
if(args.some(a=>!['--web','--check'].includes(a)))throw Error('用法：node tools/agent/chat.mjs [--web] [--check]');
let task,lines;
const labels={searching:'正在联网搜索',reading:'正在读取网页',answering:'正在组织回答'};
const client=new AgentClient({web:args.includes('--web'),onEvent:e=>{
  if(e.type==='status')console.log(`… ${labels[e.phase]}`);
}});
process.on('SIGINT',()=>{if(client.active)client.cancel();else lines?.close();});
try {
 const ready=await client.start();
 console.log(`OpenNova 已就绪（${ready.tools?'联网，完整答复后显示':'普通对话'}）。/stop 取消，/quit 退出。`);
 if(!args.includes('--check')) {
  lines=createInterface({input:process.stdin,output:process.stdout,terminal:process.stdin.isTTY});
  lines.on('line',line=>{
   const text=line.trim();if(!text)return;
   if(text==='/quit'){lines.close();return;}
   if(text==='/stop'){client.cancel();return;}
   if(task){console.log('正在回答，可输入 /stop 取消。');return;}
   task=client.ask(text).then(e=>{
    if(e.type==='cancelled'){console.log('已取消。');return;}
    console.log(`OpenNova：${e.text}`);
    for(const s of e.sources??[])console.log(`来源 ${s.id}：${s.title}\n${s.url}`);
   }).catch(e=>console.error(`对话失败：${e.message}`)).finally(()=>{task=undefined;});
  });
  await new Promise(r=>lines.once('close',r));
 }
}catch(e){console.error(`启动失败：${e.message}`);process.exitCode=1;}
finally{client.cancel();await client.close();await task;}
