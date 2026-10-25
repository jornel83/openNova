/** Isolated native Bot handoff using the real subscription provider. No microphone or daily history. */
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,openSync,closeSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {loadSettings} from '../../services/agent/settings.mjs';
import {setup} from '../../services/bot/setup.mjs';
import {ROOT} from '../../services/bot/settings.mjs';
import {MODEL_BUDGET} from '../../services/bot/policy.mjs';
import {PROJECT_PLUGINS,bindProject,settleBot} from '../../services/bot/project.mjs';
import {withoutNativeChannel} from '../../services/bot/lifecycle.mjs';
import {installModelGate} from '../../services/bot/model-gate.mjs';
import {errorEvent} from '../../services/agent/errors.mjs';
import {freePort} from './research-execution-probe.mjs';

export const name='opennova-context-probe';
export const inject=['shell','llm','tools','systemPrompt','sessionController','sessions','sessionTitle','workspaceRegistry','workingDirectory','permissionPresets','connection'];
export async function apply(ctx,config){
 const report={startedAt:new Date().toISOString(),maintenance:[]};let active;
 const persist=()=>writeFileSync(config.report,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 try{
  const {createRuntime}=await import(pathToFileURL(join(config.plugin,'index.js')));
  const {createUserMessage}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  const rt=createRuntime(withoutNativeChannel(ctx),{home:join(config.home,'bot'),workspace:config.workspace,mainName:'Context Probe',mainRole:'隔离验证',memoryReview:false,browser:false,timeZone:'Asia/Shanghai'});
  await rt.bootstrap();assert.ok(!rt.readOnly());
  const bot=rt.botOf(rt.state.mainBotIds[0]);rt.dropKickoff(bot.id);bot.model='opennova-chatgpt/gpt-6.1-sol';
  await rt.save();await rt.applyModel(bot);await bindProject(ctx,rt,bot,config.workspace);
  ctx.on('system-prompt/assemble',async(a,c,next)=>{const result=await next();return {...result,tools:result.tools.filter(t=>t.name==='read')};});
  ctx.tools.guard(e=>e.name==='read'?undefined:'This isolated probe only permits read.');
  installModelGate(ctx,{rt,bot,getActive:()=>active,onMaintenance:r=>{report.maintenance.push(r);persist();}});
  async function ask(text){
   active={id:randomUUID(),cancelled:false};
   try{
    const agent=await settleBot(rt,bot);
    agent.followup(createUserMessage({content:[{type:'text',text}],source:{kind:'user',rpcId:active.id}}));
    const settled=await settleBot(rt,bot);
    return settled.session.deriveMessages().findLast(m=>m.role==='assistant')?.content?.filter(b=>b.type==='text').map(b=>b.text).join('');
   }finally{active=undefined;}
  }
  await ask(`请使用 read 读取 ${join(config.workspace,'handoff-fact.txt')}，只回答“已读取”，不要复述文件里的具体信息。`);
  const before=await settleBot(rt,bot);assert.ok(before.session.deriveMessages().some(m=>m.role==='tool'),'Initial read tool must have completed');
  report.beforeSession=rt.chatOf(bot.id);persist();
  // Folder handoff exercises the same native writeNote/moveOn path as context pressure.
  // The read tool prevents the native short-conversation/whole-history shortcut.
  bot.workDir=config.nextWorkspace;await rt.followFolder(bot.id);await settleBot(rt,bot);
  report.afterSession=rt.chatOf(bot.id);
  assert.notEqual(report.afterSession,report.beforeSession,'Native handoff must create a fresh part');
  assert.ok(report.maintenance.some(x=>x.status==='completed'),'An idle native summary must reach the real model');
  const note=rt.partsOf(bot.id).find(p=>p.sessionId===report.beforeSession)?.note;
  assert.ok(note?.includes('极光工坊')&&note.includes('19327'),'Handoff note must preserve tool-derived facts');
  report.noteRetainedFacts=true;
  report.reply=await ask('刚才文件里的测试项目名称和接口端口分别是什么？只回答这两项，不再读取文件。');
  assert.match(report.reply,/极光工坊/);assert.match(report.reply,/19327/);
  report.status='passed';
 }catch(error){report.status='failed';report.diagnostic=errorEvent(error,'context_maintenance');report.assertion=error?.code==='ERR_ASSERTION'?error.message:undefined;}
 finally{report.completedAt=new Date().toISOString();persist();setTimeout(()=>process.kill(process.pid,'SIGTERM'),300);}
}

async function main(){
 if(Number(process.versions.node.split('.')[0])<24)throw Error('Use Node 24');
 const home=join(ROOT,'output/bot/context-diagnostics-verification',randomUUID());mkdirSync(home,{recursive:true});
 const report=join(home,'report.json'),workspace=join(home,'before'),nextWorkspace=join(home,'after');
 for(const p of [workspace,nextWorkspace])mkdirSync(p,{recursive:true});
 writeFileSync(join(workspace,'handoff-fact.txt'),'测试项目名称：极光工坊\n接口端口：19327\n');
 const s=loadSettings(),b=setup(),port=await freePort();
 const patch=[...['llm-deepseek','llm-deepseek-account','llm-pi-ai','session-title-llm','llm-retry','hmr'].map(id=>({id,disabled:true})),
  {id:'agent-default-model',config:{provider:'opennova-chatgpt',model:'gpt-6.1-sol'}},
  {id:'preset-standard',config:{id:'standard',order:1,plugins:PROJECT_PLUGINS}},
  {insert:[{id:'opennova-chatgpt',name:join(ROOT,'services/agent/provider.mjs'),config:{harnessRoot:s.harnessRoot,enableTools:true,allowedTools:['read'],modelBudget:MODEL_BUDGET}},
   {id:'context-probe',name:import.meta.filename,config:{home,workspace,nextWorkspace,report,plugin:b.plugin,harnessRoot:s.harnessRoot}}]}];
 const patchPath=join(home,'probe.patch.json');writeFileSync(patchPath,JSON.stringify(patch));
 const env={...process.env,DSH_HOME:join(home,'harness'),OPENNOVA_HARNESS_ROOT:s.harnessRoot,OPENNOVA_BOT_PLUGIN:b.plugin,
  PATH:dirname(process.execPath)+':'+process.env.PATH,NODE_OPTIONS:`--import=${join(ROOT,'services/bot/resolve.mjs')}`};
 if(env.OPENNOVA_PROXY){env.HTTP_PROXY=env.HTTPS_PROXY=env.OPENNOVA_PROXY;env.NODE_USE_ENV_PROXY='1';env.NO_PROXY='localhost,127.0.0.1';}
 const log=openSync(join(home,'host.log'),'w',0o600);
 const child=spawn(process.execPath,[join(s.harnessRoot,'apps/cli/lib/bin.js'),'--profile','web','--patch',patchPath,'--host','127.0.0.1','--port',String(port),'--no-open'],{cwd:workspace,env,stdio:['ignore',log,log]});closeSync(log);
 let exited=false;child.once('exit',()=>{exited=true;});child.once('error',()=>{exited=true;});
 console.log('Report: '+report);
 try{
  for(let i=0;i<960&&!exited;i++)await delay(250);
  if(!exited)throw Error('probe_timeout');
  const result=JSON.parse(readFileSync(report,'utf8'));console.log(JSON.stringify(result,null,2));
  assert.equal(result.status,'passed');
 }finally{if(!exited){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(5000)]);if(!exited)child.kill('SIGKILL');}}
}
if(process.argv[1]===import.meta.filename)main().catch(error=>{console.error(error.message);process.exitCode=1;});
