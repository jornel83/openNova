import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createVoiceDevices,nativeVoiceDevices} from '../desktop/voice-devices.mjs';
import {createVoiceChannel} from '../desktop/voice.mjs';
import {createControls} from '../controls.mjs';
const catalog={devices:[{id:'uid:mic',name:'麦克风',inputChannels:1,outputChannels:0},{id:'uid:speaker',name:'蓝牙音响',inputChannels:0,outputChannels:2}],defaultInput:'uid:mic',defaultOutput:'uid:speaker'};
const active=(extra={})=>({voiceInstanceId:'owner',seq:1,generation:2,captureEpoch:1,capture:'listening',recognition:'idle',playback:'idle',requestId:null,...extra});
function fixture(t,{enumerate=async()=>structuredClone(catalog)}={}){
 const home=mkdtempSync(join(tmpdir(),'nova-voice-devices-')),voice=createVoiceChannel({pollMs:1});
 t.after(()=>{voice.close();rmSync(home,{recursive:true,force:true});});
 return {home,voice,devices:createVoiceDevices({home,voice,enumerate}),enumerate};
}
test('settings do not enumerate or enable audio; offline selections persist across service restart',async t=>{
 let enumerated=0;
 const f=fixture(t,{enumerate:async()=>{enumerated++;return structuredClone(catalog);}});
 assert.deepEqual(f.devices.settings(),{selection:{input:null,output:null},revision:0});assert.equal(enumerated,0);
 const result=await f.devices.select({expectedRevision:0,input:'uid:mic',output:'uid:speaker'});
 assert.equal(result.apply,'next_start');assert.equal(result.revision,1);assert.equal(f.voice.snapshot().connected,false);
 const restarted=createVoiceDevices({home:f.home,voice:f.voice,enumerate:f.enumerate});
 assert.deepEqual(restarted.settings(),{selection:{input:'uid:mic',output:'uid:speaker'},revision:1});
 assert.equal((await restarted.list()).defaultOutput,'uid:speaker');
 await restarted.select({expectedRevision:1,input:null,output:null});assert.equal(restarted.settings().selection.input,null);
});
test('fresh inventory rejects disconnected and wrong-direction choices without a save',async t=>{
 const f=fixture(t);
 for(const selection of [{input:'uid:speaker',output:null},{input:null,output:'uid:mic'},{input:'uid:gone',output:null}]){
  await assert.rejects(f.devices.select({expectedRevision:0,...selection}),/voice_device_not_available/);
 }
 assert.equal(f.devices.settings().revision,0);
});
test('concurrent browser changes use revision CAS after enumeration',async t=>{
 const f=fixture(t);
 const results=await Promise.allSettled([f.devices.select({expectedRevision:0,input:null,output:'uid:speaker'}),f.devices.select({expectedRevision:0,input:'uid:mic',output:null})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.match(results.find(x=>x.status==='rejected').reason.message,/voice_device_settings_changed/);
 assert.equal(f.devices.settings().revision,1);
});
test('active selection is queued to the current owner, while stale owners and startup cannot save',async t=>{
 const f=fixture(t);f.voice.publish(active());
 await assert.rejects(f.devices.select({expectedRevision:0,input:null,output:null,voiceInstanceId:'old'}),/stale_voice_control/);
 assert.equal(f.devices.settings().revision,0);
 const result=await f.devices.select({expectedRevision:0,input:'uid:mic',output:'uid:speaker',voiceInstanceId:'owner'});
 assert.equal(result.apply,'queued');assert.deepEqual(result.control.devices,{input:'uid:mic',output:'uid:speaker'});
 assert.equal((await f.voice.poll('owner')).commands.length,1);
 assert.equal(JSON.parse(readFileSync(join(f.home,'voice-devices.json'),'utf8')).revision,1);
 f.voice.publish(active({seq:2,phase:'starting',audioEnabled:false,capture:'off'}));
 await assert.rejects(f.devices.select({expectedRevision:1,input:null,output:null,voiceInstanceId:'owner'}),/voice_control_unavailable/);
 assert.equal(f.devices.settings().revision,1);
});
test('queue saturation and failed persistence do not partially save or enqueue',async t=>{
 const f=fixture(t);f.voice.publish(active());
 for(let i=0;i<16;i++)f.voice.enqueue({id:'mute-'+i,action:'mute',voiceInstanceId:'owner',generation:2,requestId:null});
 await assert.rejects(f.devices.select({expectedRevision:0,input:null,output:null,voiceInstanceId:'owner'}),/voice_control_busy/);
 assert.equal(f.devices.settings().revision,0);
 const g=fixture(t);g.voice.publish(active());g.devices.settings();
 mkdirSync(join(g.home,'voice-devices.json'));
 await assert.rejects(g.devices.select({expectedRevision:0,input:null,output:null,voiceInstanceId:'owner'}),/voice_device_settings_save_failed/);
 assert.equal(g.devices.settings().revision,0);assert.equal((await g.voice.poll('owner')).commands.length,0);
});
test('a second browser cannot replace settings during a pending device reconnection',async t=>{
 const f=fixture(t);f.voice.publish(active());
 const first=await f.devices.select({expectedRevision:0,input:'uid:mic',output:'uid:speaker',voiceInstanceId:'owner'});
 await assert.rejects(f.devices.select({expectedRevision:1,input:null,output:null,voiceInstanceId:'owner'}),/voice_control_busy/);
 assert.equal(f.devices.settings().revision,1);
 f.voice.ack({...first.control,status:'applied'});
 f.voice.publish(active({seq:2,devices:{input:'uid:mic',output:'uid:speaker',switching:true},deviceRevision:1}));
 await assert.rejects(f.devices.select({expectedRevision:1,input:null,output:null,voiceInstanceId:'owner'}),/voice_control_busy/);
 f.voice.publish(active({seq:3,devices:{input:'uid:mic',output:'uid:speaker',switching:false},deviceRevision:1}));
 assert.equal((await f.devices.select({expectedRevision:1,input:null,output:null,voiceInstanceId:'owner'})).revision,2);
});
test('device payload and revision participate in idempotency; reconnect ack may follow a new generation',async t=>{
 const f=fixture(t);f.voice.publish(active({devices:{input:null,output:'uid:speaker',activeInput:'麦克风',activeOutput:'蓝牙音响',switching:false},deviceRevision:0}));
 const c={id:'select',action:'devices',devices:{input:'uid:mic',output:null},deviceRevision:1,voiceInstanceId:'owner',generation:2,requestId:null};
 f.voice.enqueue(c);assert.equal(f.voice.enqueue(c).status,'queued');
 assert.throws(()=>f.voice.enqueue({...c,devices:{input:null,output:null}}),/control_id_conflict/);
 assert.throws(()=>f.voice.enqueue({...c,deviceRevision:2}),/control_id_conflict/);
 f.voice.publish(active({seq:2,generation:3,devices:{...c.devices,activeInput:null,activeOutput:null,switching:true},deviceRevision:1}));
 assert.equal(f.voice.ack({...c,status:'applied'}).status,'applied');
 assert.equal(f.voice.snapshot().devices.switching,true);
 assert.throws(()=>f.voice.publish(active({seq:3,generation:3,devices:{input:[],output:null}})),/invalid_voice_update/);
});
test('control API forwards catalog, settings and selection without foreground cancellation',async t=>{
 const f=fixture(t),handle=createControls({voice:f.voice,voiceDevices:f.devices});
 assert.equal((await handle('/voice-device-settings',{})).revision,0);
 assert.equal((await handle('/voice-devices',{})).devices.length,2);
 assert.equal((await handle('/voice-devices-select',{expectedRevision:0,input:null,output:null})).apply,'next_start');
});
test('native enumeration exposes stable IDs and only executes the list mode',async t=>{
 const f=fixture(t),root=f.home,source=join(root,'tools/voice/native'),bin=join(root,'output/voice/bin');
 mkdirSync(source,{recursive:true});for(const name of ['PlaybackQueue.swift','AudioDevices.swift','AudioBridge.swift'])writeFileSync(join(source,name),'fixture');
 mkdirSync(bin,{recursive:true});writeFileSync(join(bin,'opennova-audio'),'fixture');
 const calls=[];
 const enumerate=nativeVoiceDevices({root,platform:'darwin',run:async(file,args)=>{
  calls.push({file,args});return {stdout:JSON.stringify({type:'devices',default_input:11,default_output:22,devices:[
   {id:11,uid:'mic',name:'麦克风',input_channels:1,output_channels:0},
   {id:22,uid:'speaker',name:'蓝牙音响',input_channels:0,output_channels:2}]})};
 }});
 const result=await enumerate();assert.equal(result.defaultInput,'uid:mic');assert.equal(result.defaultOutput,'uid:speaker');
 assert.equal(calls.length,1);assert.deepEqual(calls[0].args,['--list-devices']);
});
test('native UID selection distinguishes identical names and rejects wrong directions', {skip:process.platform!=='darwin',timeout:120000},async t=>{
 const f=fixture(t),source=resolve('tools/voice/native/tests/DeviceTests.swift'),binary=join(f.home,'device-selection');
 const exec=promisify(execFile);
 await exec('xcrun',['swiftc',resolve('tools/voice/native/AudioDevices.swift'),source,'-o',binary],{timeout:100000});
 assert.match((await exec(binary,[],{timeout:5000})).stdout,/Audio device selection: 13 checks passed/);
});
