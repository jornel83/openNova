/** Presentation of independent native and Bot state; never initiates audio. */
import {researchPhaseLabel} from './research-view.mjs';
export function voicePresentation(snapshot,online) {
 const v=snapshot?.desktop?.voice??{},connected=online&&v.connected;
 const active=snapshot?.messages?.find(m=>m.id===snapshot.activeId);
 let state='idle',label='与你继续交流';
 if(!online){state='offline';label='正在连接';}
 else if(connected&&(v.capture==='error'||v.playback==='error')){state='error';label='音频需要重连';}
 else if(connected&&v.playback==='playing'){state='playing';label='正在播报';}
 else if(connected&&v.recognition==='recognizing'){state='recognizing';label='正在识别';}
 else if(connected&&v.playback==='paused'){state='paused';label='暂缓播报';}
 else if(connected&&v.playback==='buffering'){state='buffering';label='等待语音';}
 else if(snapshot?.busy){state='thinking';label=researchPhaseLabel(active)||(active?.phase==='tool'?'正在工作':'正在思考');}
 else if(connected&&v.capture==='listening'){state='listening';label='正在聆听';}
 const micLabel=!online?'连接已断开':!connected?'语音未启动':({listening:'麦克风聆听中',muted:'麦克风已静音',off:'交流已结束',error:'音频连接异常'}[v.capture]||'语音准备中');
 return {state,label,micLabel,canControl:!!connected,canStop:!!online&&!!(snapshot?.activeId||(connected&&['buffering','playing','paused'].includes(v.playback)))};
}
