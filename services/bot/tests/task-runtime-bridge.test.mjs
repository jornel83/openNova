import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createBridge} from '../http.mjs';
import {createTaskRuntimeBridge} from '../tasks/bridge.mjs';
import {TaskManager} from '../tasks/manager.mjs';
import {TeamActors} from '../team/actor.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t,{invoke,mediaInvoke}={}){
  const home=mkdtempSync(join(tmpdir(),'nova-task-bridge-'));
  writeFileSync(join(home,'workspace.json'),JSON.stringify({path:home}));
  const token='fixture-run-token',task={id:'task-one',kind:'agent',runId:'run-one',assignedBotId:'employee',assignmentVersion:1,policyVersion:2,mode:'edit',permission:'full',status:'running'};
  const run={id:'run-one',taskId:task.id,assignmentVersion:1,status:'running',toolTokenHash:digest(token)};
  const otherTask={...task,id:'task-two',runId:'run-two'},otherRun={...run,id:'run-two',taskId:'task-two',toolTokenHash:digest('other-token')};
  let checkEnabled=false,enabled=true,teamEnabled=true,busy=false;
  const checked=[],tools=[],controls=[],grants=[],media=[];
  const tasks={closed:false,row(kind,id){const value=(kind==='task'?[task,otherTask]:[run,otherRun]).find(v=>v.id===id);if(!value)throw Error('unknown_task');return structuredClone(value);},
    automation:{canCheck:()=>checkEnabled},agentHome:()=>home,queries:{related:()=>[]},
    create(input,options){checked.push({input,options});return {task:{id:input.id,runId:'check-run'},status:'queued'};},
    createCheck:TaskManager.prototype.createCheck,
    runBudget:TaskManager.prototype.runBudget,
    assertOpen:TaskManager.prototype.assertOpen,
    closureAncestor:TaskManager.prototype.closureAncestor,
  };
  if(mediaInvoke)tasks.media={execute:async args=>{media.push(args);return mediaInvoke(args);}};
  const team={chiefId:'chief',bot:id=>({id}),enabled:()=>teamEnabled,profile:()=>({enabled})};
  const actors=new TeamActors({tasks,team}),issue=actors.issue.bind(actors);
  actors.issue=options=>{const actor=issue(options);grants.push(actor);return actor;};
  const hostTools={invoke:async args=>{tools.push(args);return invoke?invoke(args):{status:'completed',name:args.name};}};
  const runtime=createTaskRuntimeBridge({tasks,actors,hostTools,foregroundBusy:()=>busy});
  const server=createBridge({token:'fixture-root-token',taskRuntime:runtime,handle:async path=>{controls.push(path);return {ready:true};}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(home,{recursive:true,force:true});});
  const identity=()=>({taskId:task.id,runId:run.id,assignmentVersion:task.assignmentVersion});
  async function post(path,body={},options={}){
    const response=await fetch(url+path,{method:'POST',headers:{Authorization:'Bearer '+(options.token??token),'Content-Type':'application/json',...options.headers},body:JSON.stringify({...identity(),...body}),signal:options.signal??AbortSignal.timeout(3000)});
    return {status:response.status,body:await response.json()};
  }
  return {task,run,tasks,actors,grants,tools,controls,checked,media,post,token,identity,url,
    setCheck:value=>checkEnabled=value,setEnabled:value=>enabled=value,setTeamEnabled:value=>teamEnabled=value,setBusy:value=>busy=value};
}
test('media bridge independently enforces the trusted Run operation, permission, and pinned skill',async t=>{
  const f=await fixture(t,{mediaInvoke:({name})=>({status:'completed',name})});
  const endpoint='/task-runtime/media',body={name:'gif_generate',actionId:'gif-one',args:{sourcePath:'frozen.png'}};
  assert.equal((await f.post(endpoint,body)).body.error,'task_tool_denied');
  f.task.media={operation:'gif_generate'};f.run.media={...f.task.media};
  f.run.skills=[{name:'image-production'}];
  assert.equal((await f.post(endpoint,body)).body.error,'task_tool_denied');
  f.run.skills=[{name:'image-production',archiveRoot:'/fake/archive',version:'fake-pin'}];
  for(const patch of [{permission:'read-only'},{managementReview:{kind:'evidence'},assignedBotId:'chief'},{closure:{status:'closed'}},{media:{operation:'media_export'}}]){
    const before={...f.task};Object.assign(f.task,patch);
    assert.equal((await f.post(endpoint,body)).body.error,'task_tool_denied');
    for(const key of Object.keys(patch))if(!Object.hasOwn(before,key))delete f.task[key];else f.task[key]=before[key];
  }
  f.run.summaryRecovery={};assert.equal((await f.post(endpoint,body)).body.error,'task_tool_denied');delete f.run.summaryRecovery;
  for(const name of ['image_generate','media_export','video_submit','shell'])assert.equal((await f.post(endpoint,{...body,name})).body.error,'task_tool_denied');
  assert.equal((await f.post(endpoint,{...body,taskId:'task-two'})).body.error,'task_runtime_stale');
  assert.equal((await f.post(endpoint,body,{token:'fixture-root-token'})).body.error,'task_runtime_unauthorized');
  f.tasks.video={execute:()=>assert.fail('no alternate paid video tool')};
  assert.equal((await f.post('/task-runtime/video',{...body,name:'video_submit'})).body.error,'task_tool_denied');
  assert.equal(f.media.length,0);
  assert.equal((await f.post(endpoint,{...body,task:{permission:'read-only'},run:{id:'forged'}})).body.status,'completed');
  assert.equal(f.media[0].task.id,f.task.id);assert.equal(f.media[0].run.id,f.run.id);
  assert.equal(f.media[0].task.permission,'full');assert.ok(f.media[0].signal instanceof AbortSignal);
  for(const name of ['gif_review','project_media_characters','task_media_status'])assert.equal((await f.post(endpoint,{...body,name})).status,200);
});
test('a Run token authorizes only runtime routes, never Bot or team controls',async t=>{
  const f=await fixture(t);
  for(const path of ['/team','/team-member','/shutdown','/background-task-check','/task-runtime/team'])assert.equal((await f.post(path)).status,403,path);
  assert.equal(f.controls.length,0);
  assert.equal((await f.post('/team',{}, {token:'fixture-root-token'})).status,200);
  assert.deepEqual(f.controls,['/team']);
  assert.equal((await f.post('/task-runtime/admission',{}, {token:'fixture-root-token'})).body.error,'task_runtime_unauthorized');
  assert.equal((await f.post('/task-runtime/admission',{}, {headers:{Origin:'http://127.0.0.1'}})).status,403);
});
test('wrong credentials, cross-task identities and stale execution cannot invoke host tools',async t=>{
  const f=await fixture(t),body={name:'browser_open',args:{url:'https://example.com/'},actionId:'open'};
  assert.equal((await f.post('/task-runtime/tool',body,{token:'wrong-token'})).body.error,'task_runtime_unauthorized');
  assert.equal((await f.post('/task-runtime/tool',{...body,taskId:'task-two'})).body.error,'task_runtime_stale');
  assert.equal((await f.post('/task-runtime/tool',{...body,runId:'run-two'})).body.error,'task_runtime_unauthorized');
  assert.equal((await f.post('/task-runtime/tool',{...body,assignmentVersion:2})).body.error,'task_runtime_stale');
  f.task.runId='new-run';assert.equal((await f.post('/task-runtime/tool',body)).body.error,'task_runtime_stale');f.task.runId=f.run.id;
  f.run.status='queued';assert.equal((await f.post('/task-runtime/admission')).body.error,'task_runtime_stale');f.run.status='running';
  f.task.status='cancelled';assert.equal((await f.post('/task-runtime/tool',body)).body.error,'task_runtime_stale');f.task.status='running';
  f.task.policyVersion=1;assert.equal((await f.post('/task-runtime/tool',body)).body.error,'task_runtime_stale');f.task.policyVersion=2;
  f.tasks.closed=true;assert.equal((await f.post('/task-runtime/tool',body)).body.error,'task_runtime_stale');f.tasks.closed=false;
  f.setEnabled(false);assert.equal((await f.post('/task-runtime/tool',body)).body.error,'actor_disabled');
  assert.equal(f.tools.length,0);
});
test('current full execution uses trusted stored identity; read-only does not receive host tools',async t=>{
  const f=await fixture(t);
  f.setBusy(true);assert.deepEqual((await f.post('/task-runtime/admission')).body,{foregroundBusy:true});
  const body={name:'browser_open',args:{url:'https://example.com/'},actionId:'open',assignedBotId:'forged-chief',permission:'full'};
  f.task.permission='read-only';f.task.mode='analysis';assert.equal((await f.post('/task-runtime/tool',body)).body.error,'task_tool_denied');assert.equal(f.tools.length,0);
  f.task.permission='full';f.task.mode='edit';const response=await f.post('/task-runtime/tool',body);
  assert.equal(response.status,200);assert.equal(response.body.status,'completed');
  assert.equal(f.tools[0].task.assignedBotId,'employee');assert.equal(f.tools[0].run.id,'run-one');assert.ok(f.tools[0].signal instanceof AbortSignal);
  for(const actor of f.grants)assert.throws(()=>f.actors.check(actor,actor.taskId),/actor_denied/,'actors are retired after every HTTP call');
});
test('check requests obey task mode, explicit automation budget and original assignment',async t=>{
  const f=await fixture(t),body={stepId:'step-one',command:'true',assignedBotId:'forged-chief'};
  assert.equal((await f.post('/task-runtime/check',body)).body.error,'task_check_unavailable');
  f.task.closure={status:'closing'};assert.equal((await f.post('/task-runtime/check',body)).body.error,'task_closed');assert.equal(f.checked.length,0);delete f.task.closure;
  f.setCheck(true);f.task.permission='read-only';assert.equal((await f.post('/task-runtime/check',body)).body.error,'task_tool_denied');assert.equal(f.checked.length,0);
  f.task.mode='analysis';assert.notEqual((await f.post('/task-runtime/check',body)).status,200);assert.equal(f.checked.length,0);
  f.task.permission='full';f.task.mode='edit';const result=await f.post('/task-runtime/check',body);
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(f.checked.length,1);
  assert.equal(f.checked[0].input.assignedBotId,'employee');assert.equal(f.checked[0].options.check.taskId,'task-one');assert.equal(f.checked[0].options.check.runId,'run-one');
  assert.notEqual((await f.post('/task-runtime/check',{...body,taskId:'task-two'})).status,200);assert.equal(f.checked.length,1);
});
test('disabling employee delegation preserves the chief background runtime',async t=>{
  const f=await fixture(t);f.setTeamEnabled(false);
  assert.equal((await f.post('/task-runtime/admission')).body.error,'actor_disabled');
  f.task.assignedBotId='chief';assert.equal((await f.post('/task-runtime/admission')).status,200);
  assert.equal((await f.post('/task-runtime/tool',{name:'nova_show',actionId:'chief-tool'})).status,200);
  f.setEnabled(false);assert.equal((await f.post('/task-runtime/admission')).body.error,'actor_disabled');
});
test('pause or cancellation aborts a running host call without admitting another action',async t=>{
  let started;
  const f=await fixture(t,{invoke:async({signal})=>{started.resolve();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return {status:'cancelled',reason:signal.reason.message};}});
  for(const state of ['paused','cancelled']){
    started=deferred();f.task.status='running';
    const request=f.post('/task-runtime/tool',{name:'browser_open',args:{url:'https://example.com/'},actionId:state});
    await started.promise;f.task.status=state;
    assert.equal((await request).body.status,'cancelled');assert.equal(f.tools.at(-1).signal.aborted,true);
    assert.notEqual((await f.post('/task-runtime/tool',{name:'nova_show',actionId:'after-'+state})).status,200);
  }
  assert.equal(f.tools.length,2);
});
test('HTTP disconnect cancels in-flight host work and retires its actor',async t=>{
  const started=deferred(),cancelled=deferred();
  const f=await fixture(t,{invoke:async({signal})=>{started.resolve();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));cancelled.resolve(signal.reason.message);return {status:'unknown'};}});
  const controller=new AbortController(),request=f.post('/task-runtime/tool',{name:'nova_show',actionId:'disconnect'},{signal:controller.signal});
  await started.promise;controller.abort();await assert.rejects(request);assert.equal(await cancelled.promise,'task_runtime_disconnected');
  await delay(0);assert.throws(()=>f.actors.check(f.grants[0],'task-one'),/actor_denied/);
});
