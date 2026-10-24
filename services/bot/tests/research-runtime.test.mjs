import test from 'node:test';import assert from 'node:assert/strict';
import {installResearch} from '../research/runtime.mjs';
export function fixture(){
 const hooks={},rows=new Map(),controller=new AbortController();
 const active={id:'r1',controller,signal:controller.signal,cancelled:false};
 const requests={active};const ops={put:r=>(rows.set(r.id,r),r),finish:(id,p)=>rows.set(id,{...rows.get(id),...p}),list:k=>[...rows.values()].filter(r=>r.kind===k)};
 const ctx={on:(name,fn)=>{hooks[name]=fn;},systemPrompt:{context(){}}};
 const runtime=installResearch(ctx,{ops,requests,config:{enabled:true,available:true,provider:'deepseek'}});runtime.begin(active);
 return {hooks,rows,active,requests,runtime};
}
test('search executes in the Bot request and records success without a browser',async t=>{
 const f=fixture();t.after(()=>f.runtime.close());
 const result={isError:false,meta:{sources:[{url:'https://example.com',title:'Weather',snippet:'20 C'}]}};
 const out=await f.hooks['tools/execute']({name:'web_search',arguments:{queries:['weather']},callId:'c1',signal:f.active.signal},async()=>result);
 assert.equal(out,result);const op=[...f.rows.values()].find(r=>r.kind==='tool');assert.equal(op.status,'completed');assert.equal(op.requestId,'r1');assert.equal(op.tool,'web_search');
});
test('non research tools bypass middleware unchanged',async t=>{
 const f=fixture();t.after(()=>f.runtime.close());assert.equal(await f.hooks['tools/execute']({name:'bash'},async()=>42),42);
});
test('cancelled_result_cannot_create_observation',async t=>{
 const f=fixture();t.after(()=>f.runtime.close());let release;
 const work=f.hooks['tools/execute']({name:'web_search',arguments:{queries:['weather']},callId:'c2',signal:f.active.signal},()=>new Promise(r=>release=r));
 f.active.cancelled=true;f.active.controller.abort();release({isError:false,meta:{sources:[{url:'https://example.com'}]}});await work;
 assert.equal([...f.rows.values()].find(r=>r.kind==='tool').status,'cancelled');
 assert.equal([...f.rows.values()].filter(r=>r.kind==='research_observation').length,0);
});
