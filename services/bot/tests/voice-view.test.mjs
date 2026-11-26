import test from 'node:test';
import assert from 'node:assert/strict';
import {voicePresentation} from '../web/voice-state.mjs';
const snapshot=(voice,other={})=>({desktop:{voice:{connected:true,capture:'listening',recognition:'idle',playback:'idle',...voice}},...other});
test('independent capture and playback priority and stop after Bot completion',()=>{
 const p=voicePresentation(snapshot({capture:'muted',playback:'playing',requestId:'done'}),true);
 assert.equal(p.state,'playing');assert.equal(p.micLabel,'麦克风已静音');assert.equal(p.canStop,true);assert.equal(p.stopLabel,'停止播报');assert.equal(p.micHint,'只停止收音，任务汇报仍会播报');
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

test('microphone help and stop labels keep capture independent from active replies',()=>{
 const muted=voicePresentation(snapshot({capture:'muted'}),true);
 assert.equal(muted.canStop,false);assert.match(muted.micHint,/任务汇报仍会播报/);
 const speaking=voicePresentation(snapshot({capture:'muted',playback:'playing'},{busy:true,activeId:'foreground'}),true);
 assert.equal(speaking.stopLabel,'停止回复');assert.equal(speaking.state,'playing');
 assert.equal(voicePresentation(snapshot({capture:'listening'}),true).micHint,'麦克风开关只控制收音');
 assert.match(voicePresentation(snapshot({connected:false}),true).micHint,/启动语音/);
});
test('standby exposes explicit audio activation without simulating listening or blocking text',()=>{
 const data=snapshot({capture:'off',audioEnabled:false,phase:'standby'});
 const p=voicePresentation(data,true);
 assert.equal(p.standby,true);assert.equal(p.canUseMic,true);assert.equal(p.micAction,'start');assert.equal(p.micActionLabel,'开启语音');
 assert.equal(p.micLabel,'语音未开启');assert.equal(p.label,'文字对话已就绪');assert.equal(p.state,'idle');assert.equal(p.canStop,false);
 const thinking=voicePresentation({...data,busy:true,activeId:'text'},true);
 assert.equal(thinking.state,'thinking');assert.equal(thinking.canStop,true);assert.equal(thinking.stopLabel,'停止回复');
 assert.equal(voicePresentation(data,false).canUseMic,false);
});
test('audio startup and failed device attempts leave a visible retry path and preserve text progress',()=>{
 const data=snapshot({capture:'off',audioEnabled:false,phase:'starting',problem:'old failure'});
 const starting=voicePresentation(data,true);
 assert.equal(starting.starting,true);assert.equal(starting.canUseMic,false);assert.equal(starting.problem,null);assert.equal(starting.label,'正在开启语音');
 assert.equal(voicePresentation({...data,busy:true,activeId:'text'},true).label,'正在思考');
 data.desktop.voice.phase='standby';data.desktop.voice.problem='找不到指定的麦克风';
 const failed=voicePresentation(data,true);
 assert.equal(failed.canUseMic,true);assert.equal(failed.micAction,'start');assert.equal(failed.problem,'找不到指定的麦克风');
 assert.equal(failed.state,'idle');
});
test('ending a conversation retains audio controls while disabling audio returns to standby',()=>{
 const ended=voicePresentation(snapshot({capture:'off'}),true);
 assert.equal(ended.standby,false);assert.equal(ended.micLabel,'交流已结束');assert.equal(ended.micActionLabel,'开始交流');
 const disabled=voicePresentation(snapshot({capture:'off',audioEnabled:false,phase:'standby'}),true);
 assert.equal(disabled.micLabel,'语音未开启');assert.equal(disabled.micActionLabel,'开启语音');
});

test('voice handoff keeps startup feedback while Python prepares its native pipeline',()=>{
 const p=voicePresentation({desktop:{voice:{connected:false,phase:'starting',audioEnabled:false}}},true);
 assert.equal(p.starting,true);assert.equal(p.micLabel,'正在连接音频');assert.equal(p.canUseMic,false);
 assert.equal(p.micHint,'文字对话仍可继续');
});

test('device reconnection displays progress and keeps the independent text stop available',()=>{
 const p=voicePresentation(snapshot({capture:'error',devices:{switching:true}},{busy:true,activeId:'text'}),true);
 assert.equal(p.switching,true);assert.equal(p.starting,false);assert.equal(p.state,'idle');
 assert.equal(p.micLabel,'正在切换音频设备');assert.equal(p.canUseMic,false);
 assert.equal(p.canControl,true);assert.equal(p.canStop,true);assert.equal(p.stopLabel,'停止回复');
});

test('nonfatal model problems remain visible while active audio keeps listening and its controls',()=>{
 const data=snapshot({phase:'active',audioEnabled:true,problem:'无法连接 ChatGPT，请检查网络或代理。'});
 const p=voicePresentation(data,true);
 assert.equal(p.problem,data.desktop.voice.problem);assert.equal(p.state,'listening');assert.equal(p.label,'正在聆听');
 assert.equal(p.micLabel,'麦克风聆听中');assert.equal(p.canUseMic,true);assert.equal(p.micAction,'mute');
 assert.equal(voicePresentation({...data,busy:true,activeId:'next'},true).state,'thinking');
 assert.equal(voicePresentation(data,false).problem,null);
 data.desktop.voice.problem='';assert.equal(voicePresentation(data,true).problem,null);
});
