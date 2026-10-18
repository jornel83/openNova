import test from 'node:test';
import assert from 'node:assert/strict';
import {readEvents} from '../web/events.mjs';
const cursor={hostEpoch:'host',seq:0};
const event=(seq=1)=>({hostEpoch:'host',seq,type:'work.context',payload:{text:'中文引用'}});
function response(chunks){return new Response(new ReadableStream({start(c){for(const chunk of chunks)c.enqueue(chunk);c.close();}}));}
test('SSE client handles split UTF-8 and frames, ignores heartbeats and duplicate sequence numbers',async()=>{
 const bytes=new TextEncoder().encode(': heartbeat\n\ndata: '+JSON.stringify(event())+'\n\ndata: '+JSON.stringify(event())+'\n\n'),seen=[];
 await assert.rejects(readEvents(response([...bytes].map(b=>new Uint8Array([b]))),e=>seen.push(e),{cursor}),/event_stream_closed/);
 assert.equal(seen.length,1);assert.equal(seen[0].payload.text,'中文引用');
});
test('SSE client detects sequence gaps and host restart for snapshot recovery',async()=>{
 for(const value of [event(2),{...event(),hostEpoch:'new'}])await assert.rejects(readEvents(response([new TextEncoder().encode('data: '+JSON.stringify(value)+'\n\n')]),()=>{}, {cursor}),/cursor_reset/);
});
