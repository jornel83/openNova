import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceChannel} from '../desktop/voice.mjs';
import {createControls} from '../controls.mjs';
const state=(seq=1,extra={})=>({voiceInstanceId:'v1',seq,generation:2,captureEpoch:1,capture:'listening',recognition:'idle',playback:'idle',requestId:null,...extra});
function fixture(t){let now=0;const events=[];const v=createVoiceChannel({events:{publish:(type,data)=>events.push({type,data})},now:()=>now,ttl:100,pollMs:10});t.after(()=>v.close());return {v,events,advance:n=>now+=n};}
test('one live owner, revisions replace draft, heartbeat expiration and old owners cannot take over',t=>{
 const {v,advance}=fixture(t);v.publish(state(1,{draft:{text:'你',utteranceId:'1'}}));v.publish(state(2,{draft:{text:'你好',utteranceId:'1'}}));
 assert.equal(v.snapshot().draft.text,'你好');assert.throws(()=>v.publish(state(3,{voiceInstanceId:'v2'})),/voice_in_use/);
 advance(101);assert.equal(v.snapshot().connected,false);v.publish(state(1,{voiceInstanceId:'v2'}));assert.throws(()=>v.publish(state(4)),/stale_voice_instance/);
});
test('control delivery and ack are idempotent and reject old generations',async t=>{
 const {v}=fixture(t);assert.throws(()=>v.enqueue({id:'c',action:'mute'}),/voice_unavailable/);v.publish(state(1,{requestId:'r',playback:'playing'}));
 const c={id:'c',action:'stop',voiceInstanceId:'v1',generation:2,requestId:'r'};v.enqueue(c);v.enqueue(c);
 assert.equal((await v.poll('v1')).commands.length,1);
 assert.throws(()=>v.ack({...c,generation:1,status:'applied'}),/stale_voice_control/);
 v.ack({...c,status:'applied'});assert.equal(v.enqueue(c).status,'applied');assert.equal((await v.poll('v1')).commands.length,0);
 assert.throws(()=>v.enqueue({...c,id:'old',generation:1}),/stale_voice_control/);
 v.publish(state(2,{generation:3}));assert.equal(v.publish(state(1,{generation:2})).ignored,true);assert.equal(v.snapshot().generation,3);
});
test('new generation invalidates undelivered stop and stale acknowledgments',async t=>{
 const {v}=fixture(t);v.publish(state(1,{requestId:'old',playback:'playing'}));v.enqueue({id:'c',action:'stop',voiceInstanceId:'v1',generation:2,requestId:'old'});
 v.publish(state(2,{generation:3,requestId:'new',playback:'buffering'}));assert.equal((await v.poll('v1')).commands.length,0);
 assert.equal(v.snapshot().controls[0].status,'stale');assert.throws(()=>v.ack({id:'c',voiceInstanceId:'v1',generation:2,status:'applied'}),/stale_voice_control/);
});
test('cancel works for text and clears voice even after Bot completion; stale stop never cancels new request',async t=>{
 const {v}=fixture(t);const cancelled=[];const handle=createControls({voice:v,requests:{cancel:async id=>{cancelled.push(id);return {id,status:'cancelled'};}}});
 await handle('/cancel',{id:'text'});assert.deepEqual(cancelled,['text']);
 v.publish(state(1,{requestId:'spoken',playback:'playing'}));await handle('/cancel',{id:'spoken'});assert.equal((await v.poll('v1')).commands[0].action,'stop');
 v.publish(state(2,{generation:3,requestId:'next'}));await assert.rejects(handle('/voice-control',{id:'late',action:'stop',voiceInstanceId:'v1',generation:2,requestId:'spoken'}),/stale_voice_control/);
 assert.deepEqual(cancelled,['text','spoken']);
 // Internal cancellation never loops a second stop back into the native process.
 await handle('/voice/cancel-request',{id:'next'});assert.equal((await v.poll('v1')).commands.length,0);
});
test('saturated controls prioritize stop and still cancel the exact Bot request',async t=>{
 const {v}=fixture(t);v.publish(state(1,{requestId:'r',playback:'playing'}));
 for(let i=0;i<16;i++)v.enqueue({id:'mute-'+i,action:'mute',voiceInstanceId:'v1',generation:2,requestId:'r'});
 const cancelled=[];const handle=createControls({voice:v,requests:{cancel:async id=>{cancelled.push(id);return {id,status:'cancelled'};}}});
 await handle('/cancel',{id:'r'});assert.deepEqual(cancelled,['r']);
 const commands=(await v.poll('v1')).commands;assert.equal(commands[0].action,'stop');assert.equal(commands.length,16);
});
test('native delivery failure cannot prevent exact Agent cancellation',async()=>{
 const cancelled=[];const handle=createControls({voice:{snapshot:()=>({connected:true,requestId:'r'}),enqueue:()=>{throw Error('voice_unavailable');}},requests:{cancel:async id=>{cancelled.push(id);return {id,status:'cancelled'};}}});
 await assert.rejects(handle('/cancel',{id:'r'}),/voice_unavailable/);assert.deepEqual(cancelled,['r']);
});
test('standby launcher hands the lease to native audio and receives it back after disable',async t=>{
 const {v}=fixture(t),standby=state(1,{voiceInstanceId:'launcher-1',capture:'off',audioEnabled:false,phase:'standby',problem:'耳机暂未连接'});
 v.publish(standby);
 assert.equal(v.snapshot().audioEnabled,false);assert.equal(v.snapshot().problem,'耳机暂未连接');
 assert.throws(()=>v.enqueue({id:'mute',action:'mute',voiceInstanceId:'launcher-1',generation:2,requestId:null}),/voice_control_unavailable/);
 const start={id:'start',action:'start',voiceInstanceId:'launcher-1',generation:2,requestId:null};
 v.enqueue(start);assert.equal((await v.poll('launcher-1')).commands[0].action,'start');v.ack({...start,status:'applied'});
 v.publish({...standby,seq:2,phase:'starting',problem:null});
 assert.throws(()=>v.enqueue({...start,id:'again'}),/voice_control_unavailable/);
 assert.throws(()=>v.publish(state(1,{voiceInstanceId:'native'})),/voice_in_use/);
 v.publish({...standby,seq:3,phase:'starting',connected:false});
 v.publish(state(1,{voiceInstanceId:'native'}));
 assert.equal(v.snapshot().audioEnabled,true);assert.equal(v.snapshot().phase,'active');assert.equal(v.snapshot().problem,null);
 const disable={id:'disable',action:'disable',voiceInstanceId:'native',generation:2,requestId:null};
 v.enqueue(disable);assert.equal((await v.poll('native')).commands[0].action,'disable');v.ack({...disable,status:'applied'});
 v.publish(state(2,{voiceInstanceId:'native',connected:false,capture:'off'}));
 v.publish({...standby,voiceInstanceId:'launcher-2',problem:null});
 assert.equal(v.snapshot().audioEnabled,false);assert.deepEqual(v.snapshot().controls,[]);
 assert.throws(()=>v.publish(state(3,{voiceInstanceId:'native'})),/stale_voice_instance/);
});
test('standby cannot claim active capture, playback or a request and phase fields are validated',t=>{
 const {v}=fixture(t),standby=state(1,{capture:'off',audioEnabled:false,phase:'standby'});
 for(const extra of [{capture:'listening'},{playback:'playing'},{recognition:'recognizing'},{requestId:'r'},{draft:{text:'old',utteranceId:'u'}},{phase:'active'},{phase:'unknown'},{audioEnabled:'false'},{problem:12},{problem:'x'.repeat(1001)}])assert.throws(()=>v.publish({...standby,...extra}),/invalid_voice_update/);
 v.publish(standby);assert.equal(v.snapshot().phase,'standby');
});
test('full audio shutdown is delivered ahead of queued ordinary controls',async t=>{
 const {v}=fixture(t);v.publish(state());
 for(let i=0;i<16;i++)v.enqueue({id:'mute-'+i,action:'mute',voiceInstanceId:'v1',generation:2,requestId:null});
 v.enqueue({id:'disable',action:'disable',voiceInstanceId:'v1',generation:2,requestId:null});
 const queued=(await v.poll('v1')).commands;
 assert.equal(queued.length,16);assert.equal(queued[0].action,'disable');assert.equal(v.snapshot().controls.find(c=>c.id==='mute-0').status,'stale');
});
