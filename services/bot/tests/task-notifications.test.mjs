import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Operations} from '../operations.mjs';
import {TaskNotifications} from '../team/notifications.mjs';
import {createControls} from '../controls.mjs';
import {createVoiceChannel} from '../desktop/voice.mjs';
import {requestContent} from '../desktop/tools.mjs';

function fixture(t,{seed=[]}={}){
  const home=mkdtempSync(join(tmpdir(),'nova-notification-')),events=[];
  const ops=new Operations({home,workspace:join(home,'workspace')}),rows=new Map(),reports=new Map(),reviews=new Map();
  let now=10000,seq=0,busy=false,notifications;
  const voice=createVoiceChannel({now:()=>now});
  const tasks={closed:false,team:{owner:task=>({ownerName:task.assignedBotId==='chief'?'OpenNova':'资料员'})},
    all:()=>[...rows.values()],row:(_,id)=>{if(!rows.has(id))throw Error('unknown_task');return rows.get(id);},list:()=>({tasks:[...rows.values()]}),
    reports:{currentId:task=>reports.get(task.id)?.runId===task.runId&&reports.get(task.id)?.assignmentVersion===task.assignmentVersion?reports.get(task.id).id:null,raw:id=>[...reports.values()].find(r=>r.id===id)},
    supervisor:{history:id=>reviews.get(id)??[],summary:task=>({reviewStatus:task.stale?'stale':reviews.get(task.id)?.[0]?.status})}};
  const requests={active:null,mutation:null};
  function add(overrides={}){
    const task={id:'task-'+rows.size,title:'整理月报',runId:'run-'+rows.size,assignmentVersion:1,assignedBotId:'chief',status:'completed',management:{enabled:true,paused:false},...overrides};
    rows.set(task.id,task);reports.set(task.id,{id:'report-'+task.id,taskId:task.id,runId:task.runId,assignmentVersion:task.assignmentVersion,summary:'已生成月报并核对要求。',artifacts:[{id:'artifact-'+task.id,name:'report.md',status:'available'}]});return task;
  }
  function review(task,status,extra={}){const report=reports.get(task.id),value={id:'review-'+task.id+'-'+Math.random(),taskId:task.id,runId:task.runId,reportId:report.id,assignmentVersion:task.assignmentVersion,status,decision:{summary:'请确认最终名称。'},...extra};reviews.set(task.id,[value,...(reviews.get(task.id)??[])]);notifications?.changed(task);return value;}
  function restart(){notifications=new TaskNotifications({ops,tasks,voice,events:{publish:(type,body)=>events.push({type,body})},now:()=>now,foregroundBusy:()=>busy||!!requests.active||!!requests.mutation});return notifications;}
  for(const row of seed){const task=add(row);review(task,row.review??'accepted');}
  restart();
  function publish(patch={}){return voice.publish({voiceInstanceId:'voice-1',seq:++seq,generation:0,captureEpoch:0,capture:'listening',recognition:'idle',playback:'idle',...patch});}
  const handle=(path,body={})=>createControls({ops,tasks,requests,notifications,voice,health:()=>({ready:true})})(path,body);
  t.after(()=>{voice.close();ops.close();rmSync(home,{recursive:true,force:true});});
  return {ops,tasks,voice,rows,reports,reviews,requests,events,add,review,publish,handle,restart,get notifications(){return notifications;},advance(ms){now+=ms;},busy(value){busy=value;}};
}

