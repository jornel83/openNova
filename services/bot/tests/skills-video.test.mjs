import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Operations} from '../operations.mjs';
import {VideoService,VIDEO_TOOL_NAMES,videoToolDefinitions,createVideoTransport} from '../skills/video.mjs';
import {ROOT} from '../../runtime/sources.mjs';
import {archiveBundle,skillDocument} from '../skills/bundle.mjs';

const deferred=()=>{let resolveDone;const promise=new Promise(r=>{resolveDone=r;});return {promise,resolve:resolveDone};};
function fixture(t,options={}){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-skills-video-'))),workspace=join(home,'workspace'),agentHome=join(home,'agent');mkdirSync(workspace);mkdirSync(agentHome);
  writeFileSync(join(agentHome,'workspace.json'),JSON.stringify({path:workspace}));
  const ops=new Operations({home,workspace}),task={id:'task-1',runId:'run-1',assignmentVersion:1,assignedBotId:'employee',policyVersion:2,permission:'full',status:'running'},run={id:'run-1',taskId:'task-1',assignmentVersion:1,status:'running',skills:[{name:'video-production',version:'v1'}]};
  const tasks={row:(kind,id)=>{const value=kind==='task'?task:run;if(id!==value.id)throw Error('unknown_task');return structuredClone(value);},agentHome:()=>agentHome};
  const calls=[],events=[];let at=100000;
  const transport=options.transport??(async call=>{calls.push(call);return {status:call.name==='video_submit'?'submitted':call.name==='video_validate'?'validated':'running',...(call.name==='video_validate'?{}:{task_id:'remote-1'})};});
  const config={db:ops.db,home,root:ROOT,tasks,events:{publish:(...args)=>events.push(args)},credential:()=> 'test-secret',now:()=>at,pollMs:1000,transport,...options};
  const service=new VideoService(config),instances=[service];
  t.after(async()=>{for(const instance of instances)await instance.close();ops.close();rmSync(home,{recursive:true,force:true});});
  const execute=(name,args={},stepId='step-1',extra={})=>service.execute({taskId:task.id,runId:run.id,stepId,name,args,...extra});
  const waiting=()=>{task.status='waiting_event';run.status='waiting_event';};
  return {service,execute,home,workspace,ops,tasks,task,run,calls,config,instances,events,waiting,advance:n=>at+=n};
}

test('video catalog preserves six schemas and exposes nonblocking wait semantics',()=>{
  const definitions=videoToolDefinitions();assert.deepEqual(definitions.map(d=>d[0]),VIDEO_TOOL_NAMES);
  assert.equal(definitions.find(d=>d[0]==='video_submit')[2].output_dir.required,undefined);
  assert.match(definitions.find(d=>d[0]==='video_wait')[1],/让出执行位置/);
  assert.equal(definitions.find(d=>d[0]==='video_submit')[2].config.properties.reference_videos.type,'array');
});

test('every nested video schema compiles through the real Harness defineTool API',async()=>{
  const {defineTool,validateArgs}=await import('../../../engine/harness/packages/core/tools/lib/index.js');
  for(const [name,description,parameters] of videoToolDefinitions()){
    assert.doesNotThrow(()=>defineTool({name,description,parameters,output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},execute:async()=>''}));
    if(parameters.task_id){assert.equal(parameters.task_id.pattern,undefined);assert.match(parameters.task_id.description,/pattern=/);}
    if(parameters.config?.properties.prompt)assert.equal(parameters.config.properties.prompt.required,true);
  }
  const edit=videoToolDefinitions().find(d=>d[0]==='video_edit')[2];
  assert.equal(edit.config.properties.clips.items.properties.path.required,true);
  assert.ok(validateArgs(edit,{config:{clips:[{}],output:'out.mp4'}}).length>0);
});

