import test from 'node:test';
import assert from 'node:assert/strict';
import {voicePresentation} from '../web/voice-state.mjs';
const snapshot=(voice,other={})=>({desktop:{voice:{connected:true,capture:'listening',recognition:'idle',playback:'idle',...voice}},...other});
test('independent capture and playback priority and stop after Bot completion',()=>{
 const p=voicePresentation(snapshot({capture:'muted',playback:'playing',requestId:'done'}),true);
 assert.equal(p.state,'playing');assert.equal(p.micLabel,'麦克风已静音');assert.equal(p.canStop,true);
 assert.equal(voicePresentation(snapshot({playback:'buffering'}),true).label,'等待语音');
 assert.equal(voicePresentation(snapshot({playback:'paused'}),true).label,'暂缓播报');
 assert.equal(voicePresentation(snapshot({recognition:'recognizing'}),true).state,'recognizing');
});
test('no simulated listening offline; text busy stays usable without a voice process',()=>{
 assert.equal(voicePresentation(snapshot({connected:false}),true).micLabel,'语音未启动');
 assert.equal(voicePresentation(snapshot({connected:false},{busy:true,activeId:'r'}),true).state,'thinking');
 assert.equal(voicePresentation(snapshot({}),false).canControl,false);
 assert.equal(voicePresentation(snapshot({}),false).state,'offline');
});
test('research phase is visible in Nova ring without requiring microphone connection',()=>{
 const data=snapshot({connected:false},{busy:true,activeId:'r',messages:[{id:'r',research:{phase:'searching'}}]});
 assert.equal(voicePresentation(data,true).label,'正在联网搜索');
 data.desktop.voice={connected:true,playback:'playing'};assert.equal(voicePresentation(data,true).label,'正在播报');
});