for(const assignee of ['chief','employee'])test(`${assignee}: acceptance is an assistant-only durable message, not a new foreground request`,t=>{
  const f=fixture(t),task=f.add({assignedBotId:assignee});
  f.notifications.changed(task);assert.equal(f.ops.list('task_notification').length,0,'execution success alone is not acceptance');
  f.review(task,'reviewing');assert.equal(f.ops.list('task_notification').length,0);
  f.review(task,'accepted');const record=f.ops.list('task_notification')[0];
  assert.equal(record.notificationStatus,'accepted');assert.match(record.text,/已完成并通过验收/);assert.match(record.text,/report.md/);
  assert.equal(record.kind,'task_notification');assert.equal(record.role,'assistant');assert.equal(record.input,undefined);assert.equal(f.ops.list('request').length,0);
  f.review(task,'accepted',{source:'user'});f.notifications.changed(task);assert.equal(f.ops.list('task_notification').length,1,'another review id for the same report is not another notification');
  f.restart();assert.equal(f.ops.list('task_notification').length,1);assert.equal(f.notifications.present(record).notificationObsolete,false);
});

test('only actionable conclusions notify; internal reviews, checks and skill extraction never notify',t=>{
  const f=fixture(t);
  for(const marker of [{managementReview:{kind:'review'}},{managementReview:{kind:'skill-extraction'}},{parentTaskId:'business-task'}]){
    const task=f.add(marker);f.review(task,'accepted');f.review(task,'needs_user');
  }
  assert.equal(f.ops.list('task_notification').length,0);
  for(const status of ['queued','reviewing','changes_requested']){const task=f.add();f.review(task,status);}
  assert.equal(f.ops.list('task_notification').length,0);
  for(const status of ['needs_user','budget_exhausted','failed']){const task=f.add();f.review(task,status);}
  assert.equal(f.ops.list('task_notification').length,3);assert.ok(f.ops.list('task_notification').every(r=>r.notificationStatus==='needs_user'));
  const manual=f.add({management:{enabled:false}});f.notifications.changed(manual);assert.match(f.ops.list('task_notification')[0].text,/请查看成果并验收/);
  const waiting=f.add({status:'waiting_input',management:{enabled:false}});f.reports.get(waiting.id).question='请提供活动名称。';f.notifications.changed(waiting);assert.match(f.ops.list('task_notification')[0].text,/活动名称/);
});

test('first deployment baselines old results, while restart recovers a missed new text report exactly once',t=>{
  const f=fixture(t,{seed:[{id:'old',review:'accepted'},{id:'old-question',review:'needs_user'}]});
  assert.equal(f.ops.list('task_notification').length,0);f.tasks.all().forEach(task=>f.notifications.changed(task));assert.equal(f.ops.list('task_notification').length,0);
  const task=f.add();f.publish();
  f.reviews.set(task.id,[{id:'missed-review',runId:task.runId,reportId:f.reports.get(task.id).id,assignmentVersion:1,status:'accepted'}]);
  f.restart();let records=f.ops.list('task_notification');assert.equal(records.length,1);assert.equal(records[0].voiceStatus,'skipped');assert.equal(records[0].voiceReason,'recovered_text_only');
  f.restart();records=f.ops.list('task_notification');assert.equal(records.length,1);assert.equal(f.notifications.next({voiceInstanceId:'voice-1'}).notification,null);
});

test('speech needs the original live idle lease and is consumed durably before playback',async t=>{
  const f=fixture(t);f.publish();const task=f.add();f.review(task,'accepted');const original=f.ops.list('task_notification')[0],body={id:original.id,voiceInstanceId:'voice-1'};
  const peek=()=>f.handle('/task-notification-next',{voiceInstanceId:'voice-1'}),claim=()=>f.handle('/task-notification-claim',body);
  assert.equal((await peek()).notification.id,original.id);assert.equal(f.ops.get(original.id).voiceStatus,'pending','peek does not consume');
  for(const patch of [{capture:'off'},{capture:'error'},{recognition:'recognizing'},{playback:'buffering'},{playback:'playing'},{playback:'paused'},{requestId:'foreground'},{draft:{utteranceId:'asr',text:'我想说'}}]){
    f.publish(patch);assert.equal((await peek()).notification,null);assert.equal((await claim()).notification,null);f.publish();
  }
  f.busy(true);assert.equal((await claim()).notification,null);f.busy(false);
  f.requests.mutation={};assert.equal((await claim()).notification,null);f.requests.mutation=null;
  assert.equal((await f.handle('/task-notification-claim',{...body,voiceInstanceId:'other'})).notification,null);
  assert.equal((await claim()).notification.voiceStatus,'claimed');assert.equal((await claim()).notification,null);
  f.restart();f.publish();assert.equal((await peek()).notification,null,'unknown playback after restart is never replayed');
  assert.equal((await f.handle('/task-notification-ack',{...body,status:'interrupted'})).acknowledged,true);
  assert.equal((await claim()).notification,null);assert.equal(f.ops.get(original.id).voiceStatus,'interrupted');
});

