import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Operations} from '../operations.mjs';
import {VideoService,VIDEO_TOOL_NAMES,videoToolDefinitions,createVideoTransport} from '../skills/video.mjs';
import {ROOT} from '../../runtime/sources.mjs';
import {archiveBundle,captureBundle,skillDocument} from '../skills/bundle.mjs';

const deferred=()=>{let resolveDone;const promise=new Promise(r=>{resolveDone=r;});return {promise,resolve:resolveDone};};
const portraitConfig=(extra={})=>({prompt:'A calm portrait with natural blinking.',model:'doubao-seedance-2-0-fast-260128',first_frame:'asset://asset-portrait-test',duration:4,resolution:'480p',generate_audio:false,...extra});
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

test('video catalog preserves the low-level schemas and exposes nonblocking wait semantics',()=>{
  const definitions=videoToolDefinitions();assert.deepEqual(definitions.map(d=>d[0]),VIDEO_TOOL_NAMES);
  assert.equal(definitions.find(d=>d[0]==='video_submit')[2].output_dir.required,undefined);
  assert.match(definitions.find(d=>d[0]==='video_wait')[1],/让出执行位置/);
  assert.equal(definitions.find(d=>d[0]==='video_submit')[2].config.properties.reference_images.type,'array');
  for(const name of ['video_validate','video_submit']){
    const config=definitions.find(d=>d[0]===name)[2].config.properties;
    assert.equal(config.first_frame.type,'string');assert.match(config.first_frame.description,/asset/);
    assert.equal(config.watermark.type,'boolean');assert.equal(config.return_last_frame.type,'boolean');
  }
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
  const f=fixture(t),folder=join(f.home,'materials');mkdirSync(folder);writeFileSync(join(folder,'config.json'),JSON.stringify({prompt:'x',reference_images:['image.png']}));
  const result=await f.execute('video_validate',{config_path:'../materials/config.json'});
  assert.equal(result.status,'validated');assert.deepEqual(f.calls[0].args.config.reference_images,[join(folder,'image.png')]);assert.equal(f.calls[0].args.config_path,undefined);
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
  writeFileSync(join(root,'tools/video/tool.py'),"import json, os, signal, sys, time\njson.load(sys.stdin)\ndef stop(signum, frame):\n    time.sleep(0.05)\n    sys.exit(0)\nsignal.signal(signal.SIGTERM, stop)\nwith open('pid', 'w') as f:\n    time.sleep(0.05)\n    f.write(str(os.getpid()))\nsys.stderr.write('test-secret private provider details')\nsys.stderr.flush()\ntime.sleep(60)\n");
  let child,closed=false;
  const transport=createVideoTransport({root,python:'python3.11',spawn:(...args)=>{child=spawn(...args);child.once('close',()=>{closed=true;});return child;}}),controller=new AbortController();
  const result=transport({name:'video_validate',args:{config:{prompt:'x'}},workspace:root,credential:'test-secret',signal:controller.signal});
  t.after(()=>{if(!closed)controller.abort();});
  const pid=child.pid;assert.ok(Number.isSafeInteger(pid)&&pid>0);
  // File creation precedes the PID write. Number('') is 0, which would probe
  // our own process group instead of the Python child on a loaded test runner.
  const ready=()=>existsSync(join(root,'pid'))&&readFileSync(join(root,'pid'),'utf8').trim()===String(pid);
  const deadline=Date.now()+5000;while(!ready()&&Date.now()<deadline)await delay(10);
  assert.equal(ready(),true);assert.equal(closed,false);controller.abort();
  await assert.rejects(result,error=>error.message==='video_cancelled');assert.equal(closed,true,'transport must await child close, including its delayed SIGTERM handler');
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
});

