import test from 'node:test';import assert from 'node:assert/strict';
import {createWebBudget} from '../web-budget.mjs';
test('count limits are claimed synchronously before concurrent dispatch; next request resets',()=>{
 const b=createWebBudget();b.startRequest(1);
 for(let i=0;i<6;i++)b.claimModel(1);assert.throws(()=>b.claimModel(1),/model_budget/);
 const leases=[b.claimTool({requestId:1,name:'web_search'}),b.claimTool({requestId:1,name:'web_search'})];
 assert.throws(()=>b.claimTool({requestId:1,name:'web_search'}),/tool_budget/);assert.throws(()=>b.claimTool({requestId:1,name:'bash'}),/unsupported_tool/);
 leases.forEach(l=>l.finish());b.finishRequest(1);b.startRequest(2);b.claimModel(2);b.finishRequest(2);assert.equal(b.size,0);
});
test('fake time enforces retrieval deadline during active tools and retains its cause',()=>{
 let now=0;const b=createWebBudget({now:()=>now});b.startRequest(1);
 const l=b.claimTool({requestId:1,name:'web_fetch'});now=45001;
 assert.throws(()=>b.claimTool({requestId:1,name:'web_fetch'}),/web_time_budget/);l.finish();
 now=90001;assert.throws(()=>b.claimModel(1),/web_time_budget/);b.finishRequest(1);
});
test('tool deadline and request deadline abort in-flight operations and dispose timers',async()=>{
 const b=createWebBudget({limits:{searchMs:10,requestMs:30}});const request=b.startRequest(1);const lease=b.claimTool({requestId:1,name:'web_search'});
 await new Promise(r=>setTimeout(r,18));assert.equal(lease.signal.aborted,true);lease.finish();
 await new Promise(r=>setTimeout(r,20));assert.equal(request.signal.aborted,true);b.finishRequest(1);assert.equal(b.size,0);
});
test('finishing an active request clears every owned timer',t=>{
 const timers=new Set();t.mock.method(globalThis,'setTimeout',fn=>{timers.add(fn);return fn;});t.mock.method(globalThis,'clearTimeout',id=>timers.delete(id));
 const b=createWebBudget();b.startRequest(1);b.claimTool({requestId:1,name:'web_fetch'});b.finishRequest(1);assert.equal(timers.size,0);
});
test('retrieval wall clock includes model time between tools',()=>{
 let now=0;const b=createWebBudget({now:()=>now}),r=b.startRequest(1);
 try {
  const first=b.claimTool({requestId:1,name:'web_search'});now=1000;first.finish();now=60000;
  assert.throws(()=>b.claimTool({requestId:1,name:'web_fetch'}),/web_time_budget/);
  assert.equal(r.signal.aborted,true);assert.throws(()=>b.claimModel(1),/web_time_budget/);
 }finally{b.finishRequest(1);}
});