test('formal tools execute the pinned Python and schema even after the installed version changes',async t=>{
  const archiveHome=realpathSync(mkdtempSync(join(tmpdir(),'nova-video-versions-')));
  t.after(()=>rmSync(archiveHome,{recursive:true,force:true}));
  const createVersion=(version,minimum)=>{
    const schemas=JSON.parse(readFileSync(join(ROOT,'tools/video/tool-definitions.json'),'utf8'));
    for(const entry of schemas)if(entry.function.parameters.properties.config?.properties.duration)entry.function.parameters.properties.config.properties.duration.minimum=minimum;
    return archiveBundle(archiveHome,{name:'video-production',description:'Pinned video fixture',content:'Use the pinned video tools.',source:'bundled',files:new Map([
      ['skills/video-production/SKILL.md',Buffer.from(skillDocument('video-production','Pinned video fixture','Use the pinned video tools.'))],
      ['tools/video/tool-definitions.json',Buffer.from(JSON.stringify(schemas))],
      ['tools/video/tool.py',Buffer.from('import json, sys\nrequest = json.load(sys.stdin)\nprint(json.dumps({"ok": True, "result": {"status": "validated", "metadata": {"executor": "'+version+'", "action": request["action"]}}}))\n')],
    ])});
  };
  const first=createVersion('version-one',4),second=createVersion('version-two',10);
  const f=fixture(t,{root:second.archiveRoot,transport:createVideoTransport({root:second.archiveRoot})});
  f.run.skills=[first];
  const old=await f.execute('video_validate',{config:{prompt:'offline',duration:4}});
  assert.equal(old.status,'validated');assert.equal(old.metadata.executor,'version-one');
  await f.service.close();const restored=new VideoService(f.config);f.instances.push(restored);
  assert.equal((await restored.execute({taskId:f.task.id,runId:f.run.id,stepId:'after-restart',name:'video_validate',args:{config:{prompt:'offline',duration:4}}})).metadata.executor,'version-one');
  f.run.skills=[second];
  await assert.rejects(restored.execute({taskId:f.task.id,runId:f.run.id,stepId:'new-schema-rejects-old',name:'video_validate',args:{config:{prompt:'offline',duration:4}}}),/invalid_video_arguments/);
  const current=await restored.execute({taskId:f.task.id,runId:f.run.id,stepId:'new-schema',name:'video_validate',args:{config:{prompt:'offline',duration:10}}});
  assert.equal(current.metadata.executor,'version-two');
});

test('only the current full-access task with a pinned video skill may invoke tools',async t=>{
  const f=fixture(t),invoke=()=>f.execute('video_validate',{config:{prompt:'a scene'}});
  f.run.skills=[];await assert.rejects(invoke(),/video_skill_required/);
  f.run.skills=[{name:'video-production'}];f.task.permission='read-only';await assert.rejects(invoke(),/video_permission_denied/);
  f.task.permission='full';f.task.policyVersion=1;await assert.rejects(invoke(),/video_permission_denied/);
  f.task.policyVersion=2;f.run.assignmentVersion=2;await assert.rejects(invoke(),/video_actor_stale/);
  f.run.assignmentVersion=1;f.task.managementReview={};await assert.rejects(invoke(),/video_actor_stale/);
  delete f.task.managementReview;f.task.status='paused';await assert.rejects(invoke(),/video_actor_stale/);
  f.task.status='running';delete f.run.skills;f.run.employee={skills:[{name:'video-production'}]};
  assert.equal((await invoke()).status,'validated');assert.equal(f.calls.length,1);
});

test('invalid fields, nested credentials, config pairing and changed action IDs fail before dispatch',async t=>{
  const f=fixture(t);
  for(const args of [{action:'submit',config:{prompt:'x'}},{config:{prompt:'x',api_key:'secret'}},{config:{prompt:'x'},config_path:'missing.json'},{config:{prompt:'x',reference_images:'file.png'}},{config:{prompt:'x',duration:1}}])await assert.rejects(f.execute('video_validate',args),/invalid_video_arguments/);
  await assert.rejects(f.execute('video_status',{task_id:'foreign'}),/video_task_not_owned/);
  await f.execute('video_validate',{config:{prompt:'x'}});
  await assert.rejects(f.execute('video_validate',{config:{prompt:'other'}}),/video_action_conflict/);
  assert.equal(f.calls.length,1);
});

test('configuration-file inputs resolve relative to their file and preserve full-access paths',async t=>{
  const f=fixture(t),folder=join(f.home,'materials');mkdirSync(folder);writeFileSync(join(folder,'config.json'),JSON.stringify({prompt:'x',reference_images:['image.png'],reference_videos:['motion.mp4']}));
  const result=await f.execute('video_validate',{config_path:'../materials/config.json'});
  assert.equal(result.status,'validated');assert.deepEqual(f.calls[0].args.config.reference_images,[join(folder,'image.png')]);assert.deepEqual(f.calls[0].args.config.reference_videos,[join(folder,'motion.mp4')]);assert.equal(f.calls[0].args.config_path,undefined);
});

