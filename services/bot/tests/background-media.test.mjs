import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,statSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {Operations} from '../operations.mjs';
import {captureBundle,archiveBundle} from '../skills/bundle.mjs';
import {BackgroundMedia,freezeTaskMedia} from '../images/background.mjs';
import {ROOT} from '../../runtime/sources.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XfV0AAAAASUVORK5CYII=','base64');
const fixture=(t,{media={operation:'gif_generate',projectInputs:['role.png']}}={})=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-bg-media-'))),project=join(home,'project'),agentHome=join(home,'agent'),workspace=join(agentHome,'workspace');
  mkdirSync(project);mkdirSync(workspace,{recursive:true});writeFileSync(join(project,'role.png'),png);
  writeFileSync(join(agentHome,'workspace.json'),JSON.stringify({path:workspace}));mkdirSync(join(project,'.opennova'));
  writeFileSync(join(project,'.opennova/image-characters.json'),JSON.stringify({schemaVersion:1,characters:[
    {id:'approved',name:'确认角色',version:'v1',references:[{path:'role.png',sha256:sha(png)}],constraints:['短发']}
  ]}));
  const ops=new Operations({home,workspace});
  const snapshot=archiveBundle(home,captureBundle(join(ROOT,'skills/image-production'),{root:ROOT,source:'bundled'}));
  const pin=freezeTaskMedia({workspace:project,projectId:'project-a',projectRevision:3,config:media});
  const task={id:'task-a',runId:'run-1',projectId:'project-a',projectRevision:3,assignedBotId:'bot-a',assignmentVersion:1,status:'running',policyVersion:2,permission:'full',media:pin};
  const firstRun={id:task.runId,taskId:task.id,status:task.status,projectId:task.projectId,assignmentVersion:task.assignmentVersion,media:pin,skills:[snapshot]};
  const byId=new Map([[firstRun.id,firstRun]]),tabs={task:{[task.id]:task},run:byId};
  const tasks={row(kind,id){const value=kind==='task'?tabs.task[id]:byId.get(id);if(!value)throw Error('unknown_task');return value;},agentHome:()=>agentHome};
  let time=1000,serial=0;
  const instances=[];
  const service=options=>{const value=new BackgroundMedia({home,ops,tasks,pollMs:5,now:()=>time,...options});instances.push(value);return value;};
  const taskStatus=status=>{task.status=status;byId.get(task.runId).status=status;time+=10;};
  const nextRun=(id,extra={})=>{
    const run={...byId.get(task.runId),...extra,id,status:'running',assignmentVersion:task.assignmentVersion};
    byId.set(id,run);task.runId=id;task.status='running';time+=10;return run;
  };
  const call=(svc,name,args,signal,actionId='step-'+(++serial))=>svc.execute({task,run:byId.get(task.runId),actionId,name,args,signal});
  const save=(envelope,row)=>{
    const dir=join(envelope.context.stateDir,envelope.context.operationId);mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,'operation.json'),JSON.stringify({...row,request:envelope.arguments}));
    return row;
  };
  t.after(async()=>{await Promise.all(instances.map(s=>s.close()));ops.close();rmSync(home,{recursive:true,force:true});});
  return {task,firstRun,taskStatus,nextRun,call,save,service,workspace,project,snapshot,home,ops};
};
const gifArgs={sourcePath:'role.png',motion:'抬手',outputDir:'delivery',width:64,height:64};
const receipt=(envelope,status='pending',extra={})=>({operationId:envelope.context.operationId,tool:envelope.tool,binding:envelope.context.binding,generation:{taskId:'remote-a',remoteCalls:1},status,stage:status==='pending'?'submitted':'committed',...extra});
function artifact(path,format,bytes=png){
  mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes,{flag:'wx'});
  return {format,path,bytes:bytes.length,sha256:sha(bytes),width:64,height:64};
}
function gifComplete(envelope){
  const p=envelope.arguments.outputDir;
  return receipt(envelope,'completed',{fileValidation:{status:'passed'},firstFrameValidation:{status:'passed'},artifacts:{
    gif:artifact(join(p,'animation.gif'),'gif'),firstFrame:artifact(join(p,'first-frame.png'),'png'),video:artifact(join(p,'source.mp4'),'mp4')
  }});
}

