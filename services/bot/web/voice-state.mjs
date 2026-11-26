/** Presentation of independent native and Bot state; never initiates audio. */
import {researchPhaseLabel} from './research-view.mjs';
import {modelRetryLabel} from '../../agent/model-retry.mjs';
// Cancelling an active request already stops its own audio. Proactive speech has
// no request, so it still needs a voice stop even when both request IDs are null.
export function needsVoiceStop(voice,activeId){
 return !!voice?.connected&&['buffering','playing','paused'].includes(voice.playback)&&(!activeId||voice.requestId!==activeId);
}
export function voicePresentation(snapshot,online) {
 const v=snapshot?.desktop?.voice??{},connected=online&&v.connected;
 const standby=!!connected&&v.audioEnabled===false,starting=!!online&&v.phase==='starting',switching=!!connected&&v.devices?.switching===true;
 const active=snapshot?.messages?.find(m=>m.id===snapshot.activeId);
 let state='idle',label='与你继续交流';
 if(!online){state='offline';label='正在连接';}
 else if(switching){label='正在切换音频设备';}
 else if(connected&&(v.capture==='error'||v.playback==='error')){state='error';label='音频需要重连';}
 else if(connected&&v.playback==='playing'){state='playing';label='正在播报';}
 else if(connected&&v.recognition==='recognizing'){state='recognizing';label='正在识别';}
 else if(connected&&v.playback==='paused'){state='paused';label='暂缓播报';}
 else if(connected&&v.playback==='buffering'){state='buffering';label='等待语音';}
 else if(snapshot?.busy){state='thinking';label=modelRetryLabel(active)||researchPhaseLabel(active)||(active?.phase==='tool'?'正在工作':'正在思考');}
 else if(starting){label='正在开启语音';}
 else if(standby){label='文字对话已就绪';}
 else if(connected&&v.capture==='listening'){state='listening';label='正在聆听';}
 const micLabel=!online?'连接已断开':switching?'正在切换音频设备':starting?'正在连接音频':!connected?'语音未启动':standby?'语音未开启':({listening:'麦克风聆听中',muted:'麦克风已静音',off:'交流已结束',error:'音频连接异常'}[v.capture]||'语音准备中');
 const micHint=starting||switching?'文字对话仍可继续':!connected?'在终端启动语音后自动连接':standby?'点击开启后连接麦克风和播放设备':v.capture==='muted'?'只停止收音，任务汇报仍会播报':v.capture==='off'?'点击开始恢复收音与播报':'麦克风开关只控制收音';
 const micAction=standby||v.capture==='off'?'start':v.capture==='listening'?'mute':'unmute';
 const micActionLabel=standby?'开启语音':v.capture==='off'?'开始交流':v.capture==='listening'?'静音麦克风':'恢复麦克风';
 const stopLabel=snapshot?.activeId?'停止回复':'停止播报';
 const problem=connected&&!starting&&typeof v.problem==='string'&&v.problem.trim()?v.problem:null;
 return {state,label,micLabel,micHint,micAction,micActionLabel,standby,starting,switching,problem,stopLabel,canControl:!!connected,canUseMic:!!connected&&!starting&&!switching&&v.capture!=='error',canStop:!!online&&!!(snapshot?.activeId||(connected&&['buffering','playing','paused'].includes(v.playback)))};
}
