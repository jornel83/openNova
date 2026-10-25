import test from 'node:test';import assert from 'node:assert/strict';
import {createResearchBudget} from '../research/budget.mjs';
function fixture(t,limits){let now=0,seq=0;const tasks=new Map();const timers={setTimeout(fn,ms){tasks.set(++seq,{at:now+ms,fn});return seq;},clearTimeout(id){tasks.delete(id);}};
 const budget=createResearchBudget({limits,now:()=>now,timers});const parent=new AbortController();budget.open('r',{signal:parent.signal});t.after(()=>budget.finish('r'));
 return {budget,parent,tasks,tick(ms){now+=ms;for(const [id,task] of [...tasks])if(task.at<=now){tasks.delete(id);task.fn();}}};
}
const search=(b,n)=>b.claim('r',{name:'web_search',args:{queries:['query '+n]},callId:'s'+n});
test('concurrent claims respect counts and duplicates do not dispatch',t=>{
 const {budget:b}=fixture(t);const a=search(b,1);assert.throws(()=>search(b,1),/duplicate/);const c=search(b,2);assert.throws(()=>search(b,3),/budget/);a.finish();c.finish();
 for(let i=0;i<6;i++)b.claim('r',{name:'web_fetch',args:{url:'https://example.com/'+i},callId:'f'+i}).finish();
 assert.throws(()=>b.claim('r',{name:'web_fetch',args:{url:'https://example.com/7'}}),/budget/);assert.equal(b.snapshot('r').searchCalls,2);
});
test('soft 60000ms closes new research and hard 90000ms cancels research but keeps parent alive',t=>{
 const {budget:b,tick,parent}=fixture(t);const a=b.claim('r',{kind:'exec',key:'script',timeoutMs:90000});tick(59999);assert.equal(b.snapshot('r').closed,false);
 tick(1);assert.equal(b.snapshot('r').closed,true);assert.throws(()=>b.claim('r',{kind:'read',key:'new'}),/budget/);assert.equal(a.signal.aborted,false);
 tick(30000);assert.equal(a.signal.aborted,true);assert.equal(parent.signal.aborted,false);a.finish();
});
test('tool timeout and caller cancellation release timers; next request resets',t=>{
 const {budget:b,tick,parent,tasks}=fixture(t);const a=search(b,1);tick(15000);assert.equal(a.signal.aborted,true);a.finish();
 parent.abort();b.finish('r');assert.equal(tasks.size,0);
 b.open('next',{signal:new AbortController().signal});assert.equal(b.snapshot('next').searchCalls,0);b.finish('next');
});
test('two_failed_sources_allow_third; changed_referer_can_retry',t=>{
 const {budget:b}=fixture(t);for(let i=0;i<2;i++)b.claim('r',{name:'web_fetch',args:{url:'https://example.com/'+i}}).finish({failed:true});
 b.claim('r',{name:'web_request',args:{url:'https://example.com/0',headers:{Referer:'https://finance.example/'}}}).finish();
 assert.equal(b.snapshot('r').readCalls,3);assert.equal(b.snapshot('r').fetchClosed,false);
 assert.throws(()=>b.claim('r',{name:'web_request',args:{url:'https://example.com/0',headers:{referer:'https://finance.example/'}}}),/duplicate/);
});
test('batch_query_cost_is_two and duplicate per-query cannot be hidden in a batch',t=>{
 const {budget:b}=fixture(t);b.claim('r',{name:'web_search',args:{queries:['one','two']}}).finish();assert.equal(b.snapshot('r').searchQueries,2);
 assert.throws(()=>search(b,3),/budget/);
 const {budget:c}=fixture(t);c.claim('r',{name:'web_search',args:{queries:['one']}}).finish();assert.throws(()=>c.claim('r',{name:'web_search',args:{queries:['one','three']}}),/duplicate/);
});
test('helper_counts_once independently of execution',t=>{
 const {budget:b}=fixture(t);const e=b.claim('r',{kind:'exec',key:'script'});b.claim('r',{kind:'read',key:'https://example.com'}).finish();e.finish();
 assert.equal(b.snapshot('r').researchExecCalls,1);assert.equal(b.snapshot('r').readCalls,1);
});