test('GIF freezes a scoped role, keeps its origin after hard restart, and reports exactly three verified results',async t=>{
  const f=fixture(t,{media:{operation:'gif_generate',projectInputs:['role.png'],characterIds:['approved'],outputPath:'delivery'}});
  const orig=[];
  const svc=f.service({runner:(e,{snapshot,recoverOnly})=>{
    assert.equal(snapshot.version,f.snapshot.version);assert.equal(recoverOnly,false);orig.push(e);
    assert.equal(e.arguments.sourcePath,join(f.project,'role.png'));
    assert.equal(e.context.expectedReferenceHashes[e.arguments.sourcePath],sha(png));
    assert.match(e.arguments.motion,/短发/);
    return f.save(e,receipt(e));
  }});
  const args={...gifArgs,outputScope:'project',characterId:'approved'};
  const once=await f.call(svc,'gif_generate',args);
  assert.equal(once.waitingForMedia,true);
  assert.equal(once.character.id,'approved');assert.equal(once.character.version,'v1');
  assert.equal((await f.call(svc,'gif_generate',args)).id,once.id);assert.equal(orig.length,1);
  await assert.rejects(f.call(svc,'gif_generate',{...args,motion:'改了想法'}),/task_media_prior_operation_requires_review/);
  f.taskStatus('waiting_event');await svc.close();
  let done;
  const reboot=f.service({runner:(e,options)=>{
    assert.deepEqual(e,orig[0]);assert.equal(options.recoverOnly,true);assert.equal(options.snapshot.version,f.snapshot.version);
    return f.save(e,gifComplete(e));
  },onReady:row=>{done=row;return true;}});
  await reboot.tick();
  assert.equal(done.operationId,once.id);assert.equal(done.generation.taskId,'remote-a');assert.equal(done.status,'completed');
  const run=f.nextRun('run-final',{mediaResume:{operationId:once.id,originRunId:f.firstRun.id}});
  const files=reboot.artifacts(f.task.id,run.id);
  assert.deepEqual(files.map(a=>[a.role,a.scope]),[['gif','project'],['firstFrame','project'],['video','project']]);
  assert.ok(files.every(file=>file.sha256===sha(readFileSync(file.path))));
});

test('lost acknowledgement recovers same journal task, while an uncertain POST never creates again',async t=>{
  const f=fixture(t);
  let once=0;
  const svc=f.service({runner:e=>{
    once++;
    // No journal means the host cannot tell whether an outbound POST happened.
    throw Error('image_executor_receipt_missing');
  }});
  const first=await f.call(svc,'gif_generate',gifArgs);
  assert.equal(first.status,'unknown');
  assert.match(first.error,/submission_unknown/);
  assert.equal((await f.call(svc,'gif_generate',gifArgs)).id,first.id);
  await assert.rejects(f.call(svc,'gif_generate',{...gifArgs,outputDir:'new'}),/prior_operation/);
  f.taskStatus('interrupted');await svc.close();await f.service({runner:()=>assert.fail('submitted again')}).tick();
  assert.equal(once,1);
});

test('one paid submission is recovered from a durable worker receipt despite a lost local reply',async t=>{
  const f=fixture(t);
  let creates=0;
  const svc=f.service({runner:e=>{creates++;f.save(e,receipt(e));throw Error('image_executor_receipt_missing');}});
  const first=await f.call(svc,'gif_generate',gifArgs,undefined,'dispatch');
  assert.equal(first.waitingForMedia,true);
  assert.equal(svc.awaiting(f.task.id,f.firstRun.id).generation.taskId,'remote-a');
  await assert.rejects(f.call(svc,'gif_generate',{...gifArgs,motion:'different'},undefined,'dispatch'),/action_conflict/);
  assert.equal((await f.call(svc,'gif_generate',gifArgs)).generation.taskId,'remote-a');
  assert.equal(creates,1);
});

test('paused GIF never polls until an explicit follow adopts the next Run',async t=>{
  const f=fixture(t);
  const svc=f.service({runner:(e,{recoverOnly})=>{
    if(recoverOnly)return f.save(e,gifComplete(e));
    const local=e.arguments.sourcePath;
    assert.notEqual(local,join(f.project,'role.png'));
    assert.equal(readFileSync(local).compare(png),0);
    return f.save(e,receipt(e));
  },onReady:row=>{assert.equal(row.originRunId,f.firstRun.id);assert.equal(row.runId,'next-run');return true;}});
  const pending=await f.call(svc,'gif_generate',gifArgs);
  svc.stop(f.task.id);f.taskStatus('paused');await svc.tick();assert.equal(svc.awaiting(f.task.id,f.firstRun.id),undefined);
  const next=f.nextRun('next-run');
  const current=await f.call(svc,'task_media_status',{operationId:pending.id});
  assert.equal(current.localFollow,'stopped');
  const waiting=await f.call(svc,'task_media_status',{operationId:pending.id,follow:true});
  assert.equal(waiting.waitingForMedia,true);
  f.taskStatus('waiting_event');await svc.tick();
  assert.equal(svc.artifacts(f.task.id,next.id).length,3);
});