test('asset first-frame inputs are rejected before credentials, transport or durable submission records',async t=>{
  let credentials=0;const f=fixture(t,{credential:()=>{credentials++;return 'test-secret';}});
  const invalid=[
    ...['portrait.png','https://example.com/portrait.png','data:image/png;base64,YQ==','asset://asset-','asset://asset-valid?signature=secret','asset://asset-valid/extra','asset://asset-valid#fragment','asset://asset-valid\n','asset://asset-'+('a'.repeat(250))].map(first_frame=>portraitConfig({first_frame})),
    ...[undefined,'','   '].map(model=>{const config=portraitConfig({model});if(model===undefined)delete config.model;return config;}),
    portraitConfig({reference_images:['portrait.png']}),portraitConfig({reference_videos:['motion.mp4']}),portraitConfig({omni_reference_task_type:'reference'}),
    portraitConfig({watermark:'true'}),portraitConfig({return_last_frame:1}),
    portraitConfig({duration:16}),portraitConfig({resolution:'1080p'}),
    portraitConfig({model:'doubao-seedance-2-5-260628',ratio:'9:16'}),
  ];
  for(const name of ['video_validate','video_submit'])for(const config of invalid){
    await assert.rejects(f.execute(name,{config}),/invalid_video_arguments/);
  }
  const path=join(f.workspace,'invalid-portrait.json');writeFileSync(path,JSON.stringify(portraitConfig({reference_images:['portrait.png']})));
  await assert.rejects(f.execute('video_submit',{config_path:path}),/invalid_video_arguments/);
  assert.equal(credentials,0);assert.equal(f.calls.length,0);assert.equal(f.service.view(f.task.id).records.length,0);
  assert.equal(f.ops.db.prepare('SELECT count(*) AS count FROM task_video_action').get().count,0);
});

test('asset URIs survive config files and results without local-path resolution',async t=>{
  const calls=[];const f=fixture(t,{transport:async call=>{
    calls.push(call);return {status:'validated',generation_mode:'first_frame',first_frame:call.args.config.first_frame,asset_validation:'not_checked'};
  }});
  const folder=join(f.home,'materials');mkdirSync(folder);
  const config=portraitConfig({ratio:'9:16',watermark:true,return_last_frame:true,reference_images:[],reference_videos:[]});
  writeFileSync(join(folder,'portrait.json'),JSON.stringify(config));
  const result=await f.execute('video_validate',{config_path:'../materials/portrait.json'});
  assert.deepEqual(calls[0].args.config,config);assert.equal(calls[0].args.config_path,undefined);
  assert.equal(calls[0].credential,'');assert.equal(result.first_frame,config.first_frame);
  assert.equal(result.generation_mode,'first_frame');assert.equal(result.asset_validation,'not_checked');
  assert.equal(f.service.evidence(f.task.id,f.run.id)[0].result.asset_validation,'not_checked');
  const inline=await f.execute('video_validate',{config},'inline');
  assert.equal(inline.first_frame,config.first_frame);assert.deepEqual(calls[1].args.config,config);
});

test('first-frame model defaults remain provider-aware and endpoint IDs are not guessed',async t=>{
  const f=fixture(t);
  for(const [index,config] of [
    portraitConfig({duration:15,resolution:'720p',ratio:'9:16'}),
    portraitConfig({model:'doubao-seedance-2-0-260128',resolution:'1080p'}),
    portraitConfig({model:'doubao-seedance-2-5-260628',duration:30,resolution:'1080p'}),
    portraitConfig({model:'ep-user-endpoint',duration:30,resolution:'1080p',ratio:'16:9'}),
  ].entries())assert.equal((await f.execute('video_validate',{config},'model-'+index)).status,'validated');
  assert.equal(f.calls.length,4);
  assert.equal(f.calls[2].args.config.ratio,undefined,'Python applies adaptive when the first-frame ratio is omitted');
});

test('asset first-frame submissions retain idempotency across restart and distinct asset identities',async t=>{
  const f=fixture(t),config=portraitConfig({watermark:true,return_last_frame:true});
  const first=await f.execute('video_submit',{config});
  assert.equal(f.calls[0].args.config.first_frame,config.first_frame);
  const duplicate=await f.execute('video_submit',{config},'repeat');
  assert.equal(duplicate.alreadySubmitted,true);assert.equal(duplicate.videoRecordId,first.videoRecordId);assert.equal(f.calls.length,1);
  await f.service.close();const restored=new VideoService(f.config);f.instances.push(restored);
  const replay=await restored.execute({taskId:f.task.id,runId:f.run.id,stepId:'after-restart',name:'video_submit',args:{config}});
  assert.equal(replay.alreadySubmitted,true);assert.equal(replay.task_id,first.task_id);assert.equal(f.calls.length,1);
  const other=await restored.execute({taskId:f.task.id,runId:f.run.id,stepId:'other-asset',name:'video_submit',args:{config:portraitConfig({first_frame:'asset://asset-other'})}});
  assert.notEqual(other.output_dir,first.output_dir);assert.equal(f.calls.length,2);
});

