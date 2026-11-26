import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ROOT} from '../../runtime/sources.mjs';
import {installedImagePython} from '../images/runtime.mjs';
import {lifecycleHost} from './fixtures/lifecycle-host.mjs';

const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const plan=actions=>'M5_MEDIA_PLAN='+Buffer.from(JSON.stringify(actions)).toString('base64');

test('chief voice delegation archives exact background GIF artifacts after a same-ID restart, even with a different project selected',{timeout:120000},async t=>{
  if(['ffmpeg','ffprobe'].some(bin=>spawnSync(bin,['-version'],{stdio:'ignore'}).status!==0))return t.skip('FFmpeg and ffprobe required');
  const hostEnv={},f=await lifecycleHost(t,{hostEnv,provider:'task-image-media-provider.mjs',nativeFileReaderModule:'task-image-media-reviewer.mjs'});
  const python=process.env.OPENNOVA_IMAGE_PYTHON??installedImagePython();
  const shim=join(f.home,'python-offline'),stub=join(ROOT,'services/bot/tests/fixtures/image-generation-offline.py'),key=join(f.home,'offline-key');
  writeFileSync(key,'test-only-offline-key\n',{mode:0o600});
  writeFileSync(shim,'#!/bin/sh\nif [ -n "${OPENNOVA_IMAGE_ARK_KEY_FILE-}" ]; then\ncase "$3" in */tools/image/tool.py) exec '+quote(python)+' -I -B '+quote(stub)+' "$@";; esac\nfi\nexec '+quote(python)+' "$@"\n',{mode:0o700});
  Object.assign(hostEnv,{OPENNOVA_IMAGE_PYTHON:shim,OPENNOVA_IMAGE_ARK_KEY_FILE:key});
  const video=join(f.home,'video-fixture.mp4');
  const encode=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=96x48:rate=24:duration=4','-c:v','libx264','-pix_fmt','yuv420p',video],{encoding:'utf8',timeout:15000});
  assert.equal(encode.status,0,encode.stderr);
  await f.start();const worker=await f.employee('图片员工'),home=realpathSync(f.home);
  const catalog=await f.api('/skills',{botId:worker.id});
  await f.api('/skill-action',{action:'assign',actionId:'bind-image-skill',botId:worker.id,names:['image-production'],revision:catalog.assignment.revision});
  const A=join(home,'project-A'),B=join(home,'project-B');for(const path of [A,B])mkdirSync(path);
  const make=async(path,label)=>(await f.api('/project-action',{action:'create',actionId:'create-'+label,name:label,directory:path})).result;
  const a=await make(A,'alpha'),b=await make(B,'beta');
  const select=async projectId=>f.api('/project-action',{action:'select',actionId:'select-'+projectId,projectId,focus:'work',revision:(await f.api('/projects')).state.revision});
  await select(a.id);
  await f.foreground('create-signed-fixture','image_generate',{mode:'create',prompt:'元气满满',outputPath:'reference.png'});
  const reference=join(A,'reference.png'),sourceSha=digest(reference);
  mkdirSync(join(A,'.opennova'));
  writeFileSync(join(A,'.opennova/image-characters.json'),JSON.stringify({schemaVersion:1,characters:[
    {id:'yanxin',name:'言昕',version:'accepted-v1',constraints:['保留白色圆领卫衣'],references:[{path:'reference.png',sha256:sourceSha}]},
  ]}));
  const media={operation:'gif_generate',characterIds:['yanxin'],projectInputs:['reference.png'],outputPath:'delivery'};
  const instruction={assignedBotId:worker.id,title:'交付元气满满 GIF',goal:plan([
    ['skill',{name:'image-production'}],
    ['project_media_characters',{}],
    ['gif_generate',{sourcePath:'reference.png',outputDir:'delivery',outputScope:'project',characterId:'yanxin',motion:'轻抬双拳再回位',width:96,height:48}],
  ]),workspaceMode:'general',permission:'full',managementEnabled:false,skillNames:['image-production'],media};
  await f.foreground('chief-delegates-gif','background_agent_start',instruction);
  const list=await f.api('/background-tasks',{allProjects:true});
  const id=list.tasks.find(task=>task.title===instruction.title)?.id;
  assert.ok(id,JSON.stringify(list));
  const detail=()=>f.api('/background-task',{id});
  const settle=async status=>f.until(async()=>{
    const info=await detail();
    if(info.task.status==='failed')throw Error(JSON.stringify({task:info.task,status:info.runs.at(-1)?.status,result:info.runs.at(-1)?.result,steps:info.runs.at(-1)?.jobs}));
    return info.task.status===status&&info.task.cleanupConfirmed&&info;
  },45000);
  const waiting=await settle('waiting_event');
  assert.equal(waiting.task.projectId,a.id);
  assert.equal(waiting.runs[0].progress.awaiting.kind,'media');
  assert.equal(waiting.runs[0].progress.awaiting.remoteTaskId,'offline-seedance-task');
  const trace=join(home,'video-events.jsonl'),events=()=>readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(events().filter(([type])=>type==='post'),[['post',sourceSha]]);
  await f.api('/background-task-start',{id:'independent-job',title:'独立验证',command:'node -e "console.log(7)"'});
  await f.until(async()=>(await f.api('/background-task',{id:'independent-job'})).task.status==='completed');
  await select(b.id);
  await f.foreground('pin-beta-static','image_generate',{mode:'create',prompt:'元气满满',outputPath:'selected.png'});
  const beta=(await f.api('/snapshot')).workContext.file;
  await f.stop();await f.start();
  assert.equal((await detail()).task.status,'waiting_event');
  writeFileSync(join(home,'video-ready'),'ready');
  const completed=await settle('completed');
  assert.equal(completed.runs.length,2);
  assert.equal(completed.task.sessionId,waiting.task.sessionId);
  assert.equal((await f.api('/snapshot')).workContext.file.path,beta.path);
  assert.equal((await f.api('/projects')).state.projectId,b.id);
  const report=completed.teamReview.current;
  assert.equal(report.projectId,a.id);
  assert.deepEqual(report.artifacts.map(file=>file.mediaRole).sort(),['contactSheet','firstFrame','gif','video']);
  for(const file of report.artifacts){
    assert.equal(file.status,'available',JSON.stringify(file));
    assert.equal(digest(file.path),file.sha256);
  }
  const gif=report.artifacts.find(file=>file.mediaRole==='gif');
  assert.equal(gif.sourcePath,join(A,'delivery','animation.gif'));
  assert.equal(report.evidence.media.some(entry=>{
    const record=entry.result??entry;
    return record.visualReview?.status==='partial'&&record.visualReview.sourceSha256===gif.sha256&&
      record.visualReview.checkedFrameIndices.join(',')==='0,39';
  }),true,JSON.stringify(report.evidence.media));
  assert.equal(existsSync(join(B,'delivery')),false);
  assert.equal(digest(reference),sourceSha);
  assert.equal(events().filter(([type])=>type==='post').length,1);
  assert.deepEqual(events().filter(([type])=>type==='download'),[['download','offline-seedance-task']]);
  for(const [type,remoteId] of events())if(type==='query')assert.equal(remoteId,'offline-seedance-task');
  await f.stop();await f.start();assert.equal((await detail()).runs.length,2);
  assert.equal(events().filter(([type])=>type==='post').length,1);
});