test('static results already retained by the worker resume local publication without any provider create',async t=>{
  const f=fixture(t,{media:{operation:'image_generate'}});
  let resolveWorker,workerIn;
  const ready=new Promise(resolve=>workerIn=resolve);
  const svc=f.service({runner:(e,{signal})=>new Promise((resolve,reject)=>{
    resolveWorker=()=>{
      f.save(e,receipt(e,'running',{stage:'receiving',generation:{remoteCalls:1}}));
      workerIn();
      signal.addEventListener('abort',()=>reject(Error('image_executor_interrupted')),{once:true});
    };
    resolveWorker();
  })});
  const args={mode:'create',prompt:'生成静态图',outputPath:'result.png'};
  const running=f.call(svc,'image_generate',args);
  await ready;
  // A hard crash leaves the durable host record running and receipt receiving.
  const [old]=f.ops.list('task_media');
  await svc.close();await running;f.ops.put(old);
  f.taskStatus('interrupted');
  const resumed=f.service({runner:(e,options)=>{
    assert.equal(options.recoverOnly,true);
    return f.save(e,receipt(e,'completed',{generation:{remoteCalls:1},fileValidation:{status:'passed'},artifact:artifact(e.arguments.outputPath,'png')}));
  }});
  await resumed.tick();
  assert.equal(resumed.artifacts(f.task.id,f.firstRun.id)[0].role,'image');
});

test('wrong project, stale roles, symlink output, and read-only attempts fail before the worker',async t=>{
  const f=fixture(t,{media:{operation:'gif_generate',projectInputs:['role.png'],characterIds:['approved'],outputPath:'delivery'}});
  const svc=f.service({runner:()=>assert.fail('unexpected generation')});
  await assert.rejects(f.call(svc,'gif_generate',{...gifArgs,sourcePath:'/etc/something.png'}),/input_not_bound/);
  await assert.rejects(f.call(svc,'gif_generate',{...gifArgs,outputScope:'project',outputDir:'other'}),/output_not_authorized/);
  symlinkSync(f.home,join(f.workspace,'outside'));
  await assert.rejects(f.call(svc,'gif_generate',{...gifArgs,outputDir:'outside/delivery'}),/directory_changed/);
  await assert.rejects(f.call(svc,'image_generate',{prompt:'unused'}),/not_authorized/);
  f.task.permission='read-only';
  await assert.rejects(f.call(svc,'gif_generate',gifArgs),/permission_denied/);
  f.task.permission='full';
  writeFileSync(join(f.project,'role.png'),'changed');
  await assert.rejects(f.call(svc,'gif_generate',{...gifArgs,characterId:'approved'}),/input_changed/);
});

test('a reassigned employee may not inspect or re-submit the old paid operation',async t=>{
  const f=fixture(t);
  let creates=0;
  const svc=f.service({runner:e=>{creates++;return f.save(e,receipt(e));}});
  const first=await f.call(svc,'gif_generate',gifArgs);
  f.task.assignmentVersion++;f.task.assignedBotId='bot-b';f.nextRun('run-after-reassign');
  assert.deepEqual(svc.view(f.task.id).records,[]);
  await assert.rejects(f.call(svc,'task_media_status',{operationId:first.id}),/not_owned/);
  await assert.rejects(f.call(svc,'gif_generate',gifArgs),/prior_operation_requires_review/);
  assert.equal(creates,1);
});

test('background export pins its allowed parent and forwards no larger than the ordinary report file budget',async t=>{
  const f=fixture(t,{media:{operation:'media_export',projectInputs:['role.png'],outputPath:'frame.png'}});
  const svc=f.service({runner:e=>{
    const st=statSync(f.project);
    assert.deepEqual(e.context.expectedOutputParentIdentity,[st.dev,st.ino]);
    assert.equal(e.arguments.maxBytes,20*1024*1024);
    return f.save(e,receipt(e,'completed',{generation:{status:'not_applicable',remoteCalls:0},fileValidation:{status:'passed'},artifact:artifact(e.arguments.outputPath,'png')}));
  }});
  const args={sourcePath:'role.png',outputPath:'frame.png',outputScope:'project',action:'first_frame'};
  await assert.rejects(f.call(svc,'media_export',{...args,maxBytes:64*1024*1024}),/task_media_artifact_limit/);
  const result=await f.call(svc,'media_export',args);
  assert.equal(result.artifacts.export.scope,'project');
  assert.equal(result.generation.remoteCalls,0);
});

