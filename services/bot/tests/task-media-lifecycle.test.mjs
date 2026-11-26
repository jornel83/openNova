import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Operations} from '../operations.mjs';
import {TaskManager} from '../tasks/manager.mjs';
import {saveJson} from '../tasks/agent-files.mjs';
import {taskReason} from '../web/task-view.mjs';

function fixture(t){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-media-lifecycle-'))),workspace=join(home,'project');
  mkdirSync(workspace);
  const pending=new Map(),stops=[];
  let project='project-a',version='original-archive',ops,tasks,reported=[];
  const service={
    awaiting:(taskId,runId)=>pending.get(taskId)?.runId===runId&&!pending.get(taskId).stopped?pending.get(taskId):null,
    stop(taskId){stops.push(taskId);const value=pending.get(taskId);if(value)value.stopped=true;},
    reportOnly:task=>!!task.media,
    evidence(_id,runId){return reported.filter(report=>report.runId===runId);},
    artifacts:()=>[],
    view:()=>[],
    async tick(){},
    async close(){},
  };
  const start=({connect=true}={})=>{
    ops=new Operations({home,workspace});tasks=new TaskManager({ops,home,workspace});
    clearInterval(tasks.timer);tasks.foregroundBusy=()=>true;
    tasks.projects={taskBinding:()=>({cwd:workspace,projectId:project,projectRevision:3}),store:{get:()=>({name:project})}};
    tasks.skills={snapshot:()=>[{name:'image-production',version}],recordUsage(){},candidates:()=>[]};
    if(connect)tasks.installMedia(service);
  };
  t.after(async()=>{await tasks.close();ops.close();rmSync(home,{recursive:true,force:true});});
  start();
  function make(id,patch={}){
    const base={id,kind:'agent',title:'做动图',goal:'交付一张 4 秒 GIF',managementEnabled:false,media:{operation:'gif_generate'},...patch};
    tasks.create(base);
    const task=tasks.row('task',id),run=tasks.row('run',task.runId),job=tasks.row('job',run.jobId);
    Object.assign(task,{status:'running'});Object.assign(run,{status:'running'});Object.assign(job,{status:'running',cleanupConfirmed:false});
    for(const [kind,row] of Object.entries({task,run,job}))tasks.put(kind,row);
    mkdirSync(tasks.directory(job),{recursive:true});
    return {task,run,job};
  }
  function remote({task,run}){
    const record={id:'gif-'+task.id,taskId:task.id,runId:run.id,projectId:task.projectId,assignmentVersion:task.assignmentVersion,name:'gif_generate',status:'pending',
      generation:{taskId:'remote-'+task.id}};
    pending.set(task.id,record);return record;
  }
  function cleanup({job,run},status='completed'){
    saveJson(join(tasks.directory(job),'result.json'),{jobId:job.id,runId:run.id,status,cleanupConfirmed:true,finishedAt:Date.now()});
  }
  return {get tasks(){return tasks;},make,remote,cleanup,stops,pending,service,project:name=>{project=name;},version:name=>{version=name;},
    report:(run,record)=>{reported=[...reported,{...record,runId:run.id}];},
    async restart(options){if(options?.hard)tasks.closed=true;else await tasks.close();ops.close();start(options);}};
}

