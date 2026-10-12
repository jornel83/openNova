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