test('first-frame support follows the pinned schema instead of upgrading an older video run',async t=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-first-frame-pins-')));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const current=JSON.parse(readFileSync(join(ROOT,'tools/video/tool-definitions.json'),'utf8'));
  const legacy=structuredClone(current);
  for(const item of legacy){
    const config=item.function.parameters.properties.config;
    if(!config?.properties.prompt)continue;
    for(const field of ['first_frame','watermark','return_last_frame'])delete config.properties[field];
    delete config.allOf;
  }
  const snapshot=(definitions)=>archiveBundle(home,{name:'video-production',description:'Pinned portrait test',content:'Use the pinned video executor.',source:'bundled',files:new Map([
    ['skills/video-production/SKILL.md',Buffer.from(skillDocument('video-production','Pinned portrait test','Use the pinned video executor.'))],
    ['tools/video/tool-definitions.json',Buffer.from(JSON.stringify(definitions))],
    ['tools/video/tool.py',Buffer.from('import json, sys\nr=json.load(sys.stdin)\nc=r["config"]\nprint(json.dumps({"ok":True,"result":{"status":"validated","generation_mode":"first_frame" if "first_frame" in c else "text","first_frame":c.get("first_frame")}}))\n')],
  ])});
  const old=snapshot(legacy),next=snapshot(current),f=fixture(t,{transport:createVideoTransport({root:ROOT,python:'python3.11'})});
  f.run.skills=[old];
  await assert.rejects(f.execute('video_validate',{config:portraitConfig()}),/invalid_video_arguments/);
  assert.equal((await f.execute('video_validate',{config:{prompt:'An old text job.'}},'old-text')).generation_mode,'text');
  f.run.skills=[next];
  const result=await f.execute('video_validate',{config:portraitConfig()},'new-frame');
  assert.equal(result.generation_mode,'first_frame');assert.equal(result.first_frame,'asset://asset-portrait-test');
});

test('real Python asset first-frame validation is offline and preserves explicit provider switches',async t=>{
  const f=fixture(t,{credential:()=>{throw Error('offline validation must not read credentials');},transport:createVideoTransport({root:ROOT,python:'python3.11'})});
  const result=await f.execute('video_validate',{config:portraitConfig({watermark:true,return_last_frame:true})});
  assert.equal(result.status,'validated');assert.equal(result.generation_mode,'first_frame');assert.equal(result.first_frame,'asset://asset-portrait-test');
  assert.equal(result.asset_validation,'not_checked');assert.equal(result.settings.ratio,'adaptive');
  assert.equal(result.settings.watermark,true);assert.equal(result.settings.return_last_frame,true);
  assert.equal(f.service.view(f.task.id).records.length,0);
});

