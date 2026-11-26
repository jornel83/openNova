import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {createVoiceChannel} from '../../../services/bot/desktop/voice.mjs';
import {voiceStandby} from '../standby.mjs';

function host(){
 const channel=createVoiceChannel({pollMs:10});
 const call=async(path,body)=>{
  if(path==='/voice/publish')return channel.publish(body);
  if(path==='/voice/poll')return channel.poll(body.voiceInstanceId);
  if(path==='/voice/ack')return channel.ack(body);
  throw Error('unexpected_route');
 };
 const start=()=>{const v=channel.snapshot();return channel.enqueue({id:crypto.randomUUID(),action:'start',voiceInstanceId:v.voiceInstanceId,generation:v.generation,requestId:null});};
 return {channel,call,start};
}
test('standby controls hand off ownership and late old-owner messages stay rejected',async t=>{
 const h=host();t.after(()=>h.channel.close());
 const s=await voiceStandby({call:h.call,input:null});t.after(()=>s.close());
 assert.equal(h.channel.snapshot().audioEnabled,false);
 const old=h.channel.snapshot();h.start();assert.equal(await s.wait(),true);
 await s.starting();assert.equal(h.channel.snapshot().phase,'starting');
 await s.close();assert.equal(h.channel.snapshot().connected,false);
 const next=await voiceStandby({call:h.call,input:null});t.after(()=>next.close());
 assert.throws(()=>h.channel.publish({...old,seq:100}),/stale_voice_instance/);
});
test('temporary heartbeat and poll errors recover without losing the enable control',async t=>{
 const h=host();t.after(()=>h.channel.close());let publishes=0,polls=0;
 const call=async(path,body)=>{
  if(path==='/voice/publish'&&++publishes===2)throw Error('transient');
  if(path==='/voice/poll'&&++polls===1)throw Error('transient');
  return h.call(path,body);
 };
 const s=await voiceStandby({call,input:null,interval:20});t.after(()=>s.close());
 const waiting=s.wait();await delay(150);h.start();
 assert.equal(await waiting,true);assert.ok(publishes>2);
});
test('terminal enable and quit work without acquiring any audio resources',async t=>{
 const h=host();t.after(()=>h.channel.close());
 for(const [line,result] of [['/start',true],['/quit',false]]){
  const input=new PassThrough(),s=await voiceStandby({call:h.call,input});
  const waiting=s.wait();input.write(line+'\n');
  assert.equal(await waiting,result);await s.close();input.destroy();
 }
});
