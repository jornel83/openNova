/** Ephemeral answer previews never replace the committed request result. */
export const emptyReplyStream=()=>({hostEpoch:null,seq:-1,draft:null});

function validCursor(value){return typeof value?.hostEpoch==='string'&&Number.isInteger(value.seq)&&value.seq>=0;}
function draftOf(value){
 if(!value||typeof value.requestId!=='string'||typeof value.attemptId!=='string'||!Number.isInteger(value.revision)||value.revision<0
   ||!['streaming','settled','abandoned'].includes(value.status)||typeof value.text!=='string'||value.text.length>16000)return null;
 return {requestId:value.requestId,attemptId:value.attemptId,revision:value.revision,status:value.status,text:value.text};
}

export function receiveReplySnapshot(state,snapshot){
 const cursor=snapshot?.cursor;
 if(!validCursor(cursor))return state;
 // A fresh host snapshot is the sole authority for changing epochs. A late
 // response within the current epoch cannot roll an already visible draft back.
 if(cursor.hostEpoch===state.hostEpoch&&cursor.seq<state.seq)return state;
 return {...cursor,draft:draftOf(snapshot.replyStream)};
}

export function receiveReplyEvent(state,event){
 if(event?.type!=='reply.stream'||!validCursor(event)||event.hostEpoch!==state.hostEpoch||event.seq<=state.seq)return state;
 const draft=draftOf(event.payload);
 if(!draft||draft.requestId!==event.requestId)return state;
 if(state.draft?.requestId===draft.requestId&&draft.revision<=state.draft.revision)return {...state,seq:event.seq};
 return {hostEpoch:event.hostEpoch,seq:event.seq,draft};
}

export function replyPresentation(message,state){
 if(message.status==='completed')return null;
 const running=['queued','running'].includes(message.status);
 // Failed/cancelled requests keep their explicitly persisted partial text;
 // abandoned retry previews disappear until the new attempt has an answer.
 if(!running&&typeof message.partialText==='string'&&message.partialText.trim())return {
  text:message.partialText,label:'本轮未完成，已保留生成的内容。',interrupted:true,
 };
 const draft=state.draft;
 if(!draft||draft.requestId!==message.id||(running&&draft.status==='abandoned')||!draft.text.trim())return null;
 return {text:draft.text,interrupted:!running,label:!running?'本轮未完成，已保留生成的内容。':draft.status==='settled'?'正在确认结果…':'正在生成…'};
}
