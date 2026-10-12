import test from 'node:test';import assert from 'node:assert/strict';
import {apply} from '../web-policy.mjs';import {createWebBudget} from '../web-budget.mjs';
test('hooks enforce model limits, tool cancellation and isolate late results by request',async()=>{
 const hooks={},events=[],budget=createWebBudget();let r={id:1,signal:budget.startRequest(1).signal};
 const agent={cancel(){}};
 apply({on:(n,f)=>hooks[n]=f},{budget,current:()=>r,onStatus:(...a)=>events.push(a),onResult:(...a)=>events.push(a),onFailure:()=>{}});
 const request=()=>hooks['agent/request']({agent,step:1},async()=>({}));
 for(let i=0;i<6;i++)await request();await assert.rejects(request(),/model_budget_exceeded/);
 const c=new AbortController(),exec={agent,name:'web_fetch',callId:'call',token:Symbol(),signal:c.signal};
 await hooks['tools/execute'](exec,async()=>{c.abort();assert.ok(exec.signal.aborted);return {isError:true,content:[]};});
 const count=events.length;r={id:2};hooks['tools/result'](exec,{meta:{url:'https://example.com',statusCode:200}});assert.equal(events.length,count);
 budget.finishRequest(1);
});
test('retrieval deadline cancels model continuation with a controlled error and next turn resets',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let now=0,cancelled=0;const hooks={},failures=[];
 const budget=createWebBudget({now:()=>now});let r={id:1,signal:budget.startRequest(1).signal};
 const agent={cancel(){cancelled++;}};
 apply({on:(n,f)=>hooks[n]=f},{budget,current:()=>r,onFailure:(_r,code)=>failures.push(code)});
 await hooks['agent/request']({agent,step:1},async()=>({}));
 const lease=budget.claimTool({requestId:1,name:'web_search'});now=1000;lease.finish();
 now=45000;t.mock.timers.tick(45000);
 assert.equal(cancelled,1);assert.deepEqual(failures,['web_time_budget']);
 budget.finishRequest(1);r={id:2,signal:budget.startRequest(2).signal};
 await hooks['agent/request']({agent,step:1},async()=>({}));assert.equal(r.signal.aborted,false);
 r.signal.removeEventListener('abort',r.abortListener);budget.finishRequest(2);
});

test('two failed reads stop tools and preserve a model turn for an honest final answer',async t=>{
 const hooks={},budget=createWebBudget();let r={id:1,signal:budget.startRequest(1).signal};
 t.after(()=>{budget.finishRequest(1);budget.finishRequest(2);});
 apply({on:(n,f)=>hooks[n]=f},{budget,current:()=>r});
 for(let i=0;i<2;i++){
  const exec={agent:{},name:'web_fetch',arguments:{url:`https://example.com/${i}`},callId:`c${i}`,token:Symbol(),signal:new AbortController().signal};
  await hooks['tools/execute'](exec,async()=>({isError:false,content:[{type:'text',text:'blocked'}],meta:{statusCode:418}}));
 }
 assert.equal(typeof hooks['system-prompt/assemble'],'function');
 const assembly=await hooks['system-prompt/assemble']({},{},async()=>({tools:[{name:'web_fetch'}],sections:[],contexts:[]}));
 assert.deepEqual(assembly.tools,[]);assert.equal(r.signal.aborted,false);
 await hooks['agent/request']({agent:{cancel(){}},step:3},async()=>({}));
 budget.finishRequest(1);r={id:2,signal:budget.startRequest(2).signal};
 const next=await hooks['system-prompt/assemble']({},{},async()=>({tools:[{name:'web_search'}]}));
 assert.equal(next.tools.length,1);budget.finishRequest(2);
});
test('reserve time for answering and never dispatch the same URL twice in a turn',async t=>{
 let now=0;const hooks={},budget=createWebBudget({now:()=>now}),r={id:1,signal:budget.startRequest(1).signal};
 t.after(()=>{budget.finishRequest(1);budget.finishRequest(2);});
 apply({on:(n,f)=>hooks[n]=f},{budget,current:()=>r});
 let dispatched=0;
 const exec=()=>({agent:{},name:'web_fetch',arguments:{url:'https://example.com/report#top'},callId:'c',token:Symbol(),signal:new AbortController().signal});
 const next=async()=>{dispatched++;return {content:[{type:'text',text:'report'}],meta:{statusCode:200}};};
 await hooks['tools/execute'](exec(),next);await hooks['tools/execute'](exec(),next);
 assert.equal(dispatched,1);budget.finishRequest(1);
 const r2={id:2,signal:budget.startRequest(2).signal},hooks2={};
 apply({on:(n,f)=>hooks2[n]=f},{budget,current:()=>r2});
 const lease=budget.claimTool({requestId:2,name:'web_search'});lease.finish();now=33000;
 assert.equal(typeof hooks2['system-prompt/assemble'],'function');
 const assembly=await hooks2['system-prompt/assemble']({},{},async()=>({tools:[{name:'web_search'}]}));
 assert.deepEqual(assembly.tools,[]);assert.equal(r2.signal.aborted,false);budget.finishRequest(2);
});
