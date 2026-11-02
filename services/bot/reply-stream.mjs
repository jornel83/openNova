/** Bounded, ephemeral answer previews. Only Requests settles durable results. */
import {replySpeechPrefix} from './reply-speech.mjs';

export function createReplyStream({events,enabled=true,now=Date.now,delayMs=40}={}) {
  const states=new Map();let latest,closed=false;
  const copy=state=>state?.draft?structuredClone({...state.draft,timings:state.timings}):null;
  const emit=state=>{clearTimeout(state.timer);state.timer=undefined;if(closed||!state.draft)return;
    state.draft.revision=++state.revision;events?.publish('reply.stream',copy(state),state.id);};
  const schedule=state=>{if(!state.timer){state.timer=setTimeout(()=>emit(state),delayMs);state.timer.unref?.();}};
  const abandon=(state,reason)=>{if(!state?.draft||state.draft.status==='abandoned')return;
    state.draft.status='abandoned';state.draft.reason=reason;emit(state);};
  return {
    enabled,
    begin(id){
      if(closed)return;const state={id,revision:0,timings:{submittedAt:now()}};states.set(id,state);latest=id;
      while(states.size>32){const key=states.keys().next().value;clearTimeout(states.get(key).timer);states.delete(key);}
    },
    observe(frame,active){
      if(closed||!active||active.cancelled||active.signal?.aborted||!active.started||
        frame.purpose==='compaction'||frame.sessionId!==active.sessionId)return;
      const state=states.get(active.id);if(!state||state.finished)return;
      if(frame.type==='start'){
        if(state.draft&&state.attemptId!==frame.attemptId)abandon(state,'attempt_replaced');
        state.attemptId=frame.attemptId;state.timings.modelRequestedAt??=frame.at;
      }
      if(frame.attemptId!==state.attemptId)return;
      if(frame.type==='model-text')state.timings.firstModelTextAt??=frame.at;
      if(frame.type==='model-completed')state.timings.modelCompletedAt=frame.at;
      if(!enabled)return;
      if(frame.type==='answer-start'){
        state.draft={requestId:state.id,attemptId:frame.attemptId,revision:state.revision,status:'streaming',text:'',speechText:'',speechEligible:true};
        emit(state);
      }else if(frame.type==='text'&&state.draft?.status==='streaming'){
        if(typeof frame.text!=='string'||frame.text.length>16000||!frame.text.startsWith(state.draft.text))return abandon(state,'stream_changed');
        const speechText=replySpeechPrefix(frame.text);
        if(!speechText.startsWith(state.draft.speechText))return abandon(state,'speech_projection_changed');
        state.draft.text=frame.text;state.draft.speechText=speechText;
        state.timings.firstDraftAt??=frame.at;
        if(speechText)state.timings.firstSpeechDraftAt??=frame.at;
        schedule(state);
      }else if(frame.type==='settled'){
        state.timings.modelCompletedAt=frame.at;
        if(state.draft?.status==='streaming'){state.draft.status='settled';emit(state);}
      }else if(frame.type==='abandoned')abandon(state,frame.reason);
    },
    finish(id,result,{error,cancelled=false}={}){
      const state=states.get(id);if(!state)return {};
      state.finished=true;state.timings.botCompletedAt=now();clearTimeout(state.timer);
      if(error||cancelled)abandon(state,cancelled?'cancelled':'request_failed');
      else if(state.draft&&state.draft.status!=='abandoned'){
        if(result?.text!==state.draft.text||!result?.speechText?.startsWith(state.draft.speechText))abandon(state,'final_result_changed');
        else {state.draft.status='settled';emit(state);}
      }
      return {replyTimings:{...state.timings},...(state.draft?{replyStream:copy(state),...(error||cancelled?{partialText:state.draft.text}:{})}:{})};
    },
    cancel(id){const state=states.get(id);if(state)abandon(state,'cancelled');},
    snapshot(id=latest){return copy(states.get(id));},
    close(){closed=true;for(const state of states.values())clearTimeout(state.timer);states.clear();},
  };
}