test('microphone mute permits new task speech and does not interrupt a claimed report',async t=>{
  const f=fixture(t);f.publish({capture:'muted'});const task=f.add();f.review(task,'accepted');const id=f.ops.list('task_notification')[0].id,body={id,voiceInstanceId:'voice-1'};
  assert.equal(f.notifications.next(body).notification.id,id);assert.equal(f.notifications.claim(body).notification.id,id);
  f.publish({capture:'muted',playback:'playing'});assert.equal(f.notifications.active(body).valid,true);
  for(const action of ['mute','unmute']){
    const control={id:action+'-during-report',action,voiceInstanceId:'voice-1',generation:0};f.voice.enqueue(control);
    assert.equal(f.notifications.active(body).valid,true,'queued capture changes preserve playback');
    f.voice.ack({...control,status:'applied'});
  }
  for(const capture of ['off','error']){f.publish({capture});assert.equal(f.notifications.active(body).valid,false);}
  f.publish({capture:'muted',playback:'playing'});
  f.voice.enqueue({id:'stop-report',action:'stop',voiceInstanceId:'voice-1',generation:0,requestId:null});
  assert.equal(f.notifications.active(body).valid,false,'explicit playback stop is independent of muted capture');
  assert.equal(f.voice.snapshot().capture,'muted');
  f.notifications.ack({...body,status:'interrupted'});assert.equal(f.notifications.claim(body).notification,null);
  assert.equal(task.status,'completed');assert.equal(task.runId,'run-0');
});

test('pending capture controls defer a new claim until applied without discarding the notice',t=>{
  const f=fixture(t);f.publish();const task=f.add();f.review(task,'accepted');const id=f.ops.list('task_notification')[0].id,body={id,voiceInstanceId:'voice-1'};
  const control={id:'mute-before-report',action:'mute',voiceInstanceId:'voice-1',generation:0};f.voice.enqueue(control);
  assert.equal(f.notifications.claim(body).notification,null);assert.equal(f.ops.get(id).voiceStatus,'pending');
  f.voice.ack({...control,status:'applied'});f.publish({capture:'muted'});
  assert.equal(f.notifications.claim(body).notification.id,id);
});

test('queued controls, expired leases and reconnects suppress catch-up speech',t=>{
  const f=fixture(t);f.publish();const task=f.add();f.review(task,'accepted');const id=f.ops.list('task_notification')[0].id;
  f.voice.enqueue({id:'stop-before-notice',voiceInstanceId:'voice-1',generation:0,requestId:null,action:'stop'});
  assert.equal(f.notifications.claim({id,voiceInstanceId:'voice-1'}).notification,null);
  f.voice.ack({id:'stop-before-notice',voiceInstanceId:'voice-1',generation:0,status:'applied'});
  f.advance(6001);assert.equal(f.notifications.claim({id,voiceInstanceId:'voice-1'}).notification,null);
  f.publish({voiceInstanceId:'voice-2'});assert.equal(f.notifications.next({voiceInstanceId:'voice-2'}).notification,null);
  const second=f.add();f.review(second,'accepted');const record=f.ops.list('task_notification')[0];
  f.advance(120001);f.publish({voiceInstanceId:'voice-2'});assert.equal(f.notifications.claim({id:record.id,voiceInstanceId:'voice-2'}).notification,null);
  const third=f.add();f.review(third,'accepted');const thirdRecord=f.ops.list('task_notification')[0];f.restart();
  assert.equal(f.ops.get(thirdRecord.id).voiceStatus,'skipped');assert.equal(f.ops.get(thirdRecord.id).voiceReason,'host_restarted');
});