test('duplicate in-flight submission and a second action for the same default directory do not submit twice',async t=>{
  const entered=deferred(),release=deferred(),calls=[],f=fixture(t,{transport:async call=>{calls.push(call);entered.resolve();await release.promise;return {status:'submitted',task_id:'remote-1'};}});
  const args={config:{prompt:'one shot'}};const first=f.execute('video_submit',args);await entered.promise;
  const repeated=f.execute('video_submit',args);await assert.rejects(f.execute('video_submit',{config:{prompt:'another'}}),/video_action_conflict/);
  release.resolve();assert.deepEqual(await repeated,await first);assert.equal(calls.length,1);
  const next=await f.execute('video_submit',args,'step-2');assert.equal(next.alreadySubmitted,true);assert.equal(next.task_id,'remote-1');assert.equal(calls.length,1);
  assert.ok(next.output_dir.startsWith(join(f.workspace,'output','video')));
});

test('missing credentials never dispatch or reserve a billable operation',async t=>{
  const f=fixture(t,{credential:()=>undefined});
  await assert.rejects(f.execute('video_submit',{config:{prompt:'x'}}),/video_credentials_unavailable/);
  assert.equal(f.calls.length,0);assert.equal(f.service.view(f.task.id).records.length,0);
  assert.equal((await f.execute('video_validate',{config:{prompt:'x'}})).status,'validated');
});

test('output-directory aliases cannot bypass an existing remote binding',async t=>{
  const f=fixture(t),directory=join(f.workspace,'video'),link=join(f.workspace,'alias');mkdirSync(directory);symlinkSync(directory,link);
  const first=await f.execute('video_submit',{config:{prompt:'x'},output_dir:directory});
  const repeated=await f.execute('video_submit',{config:{prompt:'x'},output_dir:link},'again');
  assert.equal(first.videoRecordId,repeated.videoRecordId);assert.equal(repeated.alreadySubmitted,true);assert.equal(f.calls.length,1);
});

test('ambiguous submission is durable and errors never expose credentials or signed URLs',async t=>{
  let calls=0;const f=fixture(t,{transport:async()=>{calls++;throw Error('test-secret https://media.example/video.mp4?signature=private timeout');}});
  const args={config:{prompt:'x'}},result=await f.execute('video_submit',args);
  assert.equal(result.status,'unknown');assert.doesNotMatch(JSON.stringify(result),/test-secret|signature=private/);
  assert.equal(f.service.view(f.task.id).records[0].remoteStatus,'submission_not_confirmed');
  await f.service.close();const reopened=new VideoService(f.config);f.instances.push(reopened);
  assert.deepEqual(await reopened.execute({taskId:f.task.id,runId:f.run.id,stepId:'step-1',name:'video_submit',args}),result);
  assert.equal(calls,1);await assert.rejects(reopened.execute({taskId:f.task.id,runId:f.run.id,stepId:'query',name:'video_status',args:{}}),/video_submission_not_confirmed/);
});

test('a default output symlink cannot replay an ambiguous paid submission by its real path',async t=>{
  let calls=0;const f=fixture(t,{transport:async()=>{calls++;throw Error('submit response lost');}}),target=join(f.home,'media-output');
  mkdirSync(target);symlinkSync(target,join(f.workspace,'output'));
  const first=await f.execute('video_submit',{config:{prompt:'one generation'}});
  const repeated=await f.execute('video_submit',{config:{prompt:'one generation'},output_dir:join(target,'video',basename(first.output_dir))},'real-output-path');
  assert.equal(first.status,'unknown');assert.equal(repeated.alreadySubmitted,true);assert.equal(first.videoRecordId,repeated.videoRecordId);assert.equal(calls,1);
});

test('restart reconciles a saved remote ID but never replays a lost submission receipt',async t=>{
  const f=fixture(t),args={config:{prompt:'x'}};await f.execute('video_submit',args);
  const remote=f.service.view(f.task.id).records[0];mkdirSync(remote.outputDir,{recursive:true});writeFileSync(join(remote.outputDir,'task.json'),JSON.stringify({id:'remote-1',status:'submitted'}));
  f.service.put('remote',{...remote,remoteStatus:'submitting',remoteTaskId:undefined});
  const action=JSON.parse(f.ops.db.prepare('SELECT body FROM task_video_action').get().body);f.service.put('action',{...action,status:'running',result:undefined});
  await f.service.close();const reopened=new VideoService(f.config);f.instances.push(reopened);
  assert.equal(reopened.view(f.task.id).records[0].remoteTaskId,'remote-1');
  const result=await reopened.execute({taskId:f.task.id,runId:f.run.id,stepId:'step-1',name:'video_submit',args});
  assert.equal(result.status,'unknown');assert.equal(f.calls.length,1);
});

