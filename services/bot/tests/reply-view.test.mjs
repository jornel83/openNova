import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyReplyStream,receiveReplyEvent,receiveReplySnapshot,replyPresentation} from '../web/reply-stream.mjs';

const draft=(text='第一句。',extra={})=>({requestId:'r',attemptId:'a',revision:1,status:'streaming',text,...extra});
const snapshot=(seq=0,replyStream=null,hostEpoch='host')=>({cursor:{hostEpoch,seq},replyStream});
const event=(seq,payload,hostEpoch='host')=>({type:'reply.stream',hostEpoch,seq,requestId:payload.requestId,payload});
const running={id:'r',status:'running'};

test('stream updates render before completion without an additional full snapshot',()=>{
 let state=receiveReplySnapshot(emptyReplyStream(),snapshot());
 state=receiveReplyEvent(state,event(1,draft()));
 assert.deepEqual(replyPresentation(running,state),{text:'第一句。',label:'正在生成…',interrupted:false});
 state=receiveReplyEvent(state,event(2,draft('第一句。第二句。',{revision:2,status:'settled'})));
 assert.equal(replyPresentation(running,state).label,'正在确认结果…');
 assert.equal(replyPresentation({...running,status:'completed',text:'最终结果'},state),null);
});

test('slow snapshots and replayed SSE cannot roll back a visible answer',()=>{
 let state=receiveReplySnapshot(emptyReplyStream(),snapshot(5,draft()));
 state=receiveReplyEvent(state,event(7,draft('第一句。第二句。',{revision:3})));
 assert.equal(receiveReplySnapshot(state,snapshot(6,draft('第一句。',{revision:2}))),state);
 assert.equal(receiveReplyEvent(state,event(7,draft('重复',{revision:3}))),state);
 state=receiveReplyEvent(state,event(8,draft('旧尝试',{revision:1})));
 assert.equal(state.draft.text,'第一句。第二句。');
 assert.equal(state.seq,8);
});

test('abandonment hides old generation and retry replaces it rather than concatenating',()=>{
 let state=receiveReplySnapshot(emptyReplyStream(),snapshot(1,draft('旧回答')));
 state=receiveReplyEvent(state,event(2,draft('旧回答',{revision:2,status:'abandoned'})));
 assert.equal(replyPresentation(running,state),null);
 state=receiveReplyEvent(state,event(3,draft('重试的新回答',{attemptId:'b',revision:3})));
 assert.equal(replyPresentation(running,state).text,'重试的新回答');
 assert.equal(replyPresentation({id:'other',status:'running'},state),null);
});

test('a fresh host snapshot clears old drafts and late events from old connections are ignored',()=>{
 let state=receiveReplySnapshot(emptyReplyStream(),snapshot(8,draft('上次运行')));
 state=receiveReplySnapshot(state,snapshot(0,null,'new-host'));
 assert.equal(state.draft,null);
 assert.equal(receiveReplyEvent(state,event(9,draft('过期数据',{revision:2}))),state);
 state=receiveReplyEvent(state,event(1,draft('新宿主'),'new-host'));
 assert.equal(replyPresentation(running,state).text,'新宿主');
});

test('failed partials remain visible after reload while a completed result never shows a second bubble',()=>{
 const state=emptyReplyStream();
 for(const status of ['failed','cancelled','interrupted']){
  assert.deepEqual(replyPresentation({id:'r',status,partialText:'未完成的回答'},state),{
   text:'未完成的回答',label:'本轮未完成，已保留生成的内容。',interrupted:true,
  });
 }
 assert.equal(replyPresentation({id:'r',status:'completed',text:'完成',partialText:'旧片段'},state),null);
 const abandoned=receiveReplySnapshot(state,snapshot(2,draft('刚才已显示的片段',{revision:2,status:'abandoned'})));
 assert.equal(replyPresentation({id:'r',status:'failed'},abandoned).text,'刚才已显示的片段');
 assert.equal(replyPresentation(running,abandoned),null);
});

test('invalid or unrelated preview envelopes cannot populate an answer',()=>{
 const state=receiveReplySnapshot(emptyReplyStream(),snapshot());
 for(const value of [event(1,draft('x'.repeat(16001))),event(1,draft('',{status:'unknown'})),{...event(1,draft()),requestId:'other'}]){
  assert.equal(receiveReplyEvent(state,value),state);
 }
 assert.equal(receiveReplySnapshot(state,{replyStream:draft()}),state);
});