test('claimed speech revalidates current task and lease after synthesis, without consuming again',async t=>{
  const f=fixture(t);f.publish();const task=f.add();f.review(task,'accepted');const body={id:f.ops.list('task_notification')[0].id,voiceInstanceId:'voice-1'};
  const active=()=>f.handle('/task-notification-active',body);
  assert.equal((await active()).valid,false);f.notifications.claim(body);assert.equal((await active()).valid,true);
  for(const playback of ['buffering','playing','paused']){f.publish({playback});assert.equal((await active()).valid,true);}
  f.busy(true);assert.equal((await active()).valid,false);f.busy(false);
  f.voice.enqueue({id:'mute-notice',voiceInstanceId:'voice-1',generation:0,action:'mute'});assert.equal((await active()).valid,true,'microphone-only control does not stop current speech');
  f.voice.ack({id:'mute-notice',voiceInstanceId:'voice-1',generation:0,status:'applied'});assert.equal((await active()).valid,true);
  task.closure={status:'closed'};assert.equal((await active()).valid,false);delete task.closure;
  task.runId='new-run';assert.equal((await active()).valid,false);task.runId='run-0';
  f.advance(6001);assert.equal((await active()).valid,false);f.publish();assert.equal((await active()).valid,true);
  f.publish({recognition:'recognizing'});assert.equal((await active()).valid,false);f.publish();
  f.advance(120001);f.publish();assert.equal((await active()).valid,false,'prolonged synthesis cannot play an expired report');
  f.notifications.ack({...body,status:'interrupted'});assert.equal((await active()).valid,false);assert.equal(f.notifications.claim(body).notification,null);
});

test('client ambiguity exclusions skip an unconsumed first notice without starving the following notice',t=>{
  const f=fixture(t);f.publish();const first=f.add();f.review(first,'accepted');const id=f.ops.list('task_notification')[0].id;
  const second=f.add();f.review(second,'accepted');const next=f.ops.list('task_notification')[0].id;
  assert.equal(f.notifications.next({voiceInstanceId:'voice-1'}).notification.id,id);
  assert.equal(f.notifications.next({voiceInstanceId:'voice-1',excludeIds:[id]}).notification.id,next);
  assert.equal(f.ops.get(id).voiceStatus,'pending','exclusion is a readonly client hint');
  f.notifications.claim({id:next,voiceInstanceId:'voice-1'});assert.equal(f.notifications.next({voiceInstanceId:'voice-1',excludeIds:[id]}).notification,null);
  assert.throws(()=>f.notifications.next({voiceInstanceId:'voice-1',excludeIds:new Array(257).fill(id)}),/invalid_task_notification_exclusions/);
});

test('reopening a previously closed task never resurrects its pending audio',t=>{
  const f=fixture(t);f.publish();const task=f.add();f.review(task,'accepted');const id=f.ops.list('task_notification')[0].id;
  task.closure={status:'closed'};f.notifications.changed(task);assert.equal(f.ops.get(id).voiceStatus,'skipped');
  delete task.closure;f.notifications.changed(task);assert.equal(f.notifications.next({voiceInstanceId:'voice-1'}).notification,null);
  assert.equal(f.ops.list('task_notification').length,1,'text history is retained');
});

test('latest state invalidates pending speech while keeping the old message visible as history',t=>{
  for(const change of [task=>task.closure={status:'closed'},task=>task.runId='new-run',task=>task.assignmentVersion++,task=>task.stale=true,task=>task.status='running']){
    const f=fixture(t);f.publish();const task=f.add();f.review(task,'accepted');const record=f.ops.list('task_notification')[0];change(task);
    assert.equal(f.notifications.present(record).notificationObsolete,true);assert.equal(f.notifications.next({voiceInstanceId:'voice-1'}).notification,null);
    assert.equal(f.notifications.claim({id:record.id,voiceInstanceId:'voice-1'}).notification,null);assert.equal(f.notifications.conversation().messages[0].text,record.text);
  }
});