test('wait yields immediately and durable ready delivery retries until acknowledged',async t=>{
  let queryCount=0,deliveries=0,ack=false;
  const f=fixture(t,{transport:async({name})=>name==='video_submit'?{status:'submitted',task_id:'remote-1'}:{status:++queryCount>1?'succeeded':'running',task_id:'remote-1'},onReady:async record=>{deliveries++;assert.equal(record.runId,'run-1');assert.equal(record.resumeIntent,true);return ack;}});
  const submitted=await f.execute('video_submit',{config:{prompt:'x'}});
  const result=await f.execute('video_wait',{output_dir:submitted.output_dir},'wait');assert.equal(result.waitingForVideo,true);assert.equal(queryCount,1);
  f.waiting();f.advance(1001);await f.service.tick();assert.equal(queryCount,2);assert.equal(deliveries,1);assert.equal(f.service.view(f.task.id).records[0].following,true);
  await f.service.close();const reopened=new VideoService(f.config);f.instances.push(reopened);ack=true;f.advance(1001);await reopened.tick();
  assert.equal(queryCount,2,'terminal delivery does not poll provider again');assert.equal(deliveries,2);assert.equal(reopened.view(f.task.id).records[0].localStatus,'delivered');
  f.advance(1001);await reopened.tick();assert.equal(deliveries,2);
});

test('remote failure resumes handling once without automatically generating a replacement',async t=>{
  let posts=0,queries=0,ready=0;const f=fixture(t,{transport:async({name})=>{if(name==='video_submit'){posts++;return {status:'submitted',task_id:'remote-1'};}return {status:++queries===1?'running':'failed',task_id:'remote-1'};},onReady:async record=>{ready++;assert.equal(record.remoteStatus,'failed');return true;}});
  await f.execute('video_submit',{config:{prompt:'x'}});await f.execute('video_wait',{},'wait');f.waiting();f.advance(1001);await f.service.tick();f.advance(1001);await f.service.tick();assert.equal(posts,1);assert.equal(ready,1);
});

test('a bounded wait expiry does not claim remote failure and can resume polling the same task',async t=>{
  const deliveries=[],f=fixture(t,{onReady:async record=>{deliveries.push(record);return true;}});
  await f.execute('video_submit',{config:{prompt:'x'}});await f.execute('video_wait',{timeout_seconds:1,poll_seconds:1},'wait');f.waiting();f.advance(1001);await f.service.tick();
  assert.equal(deliveries.length,1);assert.equal(deliveries[0].waitingTimedOut,true);assert.equal(deliveries[0].remoteStatus,'running');assert.equal(f.calls.length,2);
  f.task.status='running';f.run.status='running';await f.execute('video_wait',{timeout_seconds:30},'wait-again');
  const record=f.service.view(f.task.id).records[0];assert.equal(record.waitingTimedOut,false);assert.equal(record.following,true);assert.equal(record.remoteTaskId,'remote-1');assert.equal(f.calls.filter(c=>c.name==='video_submit').length,1);
});

test('a local stop during status polling remains stopped and never claims remote cancellation',async t=>{
  const entered=deferred(),release=deferred();let queries=0,ready=0;
  const f=fixture(t,{transport:async({name})=>{if(name==='video_submit')return {status:'submitted',task_id:'remote-1'};if(++queries===1)return {status:'running',task_id:'remote-1'};entered.resolve();await release.promise;return {status:'succeeded',task_id:'remote-1'};},onReady:async()=>{ready++;return true;}});
  await f.execute('video_submit',{config:{prompt:'x'}});await f.execute('video_wait',{},'wait');f.waiting();f.advance(1001);const polling=f.service.tick();await entered.promise;
  f.service.stop(f.task.id);release.resolve();await polling;
  const record=f.service.view(f.task.id).records[0];assert.equal(record.localStatus,'stopped');assert.equal(record.remoteStatus,'succeeded');assert.equal(ready,0);
});

test('a failed pending poll cannot overwrite a local stop',async t=>{
  const entered=deferred(),release=deferred();let queries=0,ready=0;
  const f=fixture(t,{transport:async({name})=>{if(name==='video_submit')return {status:'submitted',task_id:'remote-1'};if(++queries===1)return {status:'running',task_id:'remote-1'};entered.resolve();await release.promise;throw Error('offline query failed');},onReady:async()=>{ready++;return true;}});
  await f.execute('video_submit',{config:{prompt:'x'}});await f.execute('video_wait',{},'wait');f.waiting();f.advance(1001);const polling=f.service.tick();await entered.promise;
  f.service.stop(f.task.id);release.resolve();await polling;f.advance(1001);await f.service.tick();
  assert.equal(f.service.view(f.task.id).records[0].localStatus,'stopped');assert.equal(queries,2);assert.equal(ready,0);
});

