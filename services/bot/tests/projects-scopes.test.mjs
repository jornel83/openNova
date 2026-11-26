import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Operations} from '../operations.mjs';
import {ProjectStore,DEFAULT_PROJECT_ID} from '../projects/store.mjs';
import {ProjectMemory} from '../projects/memory.mjs';
import {createSources} from '../research/sources.mjs';
import {TaskNotifications} from '../team/notifications.mjs';

function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'nova-project-scopes-')),ops=new Operations({home,workspace:join(home,'workspace')}),store=new ProjectStore({ops,home,workspace:ops.workspace});
  const b=store.mutate({action:'create',actionId:'B',name:'B',directory:ops.workspace}).result,projects={store,state:()=>store.state()};let active;
  const memory=new ProjectMemory({ops,projects,getRequest:()=>active,legacyView:()=>({entries:[{text:'LEGACY_MIXED_PRIVATE'}]})});
  t.after(()=>{ops.close();rmSync(home,{recursive:true,force:true});});
  return {ops,store,b,projects,memory,request(id,projectId){active=ops.put({id,kind:'request',input:'用户明确保存的内容',projectId,status:'completed',createdAt:Date.now(),binding:{projectId,focus:projectId?'work':'daily'}});return active;},
    selected(projectId=DEFAULT_PROJECT_ID,focus='work'){store.select({projectId,focus,revision:store.state().revision,actionId:'focus-'+Math.random().toString(36).slice(2)});},get active(){return active;}};
}
const observation=(requestId,excerpt)=>({requestId,callId:'call-'+requestId,provider:'test',url:'https://example.org/same',title:'Source',excerpt,status:'completed',evidenceType:'page_body'});

test('project facts and explicitly personal preferences are separated; legacy mixed memory remains unclassified',t=>{
  const f=fixture(t);f.ops.put({id:'old-memory',kind:'memory',text:'LEGACY_MIXED_PRIVATE'});
  f.request('A',DEFAULT_PROJECT_ID);f.memory.mutate('remember',{text:'A_ONLY_FACT',scope:'own'});f.memory.mutate('remember',{text:'PERSONAL_PREFERENCE',scope:'personal'});
  f.request('B',f.b.id);f.memory.mutate('remember',{text:'B_ONLY_FACT'});
  assert.deepEqual(f.memory.recall().entries.map(r=>r.text).sort(),['B_ONLY_FACT','PERSONAL_PREFERENCE']);
  f.request('daily',null);assert.deepEqual(f.memory.recall().entries.map(r=>r.text),['PERSONAL_PREFERENCE']);
  assert.throws(()=>f.memory.mutate('remember',{text:'Daily story is not a project fact'}),/explicit_personal_memory_scope_required/);
  f.selected(f.b.id,'daily');assert.ok(!JSON.stringify(f.memory.view()).includes('A_ONLY_FACT'));assert.ok(!JSON.stringify(f.memory.view()).includes('LEGACY_MIXED_PRIVATE'));
  assert.equal(f.ops.get('old-memory').text,'LEGACY_MIXED_PRIVATE');
});

test('memory corrections retire only the matching fact in the source request project',t=>{
  const f=fixture(t);f.request('A',DEFAULT_PROJECT_ID);f.memory.mutate('remember',{text:'Same old choice'});
  f.request('B',f.b.id);f.memory.mutate('remember',{text:'Same old choice'});f.selected(DEFAULT_PROJECT_ID);
  f.memory.mutate('remember',{text:'B new choice',replace:'Same old choice'});
  assert.deepEqual(f.memory.recall().entries.map(r=>r.text),['B new choice']);
  f.request('A-return',DEFAULT_PROJECT_ID);assert.deepEqual(f.memory.recall().entries.map(r=>r.text),['Same old choice']);
  f.memory.mutate('forget',{entry:'Same old choice'});assert.deepEqual(f.memory.recall().entries,[]);
  f.request('B-return',f.b.id);assert.deepEqual(f.memory.recall().entries.map(r=>r.text),['B new choice']);
});

test('same URL and same directory still produce different project sources and scope default lookup',t=>{
  const f=fixture(t);let projectId=DEFAULT_PROJECT_ID;const book=createSources({ops:f.ops,botId:'chief',workspace:f.ops.workspace,getProjectId:()=>projectId});
  f.request('A',projectId);const a=book.record(observation('A','A_PRIVATE_EVIDENCE'));
  projectId=f.b.id;f.request('B',projectId);const b=book.record(observation('B','B_PRIVATE_EVIDENCE'));
  assert.notEqual(a.sourceId,b.sourceId);assert.deepEqual(book.lookup().map(r=>r.excerpt),['B_PRIVATE_EVIDENCE']);assert.throws(()=>book.lookup({sourceIds:[a.sourceId]}),/source_not_found/);assert.throws(()=>book.lookup({requestId:'A'}),/project_source_mismatch/);
  projectId=null;f.request('daily',null);assert.deepEqual(book.lookup(),[]);assert.deepEqual(book.resolveUrls(['https://example.org/same']),[]);
  assert.equal(book.forRequest('A')[0].excerpt,'A_PRIVATE_EVIDENCE','explicit historical receipts stay readable by request ID');
});