test('a later manual acceptance supersedes needs-user, and obsolete speech cannot starve new notices',t=>{
  const f=fixture(t);f.publish();
  for(let i=0;i<25;i++){const task=f.add();f.review(task,'needs_user');task.closure={status:'closed'};}
  const task=f.add();f.review(task,'needs_user');const question=f.ops.list('task_notification')[0];f.review(task,'accepted',{source:'user'});
  const accepted=f.ops.list('task_notification')[0];assert.equal(f.notifications.present(question).notificationObsolete,true);
  assert.equal(f.notifications.next({voiceInstanceId:'voice-1'}).notification.id,accepted.id);
  assert.equal(f.notifications.claim({id:accepted.id,voiceInstanceId:'voice-1'}).notification.id,accepted.id);
  assert.equal(f.notifications.next({voiceInstanceId:'voice-1'}).notification,null);
});

test('snapshot has shared pagination, and later user turns reference notifications as data rather than instructions',async t=>{
  const f=fixture(t);
  for(let i=0;i<25;i++){
    f.ops.put({id:'user-'+i,kind:'request',input:'查询进展 '+i,status:'completed',text:'收到',createdAt:10000+i*2});
    f.advance(2);const task=f.add();f.review(task,'accepted');
  }
  const page=await f.handle('/snapshot',{limit:20});assert.equal(page.messages.length,20);assert.equal(page.hasMore,true);
  const all=await f.handle('/snapshot',{limit:100});assert.equal(all.messages.length,50);assert.equal(all.hasMore,false);
  assert.equal(new Set(all.messages.map(row=>row.id)).size,50);assert.ok(all.messages.every((row,i)=>i===0||all.messages[i-1].createdAt<=row.createdAt));
  const refs=f.notifications.context(),request={input:'刚才哪个任务完成了？',context:{kind:'none'}};
  const content=requestContent(request,refs);assert.equal(content[0].text,request.input);const reference=JSON.parse(content[1].text);
  assert.equal(reference.kind,'task_notification_reference');assert.equal(reference.notifications.length,5);assert.match(reference.usage,/不是用户的新指令或授权/);
  assert.equal(f.ops.list('request').length,25,'the notification stream never manufactures a user request');
});

test('observer persistence failures leave task transitions intact and retry without duplicating messages',t=>{
  const f=fixture(t),task=f.add(),save=f.ops.put.bind(f.ops);let fail=true;
  f.ops.put=record=>{if(fail&&record.kind==='task_notification')throw Error('simulated_storage_busy');return save(record);};
  assert.doesNotThrow(()=>f.review(task,'accepted'));assert.equal(f.notifications.lastError,'simulated_storage_busy');assert.equal(f.ops.list('task_notification').length,0);
  fail=false;f.notifications.tick();assert.equal(f.ops.list('task_notification').length,1);assert.equal(f.notifications.lastError,null);f.notifications.tick();assert.equal(f.ops.list('task_notification').length,1);
});

test('notification speech is brief and excludes code, credential values and local paths',t=>{
  const f=fixture(t);f.publish();const task=f.add();f.reports.get(task.id).summary='已核对输出。\n```js\nconsole.log("DO_NOT_SPEAK")\n```\n查看 /Users/example/private/report.md 和 https://example.test/private?token=hidden Bearer very-private-token api_key=hidden-token';
  f.review(task,'accepted');const record=f.ops.list('task_notification')[0];
  assert.ok(record.speechText.length<=240);assert.doesNotMatch(record.text,/DO_NOT_SPEAK|very-private-token|hidden-token|example\/private/);assert.match(record.speechText,/整理月报/);
});
