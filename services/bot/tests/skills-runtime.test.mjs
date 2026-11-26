import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {lifecycleHost} from './fixtures/lifecycle-host.mjs';

const plan=(actions,extra={})=>'SKILLS_PLAN='+Buffer.from(JSON.stringify({actions,...extra})).toString('base64');
const startTask=(h,id,member,goal,extra={})=>h.api('/background-task-start',{id,kind:'agent',assignedBotId:member.id,title:'技能集成 '+id,goal,workspaceMode:'general',permission:'full',managementEnabled:false,skillNames:['video-production'],...extra});
async function settle(h,id,status='completed'){
  return h.until(async()=>{
    const detail=await h.api('/background-task',{id});
    if(['failed','interrupted'].includes(detail.task.status))throw Error('skills runtime failed: '+JSON.stringify({task:detail.task.id,status:detail.task.status,result:detail.runs.at(-1)?.result,log:await h.api('/background-task-log',{id}),steps:detail.runs.at(-1)?.jobs}));
    return detail.task.status===status&&detail.task.cleanupConfirmed&&detail;
  },45000);
}
async function ask(h,id,text){
  await h.api('/ask',{id,source:'voice',text});
  const result=await h.until(async()=>{const result=await h.api('/result',{id});return ['completed','failed','cancelled'].includes(result.status)&&result;});
  assert.equal(result.status,'completed',JSON.stringify(result));await h.until(async()=>!(await h.api('/snapshot')).busy);return result;
}
async function assign(h,member){
  const catalog=await h.api('/skills',{botId:member.id});
  await h.foreground('assign-'+member.id,'skill_manage',{action:'assign',botId:member.id,names:['video-production'],revision:catalog.assignment.revision});
  await h.until(async()=>!(await h.api('/snapshot')).busy);
  assert.deepEqual((await h.api('/skills',{botId:member.id})).assignment.names,['video-production']);
}

test('real chief and isolated employee load skills, references, tools and pinned versions across restart',{timeout:120000},async t=>{
  const h=await lifecycleHost(t,{provider:'skills-provider.mjs',foregroundProvider:'skills-provider.mjs'});const health=await h.start();assert.equal(health.team.skills,true);
  const catalog=await h.api('/skills'),video=catalog.skills.find(skill=>skill.name==='video-production');assert.ok(video?.enabled);assert.ok(video.assignedBotIds.includes(health.botId));
  const chief=await ask(h,'chief-load-skill',plan([['skill',{name:'video-production'}]],{requireCatalog:true,requiredTools:['skill','skill_list','skill_manage']}));assert.match(JSON.stringify(chief),/catalog=true/);
  const employee=await h.employee('视频员');await assign(h,employee);
  const goal=plan([
    ['skill',{name:'video-production'}],
    ['read',{file_path:'$RESOURCE/references/tool-contract.md'}],
    ['video_validate',{config:{prompt:'Offline scene',duration:4}}],
    ['task_question',{question:'请继续，验证固定技能版本。'}],
  ],{requireCatalog:true,requiredTools:['skill','video_validate']});
  await startTask(h,'skill-pinned',employee,goal);const first=await settle(h,'skill-pinned','waiting_input');
  assert.deepEqual(first.runs[0].jobs.map(step=>[step.tool,step.status]),[['skill','completed'],['read','completed'],['video_validate','completed'],['task_question','completed']]);
  assert.match(first.runs[0].jobs[1].output,/Tool contract/);assert.match(first.runs[0].jobs[2].output,/validated/);assert.equal(first.skills[0].version,video.version);
  const original=first.skills[0];assert.ok(existsSync(join(original.resourceBase.path,'scripts/video_tool.py')));
  await h.api('/skill-action',{action:'save',actionId:'update-video-skill',name:'video-production',description:'Fixture video skill updated',content:original.content+'\n\nSKILL_VERSION_TWO_MARKER\n',revision:video.revision});
  const changed=(await h.api('/skills')).skills.find(skill=>skill.name==='video-production');assert.notEqual(changed.version,original.version);
  await h.stop();await h.start();
  const loaded=await h.api('/background-task',{id:'skill-pinned'});assert.equal(loaded.skills[0].version,original.version);assert.equal(loaded.runs.length,1);
  const resumedPlan=plan([['skill',{name:'video-production'}],['read',{file_path:'$RESOURCE/references/tool-contract.md'}],['write',{file_path:'result.md',content:'Pinned skill restored.\n'}]],{requireCatalog:true});
  await h.api('/background-task-continue',{id:loaded.task.id,runId:loaded.task.runId,actionId:'continue-pinned-skill',text:resumedPlan});
  const resumed=await settle(h,loaded.task.id);assert.equal(resumed.runs.length,2);assert.equal(resumed.skills[0].version,original.version);assert.equal(resumed.task.sessionId,first.task.sessionId);
  assert.doesNotMatch(resumed.runs[1].jobs.find(step=>step.tool==='skill').output,/SKILL_VERSION_TWO_MARKER/);assert.equal(readFileSync(join(resumed.workspace.path,'result.md'),'utf8'),'Pinned skill restored.\n');
  await startTask(h,'new-skill-version',employee,plan([['skill',{name:'video-production'}],['write',{file_path:'new-version.md',content:'New task uses current skill.\n'}]],{requireCatalog:true}));
  const newer=await settle(h,'new-skill-version');assert.equal(newer.skills[0].version,changed.version);assert.match(newer.runs[0].jobs.find(step=>step.tool==='skill').output,/SKILL_VERSION_TWO_MARKER/);
});