for(const model of ['minimax-h3-spark','minimax-h3-veda'])test(`${model} resolves local inputs and follows its owned job without Ark credentials`,async t=>{
  const f=fixture(t,{credential:()=>{throw Error('unexpected Ark credential lookup');}});
  const directory=join(f.workspace,'shot');mkdirSync(directory);
  const config={model,first_frame_path:'tape.png',prompt:'Turn and return',duration:4};
  writeFileSync(join(directory,'config.json'),JSON.stringify(config));
  const job=await f.execute('video_submit',{config_path:'shot/config.json'});
  assert.equal(f.calls[0].args.config.first_frame_path,join(directory,'tape.png'));
  assert.equal(f.calls[0].credential,'');assert.equal(job.task_id,'remote-1');
  assert.equal(f.service.view(f.task.id).records[0].provider,model);
  const otherModel=model==='minimax-h3-spark'?'minimax-h3-veda':'minimax-h3-spark';
  await assert.rejects(f.execute('video_submit',{config:{...config,model:otherModel},output_dir:job.output_dir},'same-dir'),/video_output_provider_mismatch/);
  await f.execute('video_wait',{output_dir:job.output_dir},'wait');
  f.waiting();f.advance(1100);await f.service.tick();
  assert.deepEqual(f.calls.map(c=>c.name),['video_submit','video_status','video_status']);
  assert.ok(f.calls.every(c=>c.credential===''));
  f.task.status=f.run.status='running';
  await assert.rejects(f.execute('video_submit',{config:{...config,first_frame:'asset://asset-id'}},'bad-mix'),/invalid_video_arguments/);
  await assert.rejects(f.execute('video_submit',{config:{...config,model:'ark-model',seed:1101}},'bad-provider'),/invalid_video_arguments/);
});


test('Veda validation works in the bundled executor and requires a Veda-capable snapshot',async t=>{
  const f=fixture(t,{transport:createVideoTransport({root:ROOT,python:'python3.11'}),credential:()=>{throw Error('offline validation');}});
  const bundle=captureBundle(join(ROOT,'skills/video-production'),{root:ROOT,source:'bundled'});
  f.run.skills=[archiveBundle(f.home,bundle)];
  const config={model:'minimax-h3-veda',prompt:'Turn and return.',first_frame_path:'image.png'};
  writeFileSync(join(f.workspace,'image.png'),Buffer.from('89504e470d0a1a0a','hex'));
  const result=await f.execute('video_validate',{config});
  assert.equal(result.settings.model,'minimax-h3-veda');assert.equal(result.settings.generated_sparsity,'90%');
  assert.equal(result.settings.frames,107);assert.equal(result.first_frame,join(f.workspace,'image.png'));
  await assert.rejects(f.execute('video_submit',{config:{...config,duration:16}},'long'),/invalid_video_arguments/);
  f.run.skills.push('aesthetic-video-workflow');
  const seedance=await f.execute('video_validate',{config:{prompt:'Blink.',first_frame:'asset://asset-example'}},'real-default');
  assert.equal(seedance.settings.model,'doubao-seedance-2-0-fast-260128');assert.equal(seedance.generation_mode,'first_frame');
  const definitions=JSON.parse(bundle.files.get('tools/video/tool-definitions.json'));
  for(const {function:tool} of definitions){
    const shape=tool.parameters.properties.config;
    if(!shape?.properties.prompt)continue;
    const [asset,spark]=shape.allOf;
    spark.if.properties.model={const:'minimax-h3-spark'};
    shape.allOf=[asset,spark];
  }
  bundle.files.set('tools/video/tool-definitions.json',Buffer.from(JSON.stringify(definitions)));
  f.run.skills=[archiveBundle(f.home,bundle),'aesthetic-video-workflow'];
  await assert.rejects(f.execute('video_submit',{config:{prompt:'Blink.',first_frame:'asset://asset-original'}},'old-default'),/invalid_video_arguments/);
  await assert.rejects(f.execute('video_submit',{config},'unsupported-veda'),/invalid_video_arguments/);
  assert.equal(f.service.view(f.task.id).records.length,0);
});