test('review attaches only the real contact sheet and preserves owned source evidence across its assigned Run',async t=>{
  const f=fixture(t);
  let seen;
  const svc=f.service({runner:(e,{recoverOnly})=>recoverOnly?f.save(e,gifComplete(e)):f.save(e,receipt(e)),
    reviewer:async({path,expected,evidenceDir,check})=>{
      check();assert.equal(sha(readFileSync(path)),expected.sha256);
      const sheet=artifact(join(evidenceDir,'gif-contact-sheet.png'),'png');
      seen=sheet.path;return {status:'completed',visualReview:{status:'sampled',checkedFrameIndices:[0,4],totalFrames:40},artifacts:[sheet]};
    }});
  const pending=await f.call(svc,'gif_generate',gifArgs);
  f.taskStatus('waiting_event');await svc.tick();
  const run=f.nextRun('run-review',{mediaResume:{operationId:pending.id,originRunId:f.firstRun.id}});
  const value=await f.call(svc,'gif_review',{operationId:pending.id,question:'核对人物'});
  assert.equal(value.visualReview.status,'sampled');assert.equal(value.artifacts.contactSheet.path,seen);
  assert.equal(svc.artifacts(f.task.id,run.id).length,4);
  assert.equal(svc.artifacts(f.task.id,run.id).at(-1).scope,'evidence');
  await assert.rejects(f.call(svc,'gif_review',{operationId:'other-task-operation'}),/not_owned/);
});

test('Spark edit preserves its frozen reference, recovers a lost submit receipt, and delivers exactly one verified file',async t=>{
  const f=fixture(t,{media:{operation:'image_generate',projectInputs:['role.png']}});
  const args={mode:'edit',model:'minimax-h3-image',references:['role.png'],prompt:'保持构图',outputPath:'spark.png'};
  const generation={provider:'spark',model:args.model,taskId:'h3-image-'+'c'.repeat(32),remoteCalls:1};
  let creates=0,queries=0,delivered;
  const service=f.service({runner:(e,{recoverOnly})=>{
    assert.equal(recoverOnly,false);creates++;
    assert.equal(e.context.expectedReferenceHashes[e.arguments.references[0]],sha(png));
    f.save(e,receipt(e,'running',{stage:'submitting_spark',generation:{...generation,status:'submitted'}}));
    throw Error('image_executor_interrupted');
  }});
  const pending=await f.call(service,'image_generate',args);
  assert.equal(pending.waitingForMedia,true);
  assert.equal(service.awaiting(f.task.id,f.firstRun.id).generation.taskId,generation.taskId);
  assert.equal((await f.call(service,'image_generate',args)).id,pending.id);
  await service.close();f.taskStatus('waiting_event');
  const reboot=f.service({runner:(e,{recoverOnly,snapshot})=>{
    queries++;assert.equal(recoverOnly,true);assert.equal(snapshot.version,f.snapshot.version);
    return f.save(e,receipt(e,'completed',{generation:{...generation,status:'succeeded'},fileValidation:{status:'passed'},artifact:artifact(e.arguments.outputPath,'png')}));
  },onReady:row=>{delivered=row;return true;}});
  await reboot.tick();
  assert.equal(delivered.status,'completed');assert.equal(delivered.id,pending.id);
  assert.equal(delivered.artifacts.image.sha256,sha(png));assert.equal(delivered.artifacts.image.scope,'task');
  assert.equal(creates,1);assert.equal(queries,1);
});

test('an immediately completed Spark image does not put an employee into event waiting',async t=>{
  const f=fixture(t,{media:{operation:'image_generate'}});
  const service=f.service({runner:e=>f.save(e,receipt(e,'completed',{generation:{provider:'spark',model:'minimax-h3-image',
    taskId:'h3-image-'+'e'.repeat(32),status:'succeeded',remoteCalls:1},fileValidation:{status:'passed'},artifact:artifact(e.arguments.outputPath,'png')})),
    onReady:()=>assert.fail('immediate result already returned to its run')});
  const result=await f.call(service,'image_generate',{mode:'create',provider:'spark',prompt:'简单方图',outputPath:'spark.png'});
  assert.equal(result.status,'completed');assert.equal(result.waitingForMedia,undefined);
  assert.equal(service.awaiting(f.task.id,f.firstRun.id),undefined);
  await service.tick();
});
