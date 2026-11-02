import test from 'node:test';import assert from 'node:assert/strict';
import {createReplyStream} from '../reply-stream.mjs';
import {createEvents} from '../desktop/events.mjs';
import {setTimeout as delay} from 'node:timers/promises';

function fixture(t,{enabled=true}={}){
 const events=createEvents(),seen=[],cursor=events.snapshot(()=>null).cursor;events.subscribe(cursor,e=>seen.push(e));
 const stream=createReplyStream({events,enabled,delayMs:5});const active={id:'r',started:true,sessionId:'s',signal:new AbortController().signal};
 stream.begin('r');const frame=(type,extra={})=>stream.observe({type,attemptId:'a',sessionId:'s',at:Date.now(),...extra},active);
 t.after(()=>{stream.close();events.close();});return {stream,active,frame,seen,events};
}
test('drafts are bounded full snapshots, throttled, and settled only against final result',async t=>{
 const {stream,frame,seen}=fixture(t);frame('start');frame('model-text');frame('answer-start');
 for(const text of ['第','第一','第一句。'])frame('text',{text});
 assert.equal(seen.length,1);await delay(10);assert.equal(seen.length,2);
 assert.equal(seen.at(-1).payload.speechText,'第一句。');assert.equal(seen.at(-1).payload.revision,2);
 frame('settled');const result=stream.finish('r',{text:'第一句。',speechText:'第一句。'});
 assert.equal(result.replyStream.status,'settled');assert.ok(result.replyTimings.firstModelTextAt);assert.ok(result.replyTimings.firstSpeechDraftAt);
 frame('text',{text:'late'});assert.equal(stream.snapshot().text,'第一句。');
});
test('other sessions, compaction and cancelled request callbacks are ignored',t=>{
 const {stream,frame,active}=fixture(t);
 frame('start',{sessionId:'other'});frame('answer-start',{sessionId:'other'});assert.equal(stream.snapshot(),null);
 frame('start',{purpose:'compaction'});frame('answer-start',{purpose:'compaction'});assert.equal(stream.snapshot(),null);
 active.cancelled=true;frame('start');frame('answer-start');assert.equal(stream.snapshot(),null);
});
test('replacement and cancellation invalidate previews; partial text is not a completed answer',t=>{
 const {stream,frame,seen}=fixture(t);frame('start');frame('answer-start');frame('text',{text:'第一句。'});
 frame('start',{attemptId:'b'});assert.equal(seen.at(-1).payload.status,'abandoned');
 frame('answer-start',{attemptId:'b'});frame('text',{attemptId:'b',text:'重新回答。'});
 stream.cancel('r');assert.equal(stream.snapshot().status,'abandoned');
 const failed=stream.finish('r',undefined,{cancelled:true});assert.equal(failed.partialText,'重新回答。');assert.equal(failed.text,undefined);
});
test('final answer disagreement invalidates early speech while preserving authoritative result',t=>{
 const {stream,frame}=fixture(t);frame('start');frame('answer-start');frame('text',{text:'第一句。'});
 const result=stream.finish('r',{text:'第二句。',speechText:'第二句。'});
 assert.equal(result.replyStream.status,'abandoned');assert.equal(result.replyStream.reason,'final_result_changed');
});
test('settled fallback publishes no drafts',t=>{
 const {stream,frame,seen}=fixture(t,{enabled:false});frame('start');frame('answer-start');frame('text',{text:'答案。'});
 stream.finish('r',{text:'答案。',speechText:'答案。'});assert.equal(stream.snapshot(),null);assert.equal(seen.length,0);
});
