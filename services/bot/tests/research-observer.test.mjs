import test from 'node:test';
import assert from 'node:assert/strict';
import {installResearch} from '../research/runtime.mjs';
function fixture(t){
 const hooks={},rows=new Map(),requests={},warnings=[];
 const ops={put:r=>(rows.set(r.id,r),r),finish:(id,p)=>rows.set(id,{...rows.get(id),...p}),list:k=>[...rows.values()].filter(r=>r.kind===k),request:id=>rows.get(id)};
 const ctx={on:(n,f)=>hooks[n]=f,systemPrompt:{context(){}}};
 const runtime=installResearch(ctx,{ops,requests,config:{mode:'native',enabled:true,available:true,botId:'b',workspace:'/fixture'},onObservationError:e=>warnings.push(e)});t.after(()=>runtime.close());
 function begin(id){const controller=new AbortController(),r={id,sessionId:'session-'+id,signal:controller.signal,cancelled:false};requests.active=r;runtime.begin(r);return {...r,controller};}
 const event=(r,type,data)=>hooks['session/event']({id:r.sessionId},{type,data});
 const call=(r,id,name='web_search',args={queries:['weather']})=>event(r,'tool/call',{callId:id,name,arguments:JSON.stringify(args)});
 const result=(r,id,{content=[],meta,isError=false,error}={})=>event(r,'tool/result',{message:{role:'tool',toolCallId:id,source:{kind:'tool',callId:id},content,isError},meta,error});
 return {hooks,rows,ops,requests,runtime,warnings,begin,event,call,result};
}
test('native observer installs no execution or budget middleware; original failure remains intact',t=>{
 const f=fixture(t);assert.equal(f.hooks['tools/execute'],undefined);assert.equal(f.hooks['system-prompt/assemble'],undefined);
 const r=f.begin('one');f.call(r,'failed','web_fetch',{url:'https://example.com/a'});
 const payload={content:[{type:'text',text:'Error: web fetch failed: TLS connection reset'}],isError:true,error:{code:'WEB_PROVIDER_ERROR'}};
 const before=JSON.stringify(payload);f.result(r,'failed',payload);assert.equal(JSON.stringify(payload),before);
 const op=f.ops.list('tool')[0];assert.equal(op.status,'failed');assert.match(op.output,/TLS connection reset/);assert.equal(op.errorCode,'WEB_PROVIDER_ERROR');
 for(let i=0;i<4;i++){f.call(r,'search'+i);f.result(r,'search'+i,{meta:{sources:[{url:'https://example.com/'+i,title:'Link'}]}});}
 assert.equal(f.runtime.sources.forRequest(r.id).length,4);assert.equal(f.ops.request(r.id).research.usage.searchCalls,4);
 assert.equal(f.runtime.sources.forRequest(r.id)[0].evidenceType,'search_link');
});
test('native HTTP errors are not evidence and a later source succeeds',t=>{
 const f=fixture(t),r=f.begin('r');
 f.call(r,'bad','web_fetch',{url:'https://example.com/bad'});f.result(r,'bad',{content:[{type:'text',text:'Fetched URL (HTTP 503)'}],meta:{url:'https://example.com/bad',statusCode:503}});
 assert.equal(f.runtime.sources.forRequest(r.id).length,0);assert.equal(f.ops.list('tool')[0].status,'failed');
 f.call(r,'good','web_fetch',{url:'https://example.com/good'});f.result(r,'good',{content:[{type:'text',text:'Weather on specified date: 12 C'}],meta:{url:'https://example.com/good',statusCode:200,truncated:false}});
 const [source]=f.runtime.sources.forRequest(r.id);assert.equal(source.url,'https://example.com/good');assert.equal(source.evidenceType,'page_response');
 assert.equal(f.ops.request(r.id).research.outcome,'partial');
});
test('voice progress has a distinct call id for every search and tracks pending reads',t=>{
 const f=fixture(t),r=f.begin('r');f.call(r,'a');assert.equal(f.ops.request(r.id).research.callId,'a');
 f.call(r,'b','web_fetch',{url:'https://example.com/b'});assert.equal(f.ops.request(r.id).research.callId,'b');
 f.result(r,'a',{meta:{sources:[]}});assert.equal(f.ops.request(r.id).research.phase,'reading');assert.equal(f.ops.request(r.id).research.callId,'b');
 f.result(r,'b',{meta:{url:'https://example.com/b',statusCode:200}});assert.equal(f.ops.request(r.id).research.phase,'summarizing');
});
test('late results after cancellation and unrelated sessions cannot contaminate new request',t=>{
 const f=fixture(t),old=f.begin('old');f.call(old,'same');old.controller.abort();f.runtime.finish(old.id);
 const current=f.begin('new');f.call(current,'same');
 f.result(old,'same',{meta:{sources:[{url:'https://example.com/old'}]}});
 f.result(current,'same',{meta:{sources:[{url:'https://example.com/new',snippet:'Observed fact'}]}});
 assert.deepEqual(f.runtime.sources.forRequest('old'),[]);assert.equal(f.runtime.sources.forRequest('new').length,1);
 assert.equal(f.ops.list('tool').find(x=>x.requestId==='old').status,'cancelled');
});
test('recording failure does not throw into native event dispatch',t=>{
 const f=fixture(t),r=f.begin('r');f.ops.put=()=>{throw Error('disk unavailable');};
 assert.doesNotThrow(()=>f.call(r,'c'));assert.ok(f.warnings.length);
});
test('native JSON arguments retain search queries and requested redirect URL',t=>{
 const f=fixture(t),r=f.begin('r');f.call(r,'search','web_search',{queries:['北京下周六天气']});
 f.result(r,'search',{meta:{sources:[{url:'https://example.com/a'}]}});
 assert.deepEqual(f.runtime.sources.forRequest(r.id)[0].queries,['北京下周六天气']);
 f.call(r,'read','web_fetch',{url:'https://example.com/redirect'});
 f.result(r,'read',{meta:{url:'https://example.com/final',statusCode:200}});
 assert.equal(f.ops.list('research_observation').find(o=>o.callId==='read').requestedUrl,'https://example.com/redirect');
});
test('one failed source write cannot strand a completed tool or discard other sources',t=>{
 const f=fixture(t),r=f.begin('r'),put=f.ops.put;let fail=true;
 f.ops.put=record=>{if(record.kind==='research_observation'&&fail){fail=false;throw Error('one write failed');}return put(record);};
 f.call(r,'c');f.result(r,'c',{meta:{sources:[{url:'https://example.com/a'},{url:'https://example.com/b'}]}});
 f.runtime.finish(r.id);
 assert.equal(f.ops.list('tool')[0].status,'completed');assert.equal(f.runtime.sources.forRequest(r.id).length,1);assert.equal(f.warnings.length,1);
});
test('failed terminal tool write remains available for finish cleanup',t=>{
 const f=fixture(t),r=f.begin('r'),put=f.ops.put;let fail=true;
 f.ops.put=record=>{if(record.kind==='tool'&&record.status==='completed'&&fail){fail=false;throw Error('one terminal write failed');}return put(record);};
 f.call(r,'c');f.result(r,'c',{meta:{sources:[]}});f.runtime.finish(r.id);
 assert.equal(f.ops.list('tool')[0].status,'completed');assert.equal(f.warnings.length,1);
});
test('late results cannot attach to the next request reusing the same DSH session',t=>{
 const f=fixture(t),old=f.begin('old');f.call(old,'old-call');old.controller.abort();f.runtime.finish(old.id);
 const current=f.begin('new');current.sessionId=old.sessionId;f.requests.active.sessionId=old.sessionId;f.call(current,'new-call');
 f.result(old,'old-call',{meta:{sources:[{url:'https://example.com/old'}]}});
 f.result(current,'new-call',{meta:{sources:[{url:'https://example.com/new'}]}});
 assert.deepEqual(f.runtime.sources.forRequest('old'),[]);assert.deepEqual(f.runtime.sources.forRequest('new').map(s=>s.url),['https://example.com/new']);
});
test('unavailable source store cannot discard a completed assistant answer',t=>{
 const f=fixture(t),r=f.begin('r');f.ops.list=()=>{throw Error('source store unavailable');};
 const reply=f.runtime.reply('已完成查询。',r.id);
 assert.equal(reply.text,'已完成查询。');assert.equal(reply.speechText,'已完成查询。');assert.deepEqual(reply.sources,[]);
});
test('native sources survive refresh and recall without fetching; Shell URLs are not promoted',t=>{
 const f=fixture(t),r=f.begin('r');f.call(r,'shell','bash',{command:'echo https://example.com'});f.result(r,'shell',{content:[{type:'text',text:'https://example.com'}]});
 assert.equal(f.runtime.sources.forRequest(r.id).length,0);
 f.call(r,'c');f.result(r,'c',{meta:{sources:[{url:'https://example.com',snippet:'Fact'}]}});
 const data=f.runtime.sourceTool[3]({requestId:r.id});assert.equal(data.sources.length,1);
 const reply=f.runtime.reply('参见[来源](https://example.com/)。',r.id);assert.equal(reply.sources.length,1);assert.doesNotMatch(reply.speechText,/https:/);
 f.runtime.finish(r.id);assert.equal(f.runtime.refresh({...reply,id:r.id}).sources.length,1);
});