test('real employee video flow releases its slot, survives restart, resumes once and delivers a local artifact',{timeout:120000},async t=>{
  if(spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status!==0){t.skip('FFmpeg unavailable');return;}
  const h=await lifecycleHost(t,{provider:'skills-provider.mjs',videoTransportModule:'skills-video-transport.mjs'});await h.start();const employee=await h.employee('视频验收员');await assign(h,employee);
  await startTask(h,'video-flow',employee,'SKILLS_VIDEO_FLOW 完成离线视频任务，等待同一个远端任务，下载并交付。');
  const waiting=await settle(h,'video-flow','waiting_event');assert.equal(waiting.runs.length,1);assert.equal(waiting.runs[0].progress.awaiting.kind,'video');assert.equal(waiting.video.records.length,1);assert.equal(waiting.video.records[0].remoteTaskId,'offline-remote-1');
  assert.deepEqual(waiting.runs[0].jobs.map(step=>step.tool),['skill','video_validate','video_submit','video_wait']);
  await h.api('/background-task-start',{id:'while-video-waits',title:'等待期间的独立工作',command:'node -e "console.log(42)"'});
  const independent=await settle(h,'while-video-waits');assert.equal(independent.task.exitCode,0);assert.equal((await h.api('/background-task',{id:'video-flow'})).task.status,'waiting_event');
  await h.stop();await h.start();assert.equal((await h.api('/background-task',{id:'video-flow'})).runs.length,1);
  writeFileSync(join(h.home,'video-ready'),'ready\n');const done=await settle(h,'video-flow');
  assert.equal(done.runs.length,2);assert.equal(done.runs[1].instructionSource.kind,'video');assert.equal(done.task.sessionId,waiting.task.sessionId);
  assert.deepEqual(done.runs[1].jobs.map(step=>step.tool),['skill','video_status','video_download','write','task_command']);
  assert.equal(done.runs[1].jobs.at(-1).exitCode,0);assert.ok(existsSync(join(done.workspace.path,'video-fixture/result.mp4')));
  assert.match(readFileSync(join(done.workspace.path,'report.md'),'utf8'),/OFFLINE_VIDEO_DELIVERED/);
  assert.ok(done.video.artifacts.some(artifact=>artifact.name==='result.mp4'));assert.equal(done.video.records[0].following,false);
  const counters=JSON.parse(readFileSync(join(h.home,'video-fixture.json'),'utf8'));assert.equal(counters.posts,1);assert.equal(counters.downloads,1);
  await h.stop();await h.start();const final=await h.api('/background-task',{id:'video-flow'});assert.equal(final.runs.length,2);assert.equal(final.task.status,'completed');
  assert.equal(JSON.parse(readFileSync(join(h.home,'video-fixture.json'),'utf8')).posts,1);
});

