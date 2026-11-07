import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Operations} from '../operations.mjs';
import {createTaskHostTools,hostToolDefinitions,HOST_TOOL_NAMES} from '../tasks/host-tools.mjs';

const page={bindingId:'binding',tabId:1,documentId:'doc',revision:0,url:'https://example.com/',title:'Example',readable:true};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(t,options={}){
  const home=mkdtempSync(join(tmpdir(),'nova-host-tools-')),workspace=join(home,'workspace'),agentHome=join(home,'agent');
  mkdirSync(workspace);mkdirSync(agentHome);writeFileSync(join(agentHome,'workspace.json'),JSON.stringify({path:workspace}));writeFileSync(join(workspace,'report.md'),'result');
  const ops=new Operations({home,workspace});
  const task={id:'task-1',runId:'run-1',assignedBotId:'employee',assignmentVersion:1,policyVersion:2,permission:'full',status:'running'};
  const run={id:'run-1',taskId:'task-1',assignmentVersion:1,status:'running'};
  const tasks={row:(kind,id)=>{const value=kind==='task'?task:run;if(id!==value.id)throw Error('unknown_task');return structuredClone(value);},agentHome:()=>agentHome};
  const calls=[],bridge={execute:async(command,opts)=>{calls.push(command);return options.execute?options.execute(command,opts):{status:'completed',page};}};
  const args={tasks,ops,bridge,...options};delete args.execute;
  const host=createTaskHostTools(args),instances=[host];
  t.after(async()=>{for(const instance of instances)await instance.close();ops.close();rmSync(home,{recursive:true,force:true});});
  const invoke=(name='browser_open',params={url:page.url},extra={})=>host.invoke({task:structuredClone(task),run:structuredClone(run),name,args:params,actionId:'action-1',...extra});
  return {host,task,run,ops,workspace,home,calls,invoke,args,instances};
}
test('host tool catalog preserves existing schemas; current run and permission are required',async t=>{
  const f=fixture(t);assert.deepEqual(hostToolDefinitions().map(d=>d[0]),HOST_TOOL_NAMES);
  assert.deepEqual(hostToolDefinitions().find(d=>d[0]==='browser_close')[2].scope.enum,['tab']);
  await assert.rejects(f.invoke('browser_close',{page,scope:'window'}),/background_window_close_unavailable/);
  await assert.rejects(f.invoke('background_task_start'),/task_host_tool_denied/);
  f.task.permission='read-only';await assert.rejects(f.invoke(),/task_host_tool_denied/);
  f.task.permission='full';f.task.policyVersion=1;await assert.rejects(f.invoke(),/task_host_tool_denied/);
  f.task.policyVersion=2;f.run.assignmentVersion=0;await assert.rejects(f.invoke(),/actor_stale/);
  f.run.assignmentVersion=1;f.task.status='paused';await assert.rejects(f.invoke(),/actor_stale/);
  assert.equal(f.calls.length,0);
});
test('worker must obtain its own page and never adopts an unrelated foreground reference',async t=>{
  const f=fixture(t);
  assert.equal((await f.invoke('browser_read',{page})).error,'context_changed');assert.equal(f.calls.length,0);
  assert.equal((await f.invoke('browser_open',{url:page.url},{actionId:'open'})).status,'completed');
  assert.deepEqual(f.host.context(f.task.id).page,page);
  const foreign={...page,tabId:9,documentId:'user-page'};
  assert.equal(f.host.observeContext({page:foreign,selection:null},{activate:true}),false);
  assert.equal(f.host.context(f.task.id).kind,'none');
  assert.equal((await f.invoke('browser_click',{page:foreign,ref:'button'},{actionId:'foreign'})).error,'context_changed');
  assert.equal(f.calls.length,1);
  assert.equal(f.ops.list('tool').length,0,'worker audits stay out of foreground tool records');
});
test('duplicate actions share one effect and unknown receipts remain retired across restart',async t=>{
  const sent=deferred(),reply=deferred(),f=fixture(t,{execute:async()=>{sent.resolve();return reply.promise;}});
  const first=f.invoke();await sent.promise;const duplicate=f.invoke();
  reply.resolve({status:'unknown',error:'browser_disconnected_after_send'});
  const result=await first;assert.deepEqual(await duplicate,result);assert.equal(f.calls.length,1);
  await assert.rejects(f.invoke('browser_open',{url:'https://example.org/'}),/task_tool_action_conflict/);
  await f.host.close();const reopened=createTaskHostTools(f.args);f.instances.push(reopened);
  assert.deepEqual(await reopened.invoke({task:f.task,run:f.run,name:'browser_open',args:{url:page.url},actionId:'action-1'}),result);
  assert.equal(f.calls.length,1);
  const row=JSON.parse(f.ops.db.prepare('SELECT body FROM task_host_action').get().body);
  f.ops.db.prepare('UPDATE task_host_action SET body=? WHERE id=?').run(JSON.stringify({...row,status:'running',result:undefined}),row.id);
  await reopened.close();const recovered=createTaskHostTools(f.args);f.instances.push(recovered);
  assert.equal((await recovered.invoke({task:f.task,run:f.run,name:'browser_open',args:{url:page.url},actionId:'action-1'})).error,'host_restarted_after_dispatch');
  assert.equal(f.calls.length,1);
});
test('shared resource is serial and queued foreground work precedes the next worker operation',async t=>{
  const start=deferred(),finish=deferred(),order=[];
  const f=fixture(t,{execute:async command=>{order.push(command.args.url);if(command.args.url===page.url){start.resolve();await finish.promise;}return {status:'completed',page};}});
  const first=f.invoke();await start.promise;
  const second=f.invoke('browser_open',{url:'https://example.org/'},{actionId:'second'});
  const front=f.host.foreground(async()=>{order.push('foreground');});
  assert.deepEqual(order,[page.url]);finish.resolve();await Promise.all([first,second,front]);
  assert.deepEqual(order,[page.url,'foreground','https://example.org/']);
});
test('foreground activity delays workers; cancelled queued calls never execute',async t=>{
  let busy=true;const f=fixture(t,{foregroundBusy:()=>busy}),controller=new AbortController();
  const pending=f.invoke('browser_open',{url:page.url},{signal:controller.signal});
  await delay(60);assert.equal(f.calls.length,0);controller.abort(Error('user_cancelled'));
  assert.equal((await pending).status,'cancelled');busy=false;await delay(60);assert.equal(f.calls.length,0);
});
test('pause cancels an in-flight browser action and retains uncertain delivery without retry',async t=>{
  const sent=deferred(),f=fixture(t,{execute:async(_command,{signal})=>{sent.resolve();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return {status:'unknown',error:'cancelled_after_send'};}});
  const pending=f.invoke();await sent.promise;f.task.status='paused';
  assert.equal((await pending).status,'unknown');assert.equal(f.calls.length,1);
  f.task.status='running';assert.equal((await f.invoke()).status,'unknown');assert.equal(f.calls.length,1);
});
test('document dispatch uses the task workspace and rejects traversal and symlink escape',async t=>{
  const opened=[],f=fixture(t,{documentFactory:options=>({open:async command=>{opened.push({options,command});return {status:'dispatched'};}})});
  assert.equal((await f.invoke('document_open',{path:'report.md'})).status,'dispatched');
  assert.equal(opened.length,1);assert.equal(opened[0].command.path,realpathSync(join(f.workspace,'report.md')));
  writeFileSync(join(f.home,'outside.md'),'outside');symlinkSync(join(f.home,'outside.md'),join(f.workspace,'link.md'));
  assert.equal((await f.invoke('document_open',{path:'../outside.md'},{actionId:'outside'})).error,'outside_task_workspace');
  assert.equal((await f.invoke('document_open',{path:'link.md'},{actionId:'link'})).error,'outside_task_workspace');
  assert.equal(opened.length,1);
});