test('source usage cannot attach A evidence to a B request and then expose it through B lookup',t=>{
  const f=fixture(t);let projectId=DEFAULT_PROJECT_ID;const book=createSources({ops:f.ops,botId:'chief',workspace:f.ops.workspace,getProjectId:()=>projectId});
  f.request('A',projectId);book.record(observation('A','A_PRIVATE_EVIDENCE'));f.request('B',f.b.id);
  assert.throws(()=>book.use('B',book.lookup({requestId:'A'})),/project_source_mismatch/);
  projectId=f.b.id;assert.deepEqual(book.forRequest('B'),[]);assert.deepEqual(book.lookup(),[]);
});

test('pre-project source IDs remain unchanged in historical replies without becoming current project facts',t=>{
  const f=fixture(t),legacy=createSources({ops:f.ops,botId:'chief',workspace:f.ops.workspace});f.ops.put({id:'old-request',kind:'request',input:'mixed historical conversation',status:'completed',createdAt:1});
  const original=legacy.record(observation('old-request','LEGACY_EVIDENCE')),raw=f.ops.get(original.observationId);
  const upgraded=createSources({ops:f.ops,botId:'chief',workspace:f.ops.workspace,getProjectId:()=>DEFAULT_PROJECT_ID});
  assert.equal(upgraded.forRequest('old-request')[0].sourceId,original.sourceId);assert.equal(upgraded.forReply('old-request','[historical evidence](https://example.org/same)')[0].observationId,original.observationId);
  assert.deepEqual(upgraded.lookup(),[]);assert.throws(()=>upgraded.lookup({sourceIds:[original.sourceId]}),/source_not_found/);
  f.request('new-request',DEFAULT_PROJECT_ID);const current=upgraded.record(observation('new-request','CURRENT_PROJECT_EVIDENCE'));
  assert.notEqual(current.sourceId,original.sourceId);assert.deepEqual(f.ops.get(original.observationId),raw);assert.equal(f.ops.request('old-request').projectId,undefined);
});

function notices(t){
  const f=fixture(t),tasksById=new Map(),reports=new Map(),voice={snapshot:()=>({connected:true,voiceInstanceId:'voice-1',capture:'listening',recognition:'idle',playback:'idle',controls:[]})};
  const tasks={closed:false,all:()=>[...tasksById.values()],row:(_kind,id)=>tasksById.get(id),reports:{currentId:task=>reports.get(task.id)?.id,raw:id=>[...reports.values()].find(r=>r.id===id)}};
  const notifications=new TaskNotifications({ops:f.ops,tasks,projects:f.projects,voice,now:()=>10000});
  return {...f,tasks,notifications,add(id,projectId=DEFAULT_PROJECT_ID){const task={id,projectId,title:id,runId:'run-'+id,assignmentVersion:1,status:'completed',management:{enabled:false}};tasksById.set(id,task);reports.set(id,{id:'report-'+id,taskId:id,runId:task.runId,assignmentVersion:1,summary:'Actual result '+id,artifacts:[]});notifications.changed(task);return f.ops.list('task_notification').find(r=>r.taskId===id);},
    focus(projectId=DEFAULT_PROJECT_ID,focus='work'){f.selected(projectId,focus);notifications.focusChanged();}};
}

test('daily and foreign-project results keep labelled text without catch-up speech after returning',t=>{
  const f=notices(t);f.focus(DEFAULT_PROJECT_ID,'daily');const daily=f.add('A-during-story');assert.equal(daily.projectId,DEFAULT_PROJECT_ID);assert.match(daily.text,/OpenNova/);assert.equal(daily.voiceStatus,'skipped');
  assert.deepEqual(f.notifications.context(10000,null),[]);f.focus(f.b.id);const foreign=f.add('A-during-B');assert.equal(foreign.voiceStatus,'skipped');
  const own=f.add('B-work',f.b.id);assert.equal(f.notifications.next({voiceInstanceId:'voice-1'}).notification.id,own.id);assert.deepEqual(f.notifications.context(10000,f.b.id).map(r=>r.taskId),['B-work']);
  f.focus(DEFAULT_PROJECT_ID);assert.equal(f.notifications.next({voiceInstanceId:'voice-1'}).notification,null);assert.equal(f.ops.get(own.id).voiceStatus,'skipped');
  assert.equal(f.notifications.context(10000,DEFAULT_PROJECT_ID).length,2);assert.equal(f.notifications.conversation().messages.length,3);
});

test('entering daily talk retires pending and claimed audio permanently while task results remain',t=>{
  const f=notices(t),pending=f.add('pending'),claimed=f.add('claimed');f.notifications.claim({id:claimed.id,voiceInstanceId:'voice-1'});
  assert.equal(f.notifications.active({id:claimed.id,voiceInstanceId:'voice-1'}).valid,true);
  f.focus(DEFAULT_PROJECT_ID,'daily');assert.equal(f.notifications.active({id:claimed.id,voiceInstanceId:'voice-1'}).valid,false);assert.equal(f.ops.get(pending.id).voiceStatus,'skipped');assert.equal(f.ops.get(claimed.id).voiceStatus,'skipped');
  f.focus(DEFAULT_PROJECT_ID);assert.equal(f.notifications.next({voiceInstanceId:'voice-1'}).notification,null);assert.equal(f.tasks.row('task','claimed').status,'completed');assert.equal(f.notifications.conversation().messages.length,2);
});
