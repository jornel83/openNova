import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ROOT} from '../../runtime/sources.mjs';
import {installedImagePython} from '../images/runtime.mjs';
import {lifecycleHost} from './fixtures/lifecycle-host.mjs';

const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";

async function offlineMediaHost(t){
  const hostEnv={};
  const f=await lifecycleHost(t,{hostEnv});
  const bundled=installedImagePython(),legacy=join(ROOT,'output/image/runtime/ark-py311/bin/python');
  const python=process.env.OPENNOVA_IMAGE_PYTHON||(existsSync(bundled)?bundled:existsSync(legacy)?legacy:'python3.11');
  const shim=join(f.home,'python-offline'),fixture=join(ROOT,'services/bot/tests/fixtures/image-generation-offline.py');
  writeFileSync(shim,'#!/bin/sh\nif [ -n "${OPENNOVA_IMAGE_ARK_KEY_FILE-}" ]; then\ncase "$3" in */tools/image/tool.py) exec '+quote(python)+' -I -B '+quote(fixture)+' "$@";; esac\nfi\nexec '+quote(python)+' "$@"\n',{mode:0o700});
  const keyFile=join(f.home,'offline.key');writeFileSync(keyFile,'test-only-offline-key\n',{mode:0o600});
  Object.assign(hostEnv,{OPENNOVA_IMAGE_PYTHON:shim,OPENNOVA_IMAGE_ARK_KEY_FILE:keyFile});
  return f;
}

test('foreground /ask creates and edits a project image through the real Python worker, then reopens both versions after restart',{timeout:120000},async t=>{
  const f=await offlineMediaHost(t);
  const run=await f.start();
  const cwd=join(realpathSync(f.home),'言昕 素材');mkdirSync(cwd);
  const project=(await f.api('/project-action',{action:'create',actionId:'new-image-project',name:'言昕图片',directory:cwd})).result;
  let state=(await f.api('/projects')).state;
  await f.api('/project-action',{action:'select',actionId:'select-image-project',projectId:project.id,focus:'work',revision:state.revision});
  const getRows=async()=>(await f.api('/operations')).filter(r=>r.operation==='image_generate');
  const row=async id=>(await getRows()).find(r=>r.requestId===id);
  const firstText={mode:'create',prompt:'元气满满',outputPath:'元气_v1.png'};
  await f.foreground('first-image','image_generate',firstText);
  const first=await row('first-image');assert.equal(first?.status,'completed',JSON.stringify(first));
  assert.equal(first.artifact.projectId,project.id);assert.equal(first.artifact.path,join(cwd,firstText.outputPath));
  assert.equal(first.generation.requestId,'offline-create');
  assert.equal(first.file.sha256,hash(first.file.path));
  assert.equal((await f.api('/snapshot')).workContext.file.imageOperationId,first.id);
  const followup={mode:'edit',prompt:'换白色圆领无帽卫衣',width:1024,height:512,outputPath:'元气_v2.png'};
  await f.foreground('edited-image','image_generate',followup);
  const second=await row('edited-image');assert.equal(second?.status,'completed',JSON.stringify(second));
  assert.equal(second.artifact.projectId,project.id);
  assert.equal(second.generation.requestId,'offline-edit');assert.equal(second.artifact.width,1024);assert.equal(second.artifact.height,512);
  assert.deepEqual(second.inputs.map(i=>[i.path,i.sha256]),[[first.file.path,first.file.sha256]]);
  assert.equal(first.artifact.sha256,hash(first.file.path));assert.notEqual(first.artifact.sha256,second.artifact.sha256);
  assert.equal((await f.api('/snapshot')).workContext.file.imageOperationId,second.id);
  await f.stop();
  assert.equal((await f.start()).botId,run.botId);
  const snap=await f.api('/snapshot');assert.equal(snap.workContext.file.imageOperationId,second.id);
  state=(await f.api('/projects')).state;
  for(const v of [first,second]){
    await f.api('/image-select',{operationId:v.id,expectedProject:{projectId:state.projectId,revision:state.revision}});
    assert.equal((await f.api('/snapshot')).workContext.file.path,v.file.path);
    assert.equal(hash(v.file.path),v.artifact.sha256);
  }
  assert.equal((await f.api('/ask',{id:'first-image',source:'voice',text:'lifecycle:'+JSON.stringify({name:'image_generate',arguments:firstText})})).duplicate,true);
  assert.equal((await getRows()).length,2);
});