test('aesthetic runs default inline and file configs to Seedance and preserve an explicit Veda selection',async t=>{
  let keyReads=0;
  const f=fixture(t,{credential:()=>{keyReads++;return 'ark-test';}});
  const config={prompt:'Face the camera.',first_frame:'asset://asset-test',duration:4};
  await assert.rejects(f.execute('video_validate',{config},'generic-no-model'),/invalid_video_arguments/);
  f.run.skills.push({name:'aesthetic-video-workflow'});
  await f.execute('video_validate',{config},'workflow-validation');
  const seedance='doubao-seedance-2-0-fast-260128';
  assert.equal(f.calls[0].args.config.model,seedance);assert.equal(keyReads,0);
  writeFileSync(join(f.workspace,'shot.json'),JSON.stringify(config));
  const shot=await f.execute('video_submit',{config_path:'shot.json'},'workflow-submit');
  assert.equal(f.calls.at(-1).args.config.model,seedance);assert.equal(f.calls.at(-1).credential,'ark-test');assert.equal(keyReads,1);
  assert.equal(f.service.view(f.task.id).records[0].provider,'ark');assert.equal(f.service.view(f.task.id).records[0].model,seedance);
  const replay=await f.execute('video_submit',{config:{...config,model:seedance}},'explicit-same-shot');
  assert.equal(replay.task_id,shot.task_id);assert.equal(replay.alreadySubmitted,true);assert.equal(f.calls.length,2);
  await assert.rejects(f.execute('video_submit',{config:{...config,model:''}},'empty-model'),/invalid_video_arguments/);
  const beforeVeda=keyReads;
  const veda=await f.execute('video_submit',{config:{model:'minimax-h3-veda',prompt:config.prompt,first_frame_path:'portrait.png'}},'local-shot');
  assert.notEqual(veda.output_dir,shot.output_dir);assert.equal(f.calls.at(-1).args.config.model,'minimax-h3-veda');
  assert.equal(f.service.view(f.task.id).records[0].provider,'minimax-h3-veda');assert.equal(keyReads,beforeVeda);
});

test('aesthetic edit resolves each source beside the config and enforces a single timeline',async t=>{
  const f=fixture(t), inputs=Object.fromEntries(['template','before','after','wrap','tape','card'].map(key=>[key,key+(key==='card'?'.png':'.mp4')]));
  const config={aesthetic_timeline:{...inputs,source_in_frames:{before:20}},output:'result.mp4',show_ai_badge:true};
  const folder=join(f.workspace,'edit');mkdirSync(folder);
  writeFileSync(join(folder,'plan.json'),JSON.stringify(config));
  for (const [step,args,base] of [
    ['edit-file',{config_path:'edit/plan.json',dry_run:true},folder],
    ['edit-inline',{config,dry_run:true},f.workspace],
  ]){
    await f.execute('video_edit',args,step);
    const sent=f.calls.at(-1).args.config;
    for(const [key,filename] of Object.entries(inputs))assert.equal(sent.aesthetic_timeline[key],join(base,filename));
    assert.equal(sent.output,join(base,'result.mp4'));assert.equal(sent.show_ai_badge,true);
    assert.deepEqual(sent.aesthetic_timeline.source_in_frames,{before:20});
  }
  await assert.rejects(f.execute('video_edit',{config:{...config,clips:[{path:'clip.mp4'}]}},'both'),/invalid_video_arguments/);
  await assert.rejects(f.execute('video_edit',{config:{output:'out.mp4'}},'neither'),/invalid_video_arguments/);
  await assert.rejects(f.execute('video_edit',{config:{...config,show_ai_badge:'false'}},'bad-flag'),/invalid_video_arguments/);
});