test('pausing a waiting video stops follow-up across restart and later remote completion',{timeout:120000},async t=>{
  const h=await lifecycleHost(t,{provider:'skills-provider.mjs',videoTransportModule:'skills-video-transport.mjs'});await h.start();const employee=await h.employee('暂停视频员');await assign(h,employee);
  await startTask(h,'video-pause',employee,'SKILLS_VIDEO_FLOW 等待生成视频，稍后暂停。');
  const waiting=await settle(h,'video-pause','waiting_event');assert.equal(waiting.video.records[0].following,true);
  const paused=await h.api('/background-task-pause',{id:waiting.task.id,runId:waiting.task.runId});
  assert.equal(paused.task.status,'paused');assert.equal(paused.video.records[0].following,false,'pause must stop the receipt before returning');
  assert.equal(paused.video.records[0].localStatus,'stopped');
  await h.stop();await h.start();
  const before=JSON.parse(readFileSync(join(h.home,'video-fixture.json'),'utf8'));
  writeFileSync(join(h.home,'video-ready'),'ready after pause\n');await delay(1400);
  const current=await h.api('/background-task',{id:waiting.task.id}),after=JSON.parse(readFileSync(join(h.home,'video-fixture.json'),'utf8'));
  assert.equal(current.task.status,'paused');assert.equal(current.task.runId,waiting.task.runId);assert.equal(current.runs.length,1);assert.equal(current.video.records[0].following,false);
  assert.equal(after.posts,1);assert.equal(after.queries,before.queries,'a paused job must not keep querying the remote provider');assert.equal(after.downloads??0,0);
});

test('video_generate resumes the same Spark job after restart, downloads once, and exposes its MP4 in the report and preview',{timeout:120000},async t=>{
  if(spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status!==0){t.skip('FFmpeg unavailable');return;}
  const h=await lifecycleHost(t,{provider:'skills-provider.mjs',videoTransportModule:'skills-video-transport.mjs',canonicalHome:true});
  await h.start();
  const employee=await h.employee('本地视频员');await assign(h,employee);
  const id='video-generate-flow';
  await startTask(h,id,employee,'SKILLS_VIDEO_GENERATE 使用本地 Minimax H3 生成 4 秒视频。');
  const waiting=await settle(h,id,'waiting_event');
  assert.deepEqual(waiting.runs[0].jobs.map(step=>step.tool),['video_generate']);
  const [initial]=waiting.video.records;
  assert.equal(waiting.runs[0].progress.awaiting.videoRecordId,initial.id);
  assert.equal(initial.remoteTaskId,'offline-remote-1');assert.equal(initial.following,true);
  const counts=()=>JSON.parse(readFileSync(join(h.home,'video-fixture.json'),'utf8'));
  assert.equal(counts().posts,1);assert.equal(counts().downloads,0);
  await h.stop();await h.start();
  assert.equal((await h.api('/background-task',{id})).task.status,'waiting_event');
  writeFileSync(join(h.home,'video-ready'),'ready after restart\n');
  const done=await settle(h,id);
  assert.equal(done.runs.length,2);assert.equal(done.runs[1].instructionSource.kind,'video');
  assert.deepEqual(done.runs[1].jobs,[]);
  const [record]=done.video.records,artifact=record.artifact,report=done.teamReview.current;
  assert.equal(record.id,initial.id);assert.equal(record.following,false);assert.equal(record.remoteStatus,'succeeded');
  assert.equal(artifact.name,'result.mp4');assert.equal(done.runs[1].eventContext.artifact.sha256,artifact.sha256);
  assert.ok(report.artifacts.some(file=>file.status==='available'&&file.media&&file.sha256===artifact.sha256));
  assert.ok(report.evidence.video.some(entry=>entry.tool==='video_generate'&&entry.result.sha256===artifact.sha256));
  const preview=await h.api('/background-video-preview',{id,recordId:record.id});
  assert.deepEqual(preview,readFileSync(artifact.path));assert.ok(preview.length>1000);
  const counters=counts();assert.equal(counters.posts,1);assert.ok(counters.queries>=1);assert.equal(counters.downloads,1);
});
