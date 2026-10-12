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
