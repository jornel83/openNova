import test from 'node:test';
import assert from 'node:assert/strict';
import {lifecycleHost} from './fixtures/lifecycle-host.mjs';

test('real host reports chief and employee acceptance plus explicit judgment, without waking foreground or reporting internal work',{timeout:120000},async t=>{
  const h=await lifecycleHost(t,{provider:'management-provider.mjs'});const health=await h.start();
  assert.deepEqual(health.taskNotifications,{version:1,text:true,voice:true,problem:null});
  const chief=(await h.api('/team')).chiefBotId,employee=await h.employee();
  for(const [id,assignedBotId,extra] of [['notice-chief',chief,''],['notice-employee',employee.id,''],['notice-judgment',chief,' NEEDS_USER_REVIEW_FIXTURE']]){
    await h.api('/background-task-start',{id,kind:'agent',title:id,assignedBotId,goal:'生成 report.md。REWORK_COMPLETE_MARKER'+extra,workspaceMode:'general',permission:'full',timeoutMs:20000,skillNames:[]});
  }
  const notices=await h.until(async()=>{const snapshot=await h.api('/snapshot');const messages=snapshot.messages.filter(row=>row.kind==='task_notification');return messages.length===3&&messages;},90000);
  assert.deepEqual(notices.map(row=>[row.taskId,row.notificationStatus]).sort(),[['notice-chief','accepted'],['notice-employee','accepted'],['notice-judgment','needs_user']],JSON.stringify(notices));
  assert.ok(notices.every(row=>row.role==='assistant'&&row.input===undefined&&!row.notificationObsolete));
  const snapshot=await h.api('/snapshot');assert.equal(snapshot.messages.filter(row=>row.kind==='request').length,0);assert.equal(snapshot.busy,false);
  assert.equal((await h.api('/task-notification-next',{voiceInstanceId:'not-connected'})).notification,null);
  const judgment=await h.api('/background-task',{id:'notice-judgment'});
  await h.api('/tasks/review',{id:judgment.task.id,runId:judgment.task.runId,reportId:judgment.teamReview.current.id,action:'accept',text:'我确认名称，验收通过。',actionId:'manual-accept-notice'});
  const after=await h.until(async()=>{const value=await h.api('/snapshot');return value.messages.filter(row=>row.kind==='task_notification').length===4&&value;});
  assert.equal(after.messages.find(row=>row.id===notices.find(row=>row.taskId==='notice-judgment').id).notificationObsolete,true);
  assert.equal(after.messages.findLast(row=>row.taskId==='notice-judgment').notificationStatus,'accepted');
  await h.stop();await h.start();const restarted=await h.api('/snapshot');
  assert.equal(restarted.messages.filter(row=>row.kind==='task_notification').length,4);assert.equal(restarted.messages.filter(row=>row.kind==='request').length,0);
});

test('real host can claim task speech with a muted microphone, while explicit stop leaves work and capture unchanged',{timeout:60000},async t=>{
  const h=await lifecycleHost(t,{provider:'management-provider.mjs'});await h.start();
  let seq=0;const voiceInstanceId='muted-notification-client';
  const publish=patch=>h.api('/voice/publish',{voiceInstanceId,seq:++seq,generation:1,captureEpoch:1,capture:'muted',recognition:'idle',playback:'idle',...patch});
  await publish();
  const task=(await h.api('/background-task-start',{id:'muted-task-report',kind:'agent',title:'静音时仍汇报',goal:'生成 report.md。REWORK_COMPLETE_MARKER',workspaceMode:'general',permission:'full',timeoutMs:20000,skillNames:[]})).task;
  const notice=await h.until(async()=>{await publish();return (await h.api('/snapshot')).messages.find(row=>row.kind==='task_notification'&&row.taskId===task.id);});
  assert.equal(notice.notificationStatus,'accepted');assert.equal(notice.voiceStatus,'pending');
  const body={id:notice.id,voiceInstanceId};
  assert.equal((await h.api('/task-notification-next',{voiceInstanceId})).notification.id,notice.id);
  assert.equal((await h.api('/task-notification-claim',body)).notification.id,notice.id);
  await publish({playback:'playing'});assert.equal((await h.api('/task-notification-active',body)).valid,true);
  const mute={id:'independent-mic-mute',action:'mute',voiceInstanceId,generation:1,requestId:null};
  await h.api('/voice-control',mute);assert.equal((await h.api('/task-notification-active',body)).valid,true);
  await h.api('/voice/ack',{...mute,status:'applied'});
  const stop={...mute,id:'explicit-playback-stop',action:'stop'};
  await h.api('/voice-control',stop);assert.equal((await h.api('/task-notification-active',body)).valid,false);
  await h.api('/voice/ack',{...stop,status:'applied'});await publish();
  await h.api('/task-notification-ack',{...body,status:'interrupted'});
  const snapshot=await h.api('/snapshot'),detail=await h.api('/background-task',{id:task.id});
  assert.equal(snapshot.desktop.voice.capture,'muted');assert.equal(detail.task.status,'completed');assert.equal(detail.task.runId,task.runId);assert.equal(detail.runs.length,1);
  assert.equal((await h.api('/task-notification-next',{voiceInstanceId})).notification,null);
  assert.equal(snapshot.messages.filter(row=>row.kind==='request').length,0);
});
