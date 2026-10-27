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