test('follow-up stops when the task is paused or closed',async t=>{
  const f=fixture(t);await f.execute('video_submit',{config:{prompt:'x'}});await f.execute('video_wait',{},'wait');f.task.status='paused';f.run.status='paused';f.advance(1001);await f.service.tick();assert.equal(f.service.view(f.task.id).records[0].following,false);assert.equal(f.calls.length,2);
});

test('task IDs and output paths cannot select another task remote operation',async t=>{
  const f=fixture(t);const result=await f.execute('video_submit',{config:{prompt:'x'}});
  await assert.rejects(f.execute('video_status',{task_id:'remote-other'},'foreign'),/video_task_not_owned/);
  await assert.rejects(f.execute('video_status',{output_dir:join(f.workspace,'other')},'foreign-dir'),/video_task_not_owned/);
  const record=f.service.view(f.task.id).records[0];f.service.put('remote',{...record,taskId:'another-task'});
  await assert.rejects(f.execute('video_submit',{config:{prompt:'x'},output_dir:result.output_dir},'foreign-submit'),/video_task_not_owned/);
});

test('download and edit evidence exposes local artifact paths without provider payloads',async t=>{
  const f=fixture(t,{transport:async({name,args})=>name==='video_submit'?{status:'submitted',task_id:'remote-1'}:{status:name==='video_edit'?'completed':'succeeded',task_id:name==='video_edit'?undefined:'remote-1',path:name==='video_edit'?args.config.output:join(args.output_dir,'video.mp4'),size_bytes:42,metadata:{width:720,height:1280},task:{authorization:'test-secret',content:{video_url:'https://media.example/private'}}}});
  await f.execute('video_submit',{config:{prompt:'x'}});const downloaded=await f.execute('video_download',{},'download');
  const edited=await f.execute('video_edit',{config:{clips:[{path:downloaded.path}],output:'final.mp4'}},'edit');assert.equal(edited.path,join(f.workspace,'final.mp4'));
  assert.equal(f.service.artifacts(f.task.id,f.run.id).length,2);assert.equal(f.service.evidence(f.task.id,f.run.id).length,3);assert.doesNotMatch(JSON.stringify(f.service.evidence(f.task.id,f.run.id)),/test-secret|media.example/);
});

test('bundled Python transport performs offline validation with JSON stdin',async t=>{
  const f=fixture(t,{transport:createVideoTransport({root:ROOT,python:'python3.11'})});
  const result=await f.execute('video_validate',{config:{prompt:'A quiet landscape',duration:4}});
  assert.equal(result.status,'validated');assert.equal(result.reference_count,0);assert.equal(result.settings.duration,4);
});

test('registered video edit path creates a real local FFmpeg artifact',async t=>{
  if(spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status!==0||spawnSync('ffprobe',['-version'],{stdio:'ignore'}).status!==0){t.skip('FFmpeg unavailable');return;}
  const f=fixture(t,{transport:createVideoTransport({root:ROOT,python:'python3.11'})}),input=join(f.workspace,'input.mp4');
  assert.equal(spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=24','-t','0.5','-c:v','libx264',input],{encoding:'utf8'}).status,0);
  const result=await f.execute('video_edit',{config:{clips:[{path:'input.mp4',duration:0.5}],output:'final.mp4',width:160,height:90}},'edit');
  assert.equal(result.status,'completed');assert.equal(result.metadata.width,160);assert.equal(result.metadata.height,90);assert.equal(readFileSync(result.path).length,result.size_bytes);assert.equal(f.service.view(f.task.id).artifacts.length,1);
});

test('transport cancellation waits for a real child to exit and never surfaces private stderr',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'nova-video-child-')));mkdirSync(join(root,'tools/video'),{recursive:true});
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,'tools/video/tool.py'),"import json, os, sys, time\njson.load(sys.stdin)\nopen('pid', 'w').write(str(os.getpid()))\nsys.stderr.write('test-secret private provider details')\nsys.stderr.flush()\ntime.sleep(60)\n");
  const transport=createVideoTransport({root,python:'python3.11'}),controller=new AbortController();
  const result=transport({name:'video_validate',args:{config:{prompt:'x'}},workspace:root,credential:'test-secret',signal:controller.signal});
  for(let i=0;i<100&&!existsSync(join(root,'pid'));i++)await delay(10);
  assert.equal(existsSync(join(root,'pid')),true);const pid=Number(readFileSync(join(root,'pid'),'utf8'));controller.abort();
  await assert.rejects(result,error=>error.message==='video_cancelled');assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
});