test('video_generate follows one Spark job through restart, retries its download and delivers a verified preview',async t=>{
  const calls=[],deliveries=[],bytes=Buffer.from('fixture video bytes');
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const f=fixture(t,{credential:()=>{throw Error('Spark must not read Ark credentials');},onReady:async record=>{deliveries.push(record);return true;},transport:async call=>{
    calls.push(call);assert.equal(call.name,'video_generate');assert.equal(call.args.timeout_seconds,0);
    if(call.args.config)return {task_id:'veda_fixture',status:'queued'};
    assert.equal(call.args.task_id,'veda_fixture');
    if(calls.length===2)throw Error('download connection interrupted');
    const path=join(call.args.output_dir,call.args.filename);mkdirSync(call.args.output_dir,{recursive:true});writeFileSync(path,bytes);
    return {task_id:'veda_fixture',status:'succeeded',path,size_bytes:bytes.length,sha256,metadata:{duration:4}};
  }});
  const frame=join(f.workspace,'frame.png');writeFileSync(frame,'fixture first frame');
  const args={config:{model:'minimax-h3-veda',prompt:'Blink.',first_frame_path:'frame.png',duration:4},filename:'shot.mp4'};
  const pending=await f.execute('video_generate',args);
  assert.equal(pending.waitingForVideo,true);assert.equal(calls[0].args.config.first_frame_path,frame);
  assert.deepEqual(await f.execute('video_generate',args),pending);assert.equal(calls.length,1);
  await assert.rejects(f.execute('video_generate',{...args,filename:'other.mp4'},'other-name'),/video_output_config_conflict/);
  writeFileSync(frame,'different frame at the same path');
  await assert.rejects(f.execute('video_generate',args,'replaced-frame'),/video_output_config_conflict/);
  f.waiting();await f.service.close();
  const restored=new VideoService(f.config);f.instances.push(restored);f.advance(1001);await restored.tick();
  assert.equal(restored.view(f.task.id).records[0].following,true);assert.equal(deliveries.length,0);
  f.advance(1001);await restored.tick();f.advance(1001);await restored.tick();
  assert.equal(calls.length,3);assert.equal(deliveries.length,1);
  const {artifact,id}=deliveries[0];assert.equal(artifact.sha256,sha256);assert.equal(artifact.name,'shot.mp4');
  assert.equal(restored.evidence(f.task.id,f.run.id)[0].result.path,artifact.path);
  assert.equal(restored.artifacts(f.task.id)[0].size,bytes.length);
  assert.deepEqual((await restored.preview(f.task.id,id)).bytes,bytes);
  await assert.rejects(restored.preview('other-task',id),/video_task_not_owned/);
  writeFileSync(artifact.path,Buffer.alloc(bytes.length));
  await assert.rejects(restored.preview(f.task.id,id),/video_artifact_changed/);
});

test('video_generate can adopt a submitted Seedance job or check once without starting a background wait',async t=>{
  const calls=[],f=fixture(t,{transport:async call=>{calls.push(call);return {task_id:'ark-1',status:'running'};}});
  const submitted=await f.execute('video_submit',{config:portraitConfig()});
  const result=await f.execute('video_generate',{task_id:submitted.task_id,timeout_seconds:0},'single-check');
  assert.equal(result.waitingForVideo,undefined);assert.equal(result.task_id,'ark-1');
  assert.equal(calls[1].credential,'test-secret');assert.equal(calls[1].args.config,undefined);
  assert.equal(f.service.view(f.task.id).records[0].following,false);
  await assert.rejects(f.execute('video_generate',{task_id:'another-job'},'foreign'),/video_task_not_owned/);
  await assert.rejects(f.execute('video_generate',{config:portraitConfig(),task_id:'ark-1'},'mixed'),/invalid_video_arguments/);
});

test('current catalog exposes text and strict first-frame modes on both providers',async t=>{
  const f=fixture(t,{transport:createVideoTransport({root:ROOT,python:'python3.11'})});
  writeFileSync(join(f.workspace,'frame.png'),Buffer.from('89504e470d0a1a0a','hex'));
  for(const model of ['doubao-seedance-2-0-fast-260128','minimax-h3-veda']){
    for(const frame of [false,true]){
      const config={model,prompt:'A slow turn',duration:frame?4:6,...frame?{first_frame_path:'frame.png'}:{}};
      const result=await f.execute('video_validate',{config},model+'-'+frame);
      assert.equal(result.generation_mode,frame?'first_frame':'text');
    }
  }
});

