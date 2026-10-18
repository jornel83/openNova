import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvents} from '../desktop/events.mjs';
import {createWorkContext} from '../desktop/context.mjs';
import {Operations} from '../operations.mjs';
import {Requests} from '../requests.mjs';
import {createControls} from '../controls.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('snapshot to subscription gap replays completion and then delivers live events in sequence',()=>{
 const events=createEvents(),state={done:false};
 const snap=events.snapshot(()=>({...state}));state.done=true;
 events.publish('request.updated',{status:'completed'},'r');
 const seen=[],off=events.subscribe(snap.cursor,e=>seen.push(e));
 events.publish('work.context',{kind:'none'});
 assert.equal(snap.state.done,false);assert.deepEqual(seen.map(e=>e.seq),[1,2]);assert.equal(seen[0].requestId,'r');
 off();events.publish('request.updated',{});assert.equal(seen.length,2);events.close();
});
test('expired, future, malformed and new epoch cursors request a fresh snapshot',()=>{
 const events=createEvents({capacity:2}),cursor=events.snapshot(()=>null).cursor;
 for(let i=0;i<3;i++)events.publish('request.updated',{i});
 for(const c of [cursor,{...cursor,seq:99},{...cursor,seq:-1},null,createEvents().snapshot(()=>null).cursor])assert.throws(()=>events.subscribe(c,()=>{}),/cursor_reset/);
 const seen=[];events.subscribe({...cursor,seq:1},e=>seen.push(e));assert.equal(seen.length,2);events.close();
});
test('slow or broken consumers are detached without blocking other clients and can recover',()=>{
 const events=createEvents(),cursor=events.snapshot(()=>null).cursor;let slow=0;const fast=[];
 events.subscribe(cursor,()=>{slow++;return false;});events.subscribe(cursor,e=>fast.push(e));
 events.publish('work.context',{});events.publish('work.context',{});
 assert.equal(slow,1);assert.equal(fast.length,2);const recovered=[];
 events.subscribe(cursor,e=>recovered.push(e));assert.equal(recovered.length,2);events.close();
 assert.throws(()=>events.subscribe(cursor,()=>{}),/events_closed/);
});
test('snapshot and request events see persisted results and admission release',async t=>{
 const home=mkdtempSync(join(tmpdir(),'nova-events-')),events=createEvents();
 const ops=new Operations({home,workspace:join(home,'project'),events});
 const requests=new Requests(ops,async()=>({text:'完成'}),{events});
 const context=createWorkContext();const handle=createControls({ops,requests,events,context,health:()=>({ready:true})});
 t.after(()=>{events.close();ops.close();rmSync(home,{recursive:true,force:true});});
 const snap=await handle('/snapshot',{});assert.equal(snap.desktop.voice.connected,false);const seen=[];
 events.subscribe(snap.cursor,e=>seen.push({e,active:!!requests.active}));requests.submit('r','你好');await requests.active.work;
 assert.equal((await handle('/snapshot',{})).messages[0].text,'完成');
 assert.ok(seen.some(({e})=>e.type==='request.updated'&&e.payload.status==='completed'));
 assert.equal(seen.at(-1).active,false);assert.equal(seen.at(-1).e.type,'request.updated');
});
test('restoring a historical file is metadata only and survives browser background updates',()=>{
 const changes=[],file={id:'f',path:'/tmp/report.pdf',name:'report.pdf',contentAccess:'not_connected'};
 const context=createWorkContext({initial:{kind:'file',file},onChange:c=>changes.push(c)});
 assert.equal(context.capture().historical,true);assert.equal(context.capture().file.name,'report.pdf');
 assert.equal(changes.length,0);context.updateBrowser({page:{bindingId:'b',tabId:1,documentId:'d',revision:1}});
 assert.equal(context.capture().kind,'file');context.selectFile(file);assert.equal(context.capture().historical,undefined);assert.equal(changes.length,1);
});
test('new memory records keep their originating request after later updates',t=>{
 const home=mkdtempSync(join(tmpdir(),'nova-event-owner-'));let requestId='first';
 const ops=new Operations({home,workspace:join(home,'project'),getRequestId:()=>requestId});t.after(()=>{ops.close();rmSync(home,{recursive:true,force:true});});
 const record=ops.proposeMemory('remember',{text:'偏好'});assert.equal(record.requestId,'first');requestId='second';
 assert.equal(ops.put({...record,status:'applied'}).requestId,'first');
});