test('foreground /ask animates the selected image, resumes the same Seedance task after restart, and serves all three saved results',{timeout:120000},async t=>{
  if(['ffmpeg','ffprobe'].some(binary=>spawnSync(binary,['-version'],{stdio:'ignore'}).status!==0)){
    t.skip('FFmpeg and ffprobe are required');
    return;
  }
  const f=await offlineMediaHost(t);
  const video=join(f.home,'video-fixture.mp4');
  const encoded=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i',
    'testsrc2=size=96x48:rate=24:duration=4','-c:v','libx264','-pix_fmt','yuv420p',video],{encoding:'utf8',timeout:20000});
  assert.equal(encoded.status,0,encoded.stderr);
  await f.start();
  const cwd=realpathSync(f.workspace);
  const project=(await f.api('/project-action',{action:'create',actionId:'create-gif-project',name:'言昕动图',directory:cwd})).result;
  const state=(await f.api('/projects')).state;
  await f.api('/project-action',{action:'select',actionId:'select-gif-project',projectId:project.id,focus:'work',revision:state.revision});
  await f.foreground('gif-source','image_generate',{mode:'create',prompt:'元气满满',outputPath:'元气.png'});
  const selected=(await f.api('/snapshot')).workContext.file;
  assert.equal(selected.path,join(cwd,'元气.png'));
  const sourceDigest=hash(selected.path);
  mkdirSync(join(cwd,'.opennova'));
  writeFileSync(join(cwd,'.opennova/image-characters.json'),JSON.stringify({schemaVersion:1,
    characters:[{id:'approved',name:'确认角色',version:'v1',constraints:['保持角色发型'],references:[{path:'元气.png',sha256:sourceDigest}]}]}));
  const argumentsValue={characterId:'approved',motion:'轻眨眼，然后双拳轻抬回位',outputDir:'元气动态',width:96,height:48};
  await f.foreground('gif-turn','gif_generate',argumentsValue);
  const rows=async()=>(await f.api('/operations')).filter(row=>row.operation==='gif_generate');
  const pending=(await rows())[0];
  assert.equal(pending?.status,'pending',JSON.stringify(pending));
  assert.match(pending.skillVersion,/^[a-f0-9]{64}$/);
  assert.deepEqual(pending.character.references,[{path:selected.path,sha256:sourceDigest}]);
  assert.equal(pending.generation.taskId,'offline-seedance-task');
  const trace=join(f.home,'video-events.jsonl');
  const events=()=>readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  await f.until(()=>events().some(([type])=>type==='query'));
  await f.stop();
  const previousCount=events().length;
  writeFileSync(join(f.home,'video-ready'),'ready');
  await f.start();
  const result=await f.until(async()=>{
    const [record]=await rows();
    return record&&['completed','failed','interrupted','unknown'].includes(record.status)&&record;
  });
  assert.equal(result.status,'completed',JSON.stringify(result));
  assert.equal(result.id,pending.id);
  assert.equal(result.skillVersion,pending.skillVersion);
  assert.equal(result.character.profileSha256,pending.character.profileSha256);
  assert.equal(result.generation.taskId,pending.generation.taskId);
  assert.equal(result.generation.remoteCalls,1);
  assert.equal(result.firstFrameValidation.scope,'exact_decoded_rgba');
  assert.deepEqual([result.artifact.width,result.artifact.height,result.artifact.frames,result.artifact.durationMs,result.artifact.loop],[96,48,40,4000,0]);
  assert.deepEqual(result.inputs.map(({path,sha256})=>[path,sha256]),[[selected.path,sourceDigest]]);
  assert.deepEqual(events().filter(([type])=>type==='post'),[['post',sourceDigest]]);
  assert.deepEqual(events().slice(previousCount),[['query',pending.generation.taskId],['download',pending.generation.taskId]]);
  const snapshot=await f.api('/snapshot');
  assert.equal(snapshot.workContext.file.path,selected.path);
  const {projectId,revision}=snapshot.projects.state;
  const formats={gif:'image/gif',firstFrame:'image/png',video:'video/mp4'};
  for(const [part,contentType] of Object.entries(formats)){
    const artifact=result.artifacts[part];
    const preview=await f.api('/image-preview',{operationId:result.id,expectedProject:{projectId,revision},artifact:part});
    assert.equal(preview.contentType,contentType);
    assert.equal(createHash('sha256').update(Buffer.from(preview.bytes.data)).digest('hex'),artifact.sha256);
    assert.equal(hash(artifact.path),artifact.sha256);
  }
  assert.equal(hash(result.artifacts.video.path),hash(video));
  const replay=await f.api('/ask',{id:'gif-turn',source:'voice',text:'lifecycle:'+JSON.stringify({name:'gif_generate',arguments:argumentsValue})});
  assert.equal(replay.duplicate,true);
  assert.equal((await rows()).length,1);
  assert.equal(events().filter(([type])=>type==='post').length,1);
  await f.foreground('export-first','media_export',{action:'first_frame',sourcePath:'元气动态/animation.gif',outputPath:'本地导出.png'});
  const exported=(await f.api('/operations')).find(r=>r.requestId==='export-first'&&r.operation==='media_export');
  assert.equal(exported?.status,'completed',JSON.stringify(exported));
  assert.equal(exported.generation.remoteCalls,0);
  assert.equal(hash(exported.artifact.path),result.artifacts.firstFrame.sha256);
  const other=join(realpathSync(f.home),'other');mkdirSync(other);
  const outsider=(await f.api('/project-action',{action:'create',actionId:'create-other-role-test',name:'隔离项目',directory:other})).result;
  const before=(await f.api('/projects')).state;
  await f.api('/project-action',{action:'select',actionId:'select-other-role-test',projectId:outsider.id,focus:'work',revision:before.revision});
  await f.foreground('wrong-project-image','image_generate',{characterId:'approved',mode:'edit',prompt:'沿用此角色',outputPath:'不应生成.png'});
  const wrong=(await f.api('/operations')).find(r=>r.requestId==='wrong-project-image'&&r.operation==='image_generate');
  assert.equal(wrong?.error,'character_not_in_project');
  assert.equal(events().filter(([type])=>type==='post').length,1);
});
