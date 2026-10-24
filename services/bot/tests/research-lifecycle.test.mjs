import test from 'node:test';import assert from 'node:assert/strict';
import {installResearch} from '../research/runtime.mjs';
function fixture(t){const hooks={},rows=new Map(),requests={};const ctx={on:(name,f)=>hooks[name]=f,systemPrompt:{context(){}}};
 const ops={put:r=>(rows.set(r.id,r),r),finish:(id,r)=>rows.set(id,{...rows.get(id),...r}),list:k=>[...rows.values()].filter(r=>r.kind===k)};
 const runtime=installResearch(ctx,{ops,requests,config:{available:true,limits:{searchCalls:1,searchMs:10}}});t.after(()=>runtime.close());
 function begin(id){const controller=new AbortController(),r={id,controller,signal:controller.signal};requests.active=r;runtime.begin(r);return r;}
 const run=(r,call,next)=>hooks['tools/execute']({name:'web_search',arguments:{queries:[call]},callId:call,signal:r.signal},next);
 return {hooks,rows,requests,runtime,begin,run};
}
test('research_exhaustion_keeps_write_and_bash_available',async t=>{
 const f=fixture(t),r=f.begin('r');await f.run(r,'one',async()=>({meta:{sources:[{url:'https://example.com'}]}}));
 let dispatched=false;const blocked=await f.run(r,'two',async()=>{dispatched=true;return {meta:{sources:[]}};});assert.equal(blocked.isError,true);assert.equal(dispatched,false);
 for(const name of ['write','bash'])assert.equal(await f.hooks['tools/execute']({name},async()=>name),name);
 assert.equal(r.signal.aborted,false);
});
test('cancel_drops_late_results_and_next_request_resets',async t=>{
 const f=fixture(t),old=f.begin('old');let resolve;
 const work=f.run(old,'old-call',()=>new Promise(r=>resolve=r));await Promise.resolve();old.cancelled=true;old.controller.abort();f.runtime.finish('old');
 const current=f.begin('new');resolve({meta:{sources:[{url:'https://example.com/old'}]}});await work;
 await f.run(current,'new-call',async()=>({meta:{sources:[{url:'https://example.com/new'}]}}));
 const sources=[...f.rows.values()].filter(x=>x.kind==='research_observation');assert.equal(sources.length,1);assert.equal(sources[0].requestId,'new');
});
test('deadline bounds a provider ignoring abort and never stores its late result',{timeout:200},async t=>{
 const f=fixture(t),r=f.begin('r');let release;
 const out=await f.run(r,'slow',()=>new Promise(resolve=>release=resolve));assert.equal(out.isError,true);assert.equal(out.error.info.code,'timeout');
 release({meta:{sources:[{url:'https://example.com/late'}]}});await new Promise(resolve=>setImmediate(resolve));
 assert.equal([...f.rows.values()].filter(x=>x.kind==='research_observation').length,0);
});

test('cancelling before dispatch prevents any provider invocation',async t=>{
 const f=fixture(t),r=f.begin('r');let dispatched=0;
 const work=f.run(r,'early',async()=>{dispatched++;return {meta:{sources:[]}};});r.cancelled=true;r.controller.abort();await work;assert.equal(dispatched,0);
});
test('exhausted tools are removed while unrelated tools remain',async t=>{
 const f=fixture(t),r=f.begin('r');await f.run(r,'one',async()=>({meta:{sources:[{url:'https://example.com'}]}}));
 const assembled=await f.hooks['system-prompt/assemble']({}, {},async()=>({tools:['web_search','web_fetch','write','bash'].map(name=>({name}))}));
 assert.deepEqual(assembled.tools.map(t=>t.name),['web_fetch','write','bash']);
});
