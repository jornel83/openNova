/** Explicit manual network acceptance in disposable homes; never starts the user's bot. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {ROOT,requireBuiltHarness} from '../services/runtime/sources.mjs';
import {botSettings} from '../services/bot/settings.mjs';
import {runtimePatch} from '../services/bot/configuration.mjs';
import {createClient} from '../services/agent/chatgpt.mjs';

async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

export async function verifyProjectRuntime({output}={}) {
  const connection=await(await createClient()).getSession();
  if(connection.status!=='connected'||!connection.sharing)throw Error('existing_authorization_required');
  const sources=requireBuiltHarness(),home=realpathSync(mkdtempSync(join(tmpdir(),'nova-project-live-')));
  const port=await freePort();let webPort=await freePort();while(webPort===port)webPort=await freePort();
  const config={...botSettings({OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(port),OPENNOVA_BOT_WEB_PORT:String(webPort)}),workspace:join(home,'workspace')};
  for(const name of ['workspace','alpha','beta'])mkdirSync(join(home,name));
  const token='synthetic-project-evaluation';writeFileSync(config.tokenPath,token);
  const patch=runtimePatch({bot:config,agent:{harnessRoot:sources.harnessRoot},desktop:false});
  const plugins=patch.find(row=>row.insert).insert;
  plugins.splice(plugins.findIndex(plugin=>plugin.id==='opennova-bot'),0,{id:'project-evaluation-tools',name:join(ROOT,'services/bot/tests/fixtures/project-evaluation-guard.mjs')});
  const patchPath=join(home,'runtime.patch.json');writeFileSync(patchPath,JSON.stringify(patch));
  const child=spawn(process.execPath,[join(sources.harnessRoot,'apps/cli/lib/bin.js'),'--profile','web','--patch',patchPath,'--host','127.0.0.1','--port',String(webPort),'--no-open'],{
    cwd:config.workspace,stdio:['ignore','pipe','pipe'],env:{...process.env,DSH_HOME:join(home,'harness'),OPENNOVA_BOT_PLUGIN:sources.botRoot,OPENNOVA_HARNESS_ROOT:sources.harnessRoot,
      NODE_OPTIONS:'--import='+JSON.stringify(join(ROOT,'services/bot/resolve.mjs')),PATH:dirname(process.execPath)+':'+process.env.PATH}});
  child.stdout.resume();child.stderr.resume();
  const steps=[];let phase='start',failure;
  const check=(condition,reason)=>{if(!condition)throw Error(reason);};
  async function api(path,body={}){
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw Error('evaluation_http_'+response.status);return response.json();
  }
  async function waitFor(fn,timeoutMs=120000){
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){if(child.exitCode!==null)throw Error('evaluation_host_exited');const result=await fn();if(result)return result;await delay(100);}
    throw Error('evaluation_deadline');
  }
  async function ask(id,input){
    phase=id;const started=Date.now(),state=(await api('/projects')).state;
    await api('/ask',{id,text:input,source:'text',expectedProject:{projectId:state.projectId,revision:state.revision}});
    const result=await waitFor(async()=>{const value=await api('/result',{id});if(['failed','cancelled','interrupted'].includes(value.status))throw Error('evaluation_turn_'+value.status);return value.status==='completed'&&value;});
    const trace={id,latencyMs:Date.now()-started,focus:result.binding?.focus,projectId:result.projectId,sessionId:result.sessionId,reply:result.text};steps.push(trace);
    console.log(JSON.stringify({id,latencyMs:trace.latencyMs,focus:trace.focus,status:result.status}));return result;
  }
  let assertions={};
  try {
    await waitFor(async()=>{try{return (await api('/health')).ready;}catch{return false;}},30000);
    const identity=(await api('/health')).botId;
    const a=(await api('/project-action',{action:'create',actionId:'live-create-alpha',name:'路由验收甲',directory:join(home,'alpha')})).result;
    const b=(await api('/project-action',{action:'create',actionId:'live-create-beta',name:'路由验收乙',directory:join(home,'beta')})).result;
    const decisionInput='在路由验收甲项目，正式采用“每周三进行演示复盘”这个决定。请登记为项目决定记录，不创建文件、不启动任务。';
    const decision=await ask('live-decision',decisionInput);
    check(decision.projectId===a.id,'decision_project_mismatch');
    const record=(await api('/project-detail',{id:a.id})).records.find(row=>row.type==='decision'&&row.text.includes('周三')&&row.text.includes('演示复盘'));
    check(record&&record.status==='active','decision_not_persisted');
    check(record.sourceRequestId==='live-decision'&&record.source?.kind==='user'&&decisionInput.includes(record.source?.quote),'decision_source_mismatch');
    assertions.decision={recordId:record.id,projectId:record.projectId,sourceRequestId:record.sourceRequestId,sourceKind:record.source.kind,quoteMatches:true};
    const daily=await ask('live-daily','我朋友小林养了一只叫可可的小狗，昨天它第一次学会握手。我现在只想聊聊这件小事。');
    check(daily.binding?.focus==='daily'&&daily.projectId===null,'daily_binding_mismatch');
    const follow=await ask('live-pronoun','它后来又学会什么了吗？');
    check(follow.binding?.focus==='daily'&&follow.sessionId===daily.sessionId,'daily_continuity_mismatch');
    const back=await ask('live-return-alpha','回到路由验收甲项目，告诉我刚才已经确认的决定，只查询，不修改记录。');
    check(back.projectId===a.id&&back.text.includes('周三')&&back.text.includes('演示复盘'),'decision_recovery_mismatch');
    check((await api('/project-detail',{id:a.id})).records.some(row=>row.id===record.id&&row.status==='active'),'decision_identity_changed');
    const beta=await ask('live-beta','切到路由验收乙项目，告诉我这个项目是否已有确认决定，只查询。');
    check(beta.projectId===b.id&&!(await api('/project-detail',{id:b.id})).records.length,'other_project_mismatch');
    const beforeArchive=(await api('/project-detail',{id:a.id})).project;
    await api('/project-action',{action:'archive',actionId:'live-archive-alpha',projectId:a.id,revision:beforeArchive.revision});
    const selected=(await api('/projects')).state;
    const restored=await ask('live-restore-alpha','请恢复已归档的路由验收甲项目，只恢复项目，不开始工作也不执行任务。');
    check(restored.binding?.focus==='manage'&&restored.binding?.action==='restore','restore_management_binding_mismatch');
    check((await api('/project-detail',{id:a.id})).project.status==='active','restore_not_persisted');
    assert.deepEqual((await api('/projects')).state,selected,'restore changed conversation selection');
    assertions.restore={projectId:a.id,status:'active',selectionUnchanged:true,action:'restore'};
    const afterRestore=await ask('live-verify-restored','回路由验收甲项目，再核对每周三的演示复盘决定是否仍然保留，只查询。');
    check(afterRestore.projectId===a.id&&afterRestore.text.includes('周三'),'restored_decision_not_recovered');
    check((await api('/project-detail',{id:a.id})).records.some(row=>row.id===record.id&&row.status==='active'),'restored_decision_identity_changed');
    check((await api('/health')).botId===identity,'bot_identity_changed');
    check(!(await api('/background-tasks',{allProjects:true})).tasks.length,'unexpected_background_task');
    assertions={...assertions,dailySessionReused:true,botIdentityUnchanged:true,noBackgroundTasks:true};
  }catch(error){failure={phase,reason:/^[a-z_0-9]+$/.test(error.message)?error.message:error.code==='ERR_ASSERTION'?'evaluation_assertion_failed':'evaluation_failed'};}
  finally {
    if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGTERM');const kill=setTimeout(()=>child.kill('SIGKILL'),5000);try{await exit;}finally{clearTimeout(kill);}}
    rmSync(home,{recursive:true,force:true});
  }
  // Generated model session identifiers are only needed inside the temporary run.
  const report={evaluatedAt:new Date().toISOString(),synthetic:true,model:'gpt-6.1-sol',passed:!failure,turns:steps.length,toolBoundary:'temporary_project_metadata_only',assertions,
    steps:steps.map(({sessionId,...step})=>step),...(failure?{failure}:{})};
  if(output){const path=resolve(output);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(report,null,2)+'\n');}
  console.log(JSON.stringify({summary:{passed:report.passed,turns:report.turns,assertions:report.assertions,failure}}));return report;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);if(args.length&&!(args.length===2&&args[0]==='--output'))throw Error('usage: verify-project-runtime.mjs [--output path]');
  try{const report=await verifyProjectRuntime({output:args[1]});process.exitCode=report.passed?0:1;}
  catch{console.error(JSON.stringify({error:'project_runtime_evaluation_unavailable'}));process.exitCode=1;}
}