test('the Spark gateway accepts 4 through 15 seconds for text and first-frame H3 requests',async t=>{
  const f=fixture(t,{credential:()=>{throw Error('unexpected Ark credentials');}});
  writeFileSync(join(f.workspace,'frame.png'),Buffer.from('89504e470d0a1a0a','hex'));
  const statuses={video_validate:'validated',video_submit:'submitted',video_generate:'running'};
  for(const [name,status] of Object.entries(statuses)){
    for(const frame of [false,true]){
      const config={model:'minimax-h3-veda',prompt:'Ripples.'};
      if(frame)config.first_frame_path='frame.png';
      for(let duration=4;duration<=15;duration++){
        const step=name+'-'+frame+'-'+duration;
        const args={config:{...config,duration}};
        if(name!=='video_validate')args.output_dir=step;
        if(name==='video_generate')args.timeout_seconds=0;
        const result=await f.execute(name,args,step);
        assert.equal(result.status,status);
        assert.equal(f.calls.at(-1).args.config.duration,duration);
      }
      for(const duration of [3,16,4.5]){
        await assert.rejects(f.execute(name,{config:{...config,duration}},'invalid-duration'),/invalid_video_arguments/);
      }
    }
  }
  const p2={model:'minimax-h3-spark',prompt:'Ripples.',first_frame_path:'frame.png'};
  assert.equal((await f.execute('video_validate',{config:{...p2,duration:5}},'p2-five')).status,'validated');
  await assert.rejects(f.execute('video_validate',{config:{...p2,duration:7}},'p2-seven'),/invalid_video_arguments/);
  await assert.rejects(f.execute('video_validate',{config:{model:p2.model,prompt:p2.prompt}},'p2-text'),/invalid_video_arguments/);
});

test('a frozen H3 catalog retains its text and first-frame durations after a gateway upgrade',async t=>{
  const f=fixture(t),bundle=captureBundle(join(ROOT,'skills/video-production'),{root:ROOT,source:'bundled'});
  const definitions=JSON.parse(bundle.files.get('tools/video/tool-definitions.json'));
  for(const {function:tool} of definitions){
    const rule=tool.parameters.properties.config?.allOf?.find(item=>item.if?.properties?.model?.const==='minimax-h3-veda');
    if(rule)rule.then={properties:{duration:{enum:[4,6]}},if:{required:['first_frame_path']},then:{properties:{duration:{const:4}}}};
  }
  bundle.files.set('tools/video/tool-definitions.json',Buffer.from(JSON.stringify(definitions)));
  f.run.skills=[archiveBundle(f.home,bundle)];
  const text={model:'minimax-h3-veda',prompt:'Ripples.'},frame={...text,first_frame_path:'frame.png'};
  assert.equal((await f.execute('video_validate',{config:{...text,duration:6}},'text-six')).status,'validated');
  assert.equal((await f.execute('video_validate',{config:{...frame,duration:4}},'frame-four')).status,'validated');
  await assert.rejects(f.execute('video_submit',{config:{...text,duration:5}},'text-five'),/invalid_video_arguments/);
  await assert.rejects(f.execute('video_generate',{config:{...frame,duration:6}},'frame-six'),/invalid_video_arguments/);
  assert.equal(f.calls.length,2);
});

test('a confirmed pre-submission validation failure leaves a usable output directory',async t=>{
  const f=fixture(t,{transport:createVideoTransport({root:ROOT,python:'python3.11'})});
  writeFileSync(join(f.workspace,'bad.png'),'not an image');
  const args={config:{model:'minimax-h3-veda',prompt:'Turn.',first_frame_path:'bad.png'},output_dir:'one-shot'};
  const result=await f.execute('video_generate',args);
  assert.equal(result.status,'failed');assert.match(result.error,/PNG or JPEG/);
  assert.equal(f.service.view(f.task.id).records.length,0);
  assert.equal(existsSync(join(f.workspace,'one-shot','task.json')),false);
});

test('a new step can replay a completed Seedance file after its credentials are removed',async t=>{
  let key='enabled',queries=0;
  const bytes=Buffer.from('saved clip'),sha256=createHash('sha256').update(bytes).digest('hex');
  const f=fixture(t,{credential:()=>key,transport:async({args,credential})=>{
    queries++;const path=join(args.output_dir,args.filename);mkdirSync(args.output_dir,{recursive:true});
    if(args.config){assert.equal(credential,'enabled');writeFileSync(path,bytes);}
    else{assert.equal(credential,'');assert.equal(args.task_id,'cached-ark-job');}
    return {status:'succeeded',task_id:'cached-ark-job',path,size_bytes:bytes.length,sha256};
  }});
  const result=await f.execute('video_generate',{config:portraitConfig()});
  key=null;
  const replay=await f.execute('video_generate',{task_id:result.task_id},'resume-asset');
  assert.equal(replay.sha256,result.sha256);assert.equal(replay.status,'succeeded');assert.equal(queries,2);
});
