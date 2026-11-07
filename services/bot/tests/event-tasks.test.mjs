import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Operations} from '../operations.mjs';
import {TaskManager} from '../tasks/manager.mjs';
import {git,prepareWorkspace} from '../tasks/workspace.mjs';
import {createBridge} from '../http.mjs';
import {createControls} from '../controls.mjs';
import {fileObservation,watchedPaths,githubSource,githubComments} from '../tasks/event-sources.mjs';
const provider=fileURLToPath(new URL('./fixtures/task-provider.mjs',import.meta.url));
async function until(fn,ms=60000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await delay(50);}throw Error('condition timed out');}
async function fixture(t,{manual=false,eventOptions={}}={}){
  const home=mkdtempSync(join(tmpdir(),'nova-event-')),workspace=join(home,'project'),ops=new Operations({home,workspace});
  await git(workspace,['init','-q']);await git(workspace,['config','user.name','Test']);await git(workspace,['config','user.email','test@localhost']);
  writeFileSync(join(workspace,'sample.txt'),'original\n');await git(workspace,['add','.']);await git(workspace,['commit','-qm','fixture']);
  const tokenPath=join(home,'token');writeFileSync(tokenPath,'fixture-token');
  let tasks;
  const server=createBridge({token:'fixture-token',handle:(...args)=>createControls({tasks,requests:{}})(...args)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const options={ops,home,workspace,agentProviderModule:provider,eventOptions,bridge:{url:`http://127.0.0.1:${server.address().port}`,tokenPath}};
  const managers=[];
  function reopen(){tasks=new TaskManager(options);managers.push(tasks);if(manual){clearInterval(tasks.timer);tasks.tick=()=>{};}return tasks;}
  reopen();t.after(async()=>{for(const manager of managers)await manager.close();await new Promise(resolve=>server.close(resolve));ops.close();rmSync(home,{recursive:true,force:true});});
  return {home,workspace,ops,tasks,reopen};
}
function agent(tasks,extra={}){return tasks.create({id:'agent',kind:'agent',workspaceMode:'code',title:'Event fixture',goal:'FIXTURE_EVENT_LOOP',mode:'edit',timeoutMs:60000,...extra});}
function complete(tasks,id='agent',status='completed'){
  const task=tasks.row('task',id),run=tasks.row('run',task.runId),job=tasks.row('job',run.jobId);
  tasks.atomic(()=>{tasks.put('task',{...task,status});tasks.put('run',{...run,status});tasks.put('job',{...job,status,cleanupConfirmed:true});});
}
const rule=(tasks,extra={})=>tasks.ruleCreate({id:'rule',taskId:'agent',type:'file',source:{paths:['sample.txt']},instruction:'RESUME_ONLY',enabled:true,maxRuns:2,...extra});
test('real Harness releases its slot, resumes the same session after failed check, then verifies the fix',async t=>{
  const {tasks,workspace,reopen}=await fixture(t);const first=agent(tasks,{autoContinue:2});
  const result=await until(()=>{const d=tasks.detail('agent');return d.runs.length===3&&d.task.status==='completed'&&d.task.cleanupConfirmed&&d;});
  assert.equal(result.task.sessionId,first.task.sessionId);
  assert.deepEqual(result.runs.map(r=>r.status),['waiting_event','waiting_event','completed']);
  assert.deepEqual(result.checks.map(c=>c.exitCode).sort(),[0,7]);
  assert.equal(result.automation.rules[0].usedRuns,2);assert.equal(result.automation.rules[0].state,'exhausted');
  assert.equal(result.automation.deliveries.length,2);assert.ok(result.automation.deliveries.every(d=>d.status==='dispatched'));
  assert.equal(result.runs[1].eventContext.data.exitCode,7);assert.equal(result.runs[2].eventContext.data.exitCode,0);
  assert.equal(readFileSync(join(result.workspace.path,'sample.txt'),'utf8'),'updated\n');assert.equal(readFileSync(join(workspace,'sample.txt'),'utf8'),'original\n');
  for(const child of result.checks){const run=tasks.row('run',child.runId);tasks.atomic(()=>tasks.automation.recordCompletion(tasks.row('task',child.id),run,tasks.row('job',run.jobId)));}
  tasks.automation.dispatch();assert.equal(tasks.detail('agent').runs.length,3);
  await tasks.close();const restarted=reopen();await delay(500);assert.equal(restarted.detail('agent').runs.length,3);assert.equal(restarted.detail('agent').automation.deliveries.length,2);
});
test('document templates with full permission can run an explicit check and resume from its result',async t=>{
  const {tasks,workspace}=await fixture(t);
  const first=agent(tasks,{workspaceMode:'documents',inputFiles:['sample.txt'],permission:'full',autoContinue:2});
  const result=await until(()=>{const d=tasks.detail('agent');return d.runs.length===3&&d.task.status==='completed'&&d.task.cleanupConfirmed&&d;});
  assert.equal(result.task.sessionId,first.task.sessionId);assert.equal(result.task.permission,'full');
  assert.equal(result.workspace.kind,'documents');assert.deepEqual(result.runs.map(r=>r.status),['waiting_event','waiting_event','completed']);
  assert.deepEqual(result.checks.map(c=>c.exitCode).sort(),[0,7]);
  assert.equal(readFileSync(join(result.workspace.path,'sample.txt'),'utf8'),'updated\n');
  assert.equal(readFileSync(join(workspace,'sample.txt'),'utf8'),'original\n');
});
test('file baseline, debounce, coalescing and pause survive restart; consumption rolls back as one transaction',async t=>{
  let now=Date.now();const {tasks,workspace,reopen}=await fixture(t,{manual:true,eventOptions:{now:()=>now}});
  agent(tasks);complete(tasks);rule(tasks);await tasks.automation.poll();assert.equal(tasks.automation.rows('event').length,0);
  tasks.automationPause({id:'agent',paused:true});writeFileSync(join(workspace,'sample.txt'),'first\n');await tasks.automation.poll();now+=2001;await tasks.automation.poll();
  tasks.automation.dispatch();assert.equal(tasks.detail('agent').runs.length,1);assert.equal(tasks.detail('agent').automation.deliveries[0].reason,'automation_paused');
  writeFileSync(join(workspace,'sample.txt'),'latest\n');await tasks.automation.poll();now+=2001;await tasks.automation.poll();
  assert.equal(tasks.detail('agent').automation.deliveries.filter(d=>d.status==='pending').length,1);
  await tasks.close();const next=reopen();assert.equal(next.detail('agent').automation.paused,true);await next.automation.poll();assert.equal(next.automation.rows('event').length,2);
  next.automationPause({id:'agent',paused:false});const put=next.put.bind(next);next.put=(kind,value)=>{if(kind==='delivery'&&value.status==='dispatched')throw Error('crash');return put(kind,value);};
  assert.throws(()=>next.automation.dispatch(),/crash/);next.put=put;
  assert.equal(next.detail('agent').runs.length,1);assert.equal(next.detail('agent').automation.rules[0].usedRuns,0);
  next.automation.dispatch();next.automation.dispatch();const d=next.detail('agent');assert.equal(d.runs.length,2);assert.equal(d.runs[1].eventContext.data.files[0].text,'latest\n');
  next.ruleToggle({id:'rule',revision:1,enabled:false});assert.equal(next.detail('agent').task.status,'paused');assert.equal(next.detail('agent').automation.paused,true);
});
test('pausing while a separate check runs stops its process and cannot wake the parent after restart',async t=>{
  const {tasks,reopen}=await fixture(t);agent(tasks,{goal:'FIXTURE_EVENT_SLOW_CHECK',autoContinue:2});
  const d=await until(()=>{const value=tasks.detail('agent');try{return value.task.status==='waiting_event'&&value.checks[0]?.status==='running'&&readFileSync(join(value.workspace.path,'check-pid'),'utf8')&&value;}catch{return false;}});
  const pid=Number(readFileSync(join(d.workspace.path,'check-pid'),'utf8'));tasks.pause({id:'agent',runId:d.task.runId});
  await until(()=>tasks.detail('agent').checks[0].cleanupConfirmed);
  assert.equal(tasks.detail('agent').task.status,'paused');assert.equal(tasks.detail('agent').checks[0].status,'cancelled');assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  await tasks.close();const next=reopen();await delay(300);assert.equal(next.detail('agent').runs.length,1);assert.equal(next.detail('agent').automation.paused,true);
});
test('accepted check is recovered after lost HTTP response, and only one check is accepted per Run',async t=>{
  const {tasks,workspace}=await fixture(t,{manual:true});agent(tasks,{autoContinue:1});complete(tasks,'agent','running');
  const task=tasks.row('task','agent'),run=tasks.row('run',task.runId);await prepareWorkspace({source:workspace,home:tasks.agentHome(task),taskId:task.id,mode:'edit'});
  const args={taskId:'agent',runId:run.id,stepId:'step',command:'true'};const check=tasks.createCheck(args);assert.equal(tasks.createCheck(args).task.id,check.task.id);
  assert.throws(()=>tasks.createCheck({...args,stepId:'another'}),/already_submitted/);
  tasks.finish(task,run,tasks.row('job',run.jobId),{status:'failed',exitCode:1,cleanupConfirmed:true});
  assert.equal(tasks.detail('agent').task.status,'waiting_event');assert.equal(tasks.detail('agent').runs[0].result.awaiting.taskId,check.task.id);
  const c=tasks.row('task',check.task.id),r=tasks.row('run',c.runId);tasks.finish(c,r,tasks.row('job',r.jobId),{status:'completed',exitCode:0,cleanupConfirmed:true});tasks.automation.dispatch();
  assert.equal(tasks.detail('agent').runs.length,2);assert.equal(tasks.automation.canCheck('agent'),false);
  complete(tasks);tasks.atomic(()=>tasks.automation.recordCompletion(c,r,{cleanupConfirmed:true,exitCode:0,status:'completed'}));tasks.automation.dispatch();assert.equal(tasks.detail('agent').runs.length,2);
});
test('exact command Run is imported once; rules default off and expired/failed tasks require deliberate handling',async t=>{
  let now=Date.now();const {tasks}=await fixture(t,{manual:true,eventOptions:{now:()=>now}});agent(tasks);complete(tasks);
  const source=tasks.create({id:'test',title:'Test',command:'false'});const run=tasks.row('run',source.task.runId);tasks.finish(tasks.row('task','test'),run,tasks.row('job',run.jobId),{status:'failed',exitCode:1,cleanupConfirmed:true});
  const spec={id:'source',type:'task',source:{taskId:'test',runId:run.id},enabled:false,maxRuns:1};rule(tasks,spec);tasks.automation.dispatch();assert.equal(tasks.detail('agent').runs.length,1);
  tasks.ruleToggle({id:'source',enabled:true,revision:1});tasks.automation.dispatch();assert.equal(tasks.detail('agent').runs.length,2);assert.throws(()=>tasks.ruleToggle({id:'source',enabled:false,revision:1}),/changed/);
  tasks.ruleToggle({id:'source',enabled:false,revision:2});assert.throws(()=>tasks.ruleToggle({id:'source',enabled:true,revision:3}),/exhausted/);
  rule(tasks,{id:'expiry',ttlHours:1});now+=3600001;assert.equal(tasks.detail('agent').automation.rules.find(r=>r.id==='expiry').state,'expired');
  assert.throws(()=>rule(tasks,{id:'self',type:'task',source:{taskId:'agent',runId:tasks.row('task','agent').runId}}),/invalid_event_source/);
  assert.throws(()=>agent(tasks,{id:'readonly',mode:'analysis',autoContinue:2}),/invalid_event_budget/);
});
test('file sources reject secrets, escapes, symlinks and oversized files',async t=>{
  const {home,workspace}=await fixture(t,{manual:true});
  for(const path of ['../escape','.git/config','config/secrets.local.json','.env','node_modules/a','/tmp/a','a/../../b'])assert.throws(()=>watchedPaths([path]),/invalid_event_paths/);
  writeFileSync(join(home,'outside'),'secret');symlinkSync(join(home,'outside'),join(workspace,'link'));assert.throws(()=>fileObservation(workspace,['link']),/outside_workspace/);
  writeFileSync(join(workspace,'large'),'x'.repeat(65537));assert.throws(()=>fileObservation(workspace,['large']),/too_large/);
  assert.equal(fileObservation(workspace,['missing']).files[0].exists,false);
});
test('GitHub uses fixed GET endpoint, authors and explicit prefix; old/edited comments never become fresh commands',async t=>{
  const {home,workspace}=await fixture(t,{manual:true}),now=Date.now(),source=githubSource({repository:'Owner/Repo',number:2,authors:['Alice']});
  const comment=(id,author,body,at=now)=>({id,user:{login:author},body,created_at:new Date(at).toISOString()});
  const payload=[comment(1,'alice','/opennova inspect'),comment(2,'eve','/opennova hack'),comment(3,'alice','hello'),comment(4,'alice','/opennova-old'),comment(5,'alice','/opennova edited',now-10000)];
  const fetcher=async(url,options)=>{assert.equal(url.origin,'https://api.github.com');assert.equal(url.pathname,'/repos/owner/repo/issues/2/comments');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer test');return Response.json(payload);};
  writeFileSync(join(home,'github.token'),'test');const found=await githubComments(source,{since:now-1000,tokenPath:join(home,'github.token'),workspace,fetcher});assert.deepEqual(found.map(c=>c.id),[1]);
  writeFileSync(join(workspace,'token'),'test');await assert.rejects(githubComments(source,{since:now,tokenPath:join(workspace,'token'),workspace,fetcher}),/must_be_external/);
  await assert.rejects(githubComments(source,{since:now,workspace,fetcher:async()=>new Response('',{status:429})}),/rate_limited/);
  await assert.rejects(githubComments(source,{since:now,workspace,fetcher:async()=>Response.json(payload,{headers:{link:'<https://evil.invalid>; rel="next"'}})}),/backlog_too_large/);
});
test('GitHub polling commits cursor and delivery together, deduplicates overlap and ignores disabled in-flight poll',async t=>{
  let now=Date.now(),response,requests=0;
  const {tasks}=await fixture(t,{manual:true,eventOptions:{now:()=>now,fetcher:async()=>{requests++;return await response();}}});agent(tasks);complete(tasks);
  const created=new Date(now+1).toISOString();response=()=>Response.json([{id:11,created_at:created,user:{login:'alice'},body:'/opennova summarize'}]);
  rule(tasks,{type:'github',source:{repository:'owner/repo',number:1,authors:['alice']}});now+=10;await tasks.automation.poll();assert.equal(tasks.automation.rows('delivery').length,1);
  now+=60001;await tasks.automation.poll();assert.equal(tasks.automation.rows('delivery').length,1);assert.equal(requests,2);
  let resolve;response=()=>new Promise(r=>resolve=r);now+=60001;const polling=tasks.automation.poll();tasks.ruleToggle({id:'rule',revision:1,enabled:false});resolve(Response.json([{id:12,created_at:new Date(now).toISOString(),user:{login:'alice'},body:'/opennova second'}]));await polling;
  assert.equal(tasks.automation.rows('delivery').length,1);assert.equal(tasks.automation.rows('delivery')[0].status,'cancelled');
});