test('after lost GIF acknowledgement, recover confirmed remote ID and resume once without reselecting project or skill',async t=>{
  const f=fixture(t),original=f.make('lost-ack'),record=f.remote(original);
  f.cleanup(original,'interrupted');
  // Model changes and project selection do not change the prior receipt identity.
  f.version('latest-archive');f.project('project-b');
  await f.restart({connect:false,hard:true});
  assert.equal(f.tasks.row('task',original.task.id).status,'interrupted');
  f.tasks.installMedia(f.service);
  const waiting=f.tasks.detail(original.task.id);
  assert.equal(waiting.task.status,'waiting_event');
  assert.equal(waiting.task.canContinue,false);
  assert.equal(f.tasks.queries.holdsSlot(),false);
  assert.equal(waiting.task.awaiting.remoteTaskId,record.generation.taskId);
  assert.match(taskReason(waiting.task),/同一个 Seedance/);
  const terminal={...record,status:'completed',artifacts:{gif:{path:'/example/animation.gif',sha256:'example'}}};
  assert.equal(f.tasks.resumeMedia({...terminal,projectId:'project-b'}),false);
  assert.equal(f.tasks.resumeMedia({...terminal,assignmentVersion:2}),false);
  assert.equal(f.tasks.resumeMedia({...terminal,generation:{taskId:'other-task'}}),false);
  assert.equal(f.tasks.resumeMedia(terminal),true);
  assert.equal(f.tasks.resumeMedia(terminal),true);
  const done=f.tasks.detail(original.task.id);
  assert.equal(done.task.projectId,'project-a');
  assert.equal(done.runs.length,2);
  assert.deepEqual(done.runs[1].mediaResume,{operationId:record.id,originRunId:record.runId});
  assert.equal(done.runs[1].skills[0].version,'original-archive');
  assert.deepEqual(done.runs[1].media,done.runs[0].media);
});

test('pausing, cancellation and closure stop local GIF follow; late completion does not supersede user intent',t=>{
  const f=fixture(t);
  for(const mode of ['pause','cancel','close']){
    const work=f.make(mode),record=f.remote(work);
    f.cleanup(work);
    f.tasks.finish(work.task,work.run,work.job,f.tasks.receipt(work.job));
    assert.equal(f.tasks.row('task',work.task.id).status,'waiting_event');
    if(mode==='cancel')f.tasks.cancel(work.task.id,work.run.id);
    else if(mode==='close')f.tasks.closeTask({id:work.task.id,runId:work.run.id,actionId:'close-gif'});
    else f.tasks.pause({id:work.task.id,runId:work.run.id});
    assert.ok(f.stops.includes(work.task.id));
    assert.equal(f.tasks.resumeMedia({...record,status:'completed'}),false);
    assert.equal(f.tasks.detail(work.task.id).runs.length,1);
  }
});

test('a worker cannot mark a delegated image completed without a trusted receipt; read-only generation rejected at admission',t=>{
  const f=fixture(t);
  assert.throws(()=>f.make('read-only',{permission:'read-only'}),/task_media_permission_denied/);
  const work=f.make('claimed-image',{media:{operation:'image_generate'}});
  const {task,run,job}=work;
  saveJson(join(f.tasks.directory(job),'agent-result.json'),{runId:run.id,status:'completed',text:'图片已生成。'});
  f.cleanup(work);
  f.tasks.finish(task,run,job,f.tasks.receipt(job));
  assert.equal(f.tasks.row('task',task.id).status,'failed');
  assert.equal(f.tasks.row('job',job.id).error,'task_media_receipt_unavailable');
  assert.deepEqual(f.tasks.row('job',job.id).artifacts,[]);
});

test('a Spark static image releases the worker slot and delivers through the original media run',t=>{
  const f=fixture(t),work=f.make('local-image',{media:{operation:'image_generate'}}),record=f.remote(work);
  record.name='image_generate';
  record.generation={provider:'spark',model:'minimax-h3-image',taskId:'h3-image-'+'d'.repeat(32)};
  f.cleanup(work);f.tasks.finish(work.task,work.run,work.job,f.tasks.receipt(work.job));
  const waiting=f.tasks.detail(work.task.id).task;
  assert.equal(waiting.status,'waiting_event');assert.match(taskReason(waiting),/Spark/);
  assert.equal(f.tasks.queries.holdsSlot(),false);
  assert.equal(f.tasks.resumeMedia({...record,status:'completed',generation:{...record.generation,provider:'ark'}}),false);
  assert.equal(f.tasks.resumeMedia({...record,status:'completed',artifacts:{image:{path:'/example/image.png',sha256:'example'}}}),true);
  assert.equal(f.tasks.detail(work.task.id).runs[1].mediaResume.operationId,record.id);
});
