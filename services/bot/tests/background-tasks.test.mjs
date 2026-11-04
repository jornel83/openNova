import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,mkdirSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {Operations} from '../operations.mjs';
import {TaskManager,taskTools} from '../tasks/manager.mjs';
import {Requests} from '../requests.mjs';
import {createControls} from '../controls.mjs';
import {createEvents} from '../desktop/events.mjs';

const q=text=>"'"+text.replaceAll("'","'\\''")+"'";
const node=code=>q(process.execPath)+' -e '+q(code);
async function until(fn,ms=12000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await delay(30);}throw Error('condition timed out');}
function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'nova-background-')),workspace=join(home,'project'),events=createEvents();
  const ops=new Operations({home,workspace}),tasks=new TaskManager({ops,home,workspace,events});
  t.after(async()=>{await tasks.close();events.close();ops.close();rmSync(home,{recursive:true,force:true});});
  return {home,workspace,events,ops,tasks};
}
const done=async(tasks,id)=>until(()=>{const detail=tasks.detail(id);return !['running','queued','cancelling'].includes(detail.task.status)&&detail;});

test('real commands queue, stream logs, preserve artifacts and do not occupy chat',async t=>{
  const {tasks,ops,workspace,events}=fixture(t),seen=[];events.subscribe(events.snapshot(()=>({})).cursor,e=>seen.push(e));
  const requests=new Requests(ops,async()=>({text:'chat is available'}));t.after(()=>requests.close());
  const handle=createControls({ops,tasks,requests,health:()=>({ready:true})});
  await handle('/background-task-start',{id:'one',title:'first',command:node("console.log('ready');setTimeout(()=>require('fs').writeFileSync('result.txt','done'),700)"),artifacts:['result.txt']});
  await until(()=>tasks.log({id:'one'}).text.includes('ready'));
  tasks.create({id:'two',title:'second',command:node("console.log(require('fs').readFileSync('result.txt','utf8'))")});
  assert.equal(tasks.detail('two').task.status,'queued');
  await handle('/ask',{id:'chat',text:'hello'});await requests.active.work;
  assert.equal((await handle('/result',{id:'chat'})).text,'chat is available');
  assert.equal((await handle('/snapshot',{})).busy,false);
  const first=await done(tasks,'one'),second=await done(tasks,'two');
  assert.equal(first.task.status,'completed');assert.equal(second.task.status,'completed');assert.equal(second.task.exitCode,0);
  assert.match(tasks.log({id:'two'}).text,/done/);assert.ok(seen.some(e=>e.type==='task.log'));
  const artifact=first.runs[0].job.artifacts[0];assert.equal(tasks.artifact({id:'one',artifactId:artifact.id}).name,'result.txt');
  writeFileSync(join(workspace,'result.txt'),'changed');assert.throws(()=>tasks.artifact({id:'one',artifactId:artifact.id}),/artifact_changed/);
});
test('idempotent submit and explicit retry preserve attempts, old cursors and failed exit codes',async t=>{
  const {tasks,workspace}=fixture(t),input={id:'failed',title:'fails',command:"printf 'failure'; exit 7"};
  const initial=tasks.create(input);assert.equal(tasks.create(input).task.runId,initial.task.runId);
  assert.throws(()=>tasks.create({...input,command:'exit 0'}),/task_id_conflict/);
  const failed=await done(tasks,'failed');assert.equal(failed.task.status,'failed');assert.equal(failed.task.exitCode,7);
  const next=tasks.retry({id:'failed',runId:initial.task.runId,actionId:'retry-once'});
  assert.equal(tasks.retry({id:'failed',runId:initial.task.runId,actionId:'retry-once'}).task.runId,next.task.runId);
  assert.throws(()=>tasks.retry({id:'failed',runId:initial.task.runId,actionId:'different'}),/task_run_changed/);
  assert.throws(()=>tasks.cancel('failed',initial.task.runId),/task_run_changed/);
  await done(tasks,'failed');assert.equal(tasks.detail('failed').runs.length,2);assert.match(tasks.log({id:'failed',runId:initial.task.runId}).text,/failure/);
  tasks.read({id:'failed',runId:initial.task.runId});assert.equal(tasks.detail('failed').task.unread,true);
  tasks.read({id:'failed',runId:next.task.runId});assert.equal(tasks.detail('failed').task.unread,false);
  symlinkSync(tmpdir(),join(workspace,'outside'));assert.throws(()=>tasks.create({id:'outside',title:'x',command:'true',workdir:'outside'}),/invalid_task_workdir/);
});
test('queued cancellation never launches; running cancellation cleans descendants before next job',async t=>{
  const {tasks,workspace}=fixture(t);
  tasks.create({id:'parent',title:'process tree',command:node("const {spawn}=require('child_process');spawn(process.execPath,['-e',\"setTimeout(()=>require('fs').writeFileSync('late.txt','bad'),1800)\"],{stdio:'inherit'});console.log('started');setInterval(()=>{},1000)")});
  await until(()=>tasks.log({id:'parent'}).text.includes('started'));
  tasks.create({id:'never',title:'queued',command:'touch never.txt'});tasks.cancel('never');
  assert.equal(tasks.detail('never').task.status,'cancelled');
  tasks.cancel('parent');assert.equal(tasks.detail('parent').task.status,'cancelling');
  assert.equal((await done(tasks,'parent')).task.status,'cancelled');
  await delay(1900);assert.equal(existsSync(join(workspace,'late.txt')),false);assert.equal(existsSync(join(workspace,'never.txt')),false);
  tasks.create({id:'after',title:'after',command:'true'});assert.equal((await done(tasks,'after')).task.status,'completed');
});
test('timeout is failed and shutdown/restart never re-executes a started command',async t=>{
  const {tasks,ops,home,workspace,events}=fixture(t);
  tasks.create({id:'timeout',title:'timeout',command:node('setInterval(()=>{},1000)'),timeoutMs:1000});
  const timed=await done(tasks,'timeout');assert.equal(timed.task.status,'failed');assert.equal(timed.task.error,'task_timeout');
  tasks.create({id:'interrupted',title:'interrupted',command:node("require('fs').appendFileSync('count','x');console.log('started');setInterval(()=>{},1000)")});
  await until(()=>tasks.log({id:'interrupted'}).text.includes('started'));
  tasks.create({id:'waiting',title:'waiting',command:'true'});
  await tasks.close();assert.equal(tasks.detail('interrupted').task.status,'interrupted');
  const reopened=new TaskManager({ops,home,workspace,events});
  assert.equal((await done(reopened,'waiting')).task.status,'completed');
  assert.equal(readFileSync(join(workspace,'count'),'utf8'),'x');assert.equal(reopened.detail('interrupted').runs.length,1);
  await reopened.close();
});
test('UTF-8 cursors preserve split text and logs are drained with a bounded disk size',async t=>{
  const {tasks}=fixture(t),expected='太阳能☀️\n'.repeat(30000);
  tasks.create({id:'unicode',title:'unicode',command:node("process.stdout.write('太阳能☀️\\n'.repeat(30000))")});
  await done(tasks,'unicode');let offset=0,text='';
  do{const chunk=tasks.log({id:'unicode',offset,limit:16381});text+=chunk.text;offset=chunk.nextOffset;if(!chunk.hasMore)break;}while(true);
  assert.equal(text,expected);
  tasks.create({id:'large',title:'bounded',command:node("process.stdout.write('x'.repeat(10*1024*1024))")});
  const large=await done(tasks,'large');assert.equal(large.task.status,'completed');assert.equal(large.task.logTruncated,true);
  assert.ok(tasks.log({id:'large'}).size<=8*1024*1024);
});
test('task tools return immediately, deduplicate model retries and reject cancelled submissions',async t=>{
  const {tasks}=fixture(t),request={id:'turn',signal:new AbortController().signal};
  const defs=taskTools(tasks,()=>request),start=defs.find(t=>t[0]==='background_task_start')[3];
  const args={title:'test',command:'true'},a=start(args),b=start(args);assert.equal(a.task.id,b.task.id);
  request.cancelled=true;assert.throws(()=>start(args),/bridge_request_required/);await done(tasks,a.task.id);
});
test('unconfirmed cleanup holds the queue until the matching supervisor receipt arrives',async t=>{
  const {tasks,home,workspace}=fixture(t);
  const initial=tasks.create({id:'uncertain',title:'uncertain launch',command:'touch must-not-replay'});
  const run=tasks.row('run',initial.task.runId),job=tasks.row('job',run.jobId);
  tasks.atomic(()=>{
    tasks.put('task',{...tasks.row('task','uncertain'),status:'interrupted'});
    tasks.put('run',{...run,status:'interrupted'});
    tasks.put('job',{...job,status:'interrupted',cleanupConfirmed:false});
  });
  const directory=join(home,'tasks',job.id);mkdirSync(directory);
  tasks.create({id:'waiting',title:'next',command:'touch after-cleanup'});
  await delay(300);assert.equal(tasks.detail('waiting').task.status,'queued');
  assert.equal(tasks.detail('uncertain').task.canRetry,false);
  writeFileSync(join(directory,'result.json'),JSON.stringify({jobId:'wrong-job',runId:run.id,status:'interrupted',cleanupConfirmed:true}));
  await delay(300);assert.equal(tasks.detail('waiting').task.status,'queued');
  writeFileSync(join(directory,'result.json'),JSON.stringify({jobId:job.id,runId:run.id,status:'interrupted',cleanupConfirmed:true}));
  assert.equal((await done(tasks,'waiting')).task.status,'completed');
  assert.equal(tasks.detail('uncertain').task.canRetry,true);
  assert.equal(existsSync(join(workspace,'must-not-replay')),false);
  assert.equal(existsSync(join(workspace,'after-cleanup')),true);
});
test('Bot process SIGKILL triggers supervisor cleanup and a durable receipt, with no command replay',{timeout:20000},async t=>{
  const home=mkdtempSync(join(tmpdir(),'nova-task-crash-')),workspace=join(home,'project');mkdirSync(workspace);
  const imports={ops:new URL('../operations.mjs',import.meta.url).href,tasks:new URL('../tasks/manager.mjs',import.meta.url).href};
  const command=node("console.log('started');setTimeout(()=>require('fs').writeFileSync('late.txt','bad'),4000);setInterval(()=>{},1000)");
  const script=`import {Operations} from ${JSON.stringify(imports.ops)};import {TaskManager} from ${JSON.stringify(imports.tasks)};
    const home=${JSON.stringify(home)},workspace=${JSON.stringify(workspace)},ops=new Operations({home,workspace}),tasks=new TaskManager({ops,home,workspace});
    console.log(JSON.stringify(tasks.create({id:'crash',title:'crash',command:${JSON.stringify(command)}})));setInterval(()=>{},1000);`;
  const parent=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
  let output='';parent.stdout.on('data',b=>output+=b);parent.stderr.resume();
  t.after(()=>{parent.kill('SIGKILL');rmSync(home,{recursive:true,force:true});});
  const record=await until(()=>{try{return JSON.parse(output);}catch{return null;}}),job=record.runs[0].job;
  const jobDir=join(home,'tasks',job.id);
  await until(()=>{try{return readFileSync(join(jobDir,'output.log'),'utf8').includes('started');}catch{return false;}});
  const exit=once(parent,'exit');parent.kill('SIGKILL');await exit;
  const receipt=await until(()=>{try{return JSON.parse(readFileSync(join(jobDir,'result.json'),'utf8'));}catch{return null;}});
  assert.equal(receipt.cleanupConfirmed,true);assert.equal(receipt.status,'interrupted');
  const ops=new Operations({home,workspace}),tasks=new TaskManager({ops,home,workspace});
  try{assert.equal(tasks.detail('crash').task.status,'interrupted');await delay(4100);assert.equal(existsSync(join(workspace,'late.txt')),false);assert.equal(tasks.detail('crash').runs.length,1);}
  finally{await tasks.close();ops.close();}
});
