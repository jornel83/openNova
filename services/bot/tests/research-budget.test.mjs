import test from 'node:test';import assert from 'node:assert/strict';
import {createResearchBudget} from '../research/budget.mjs';
function fixture(t,limits){let now=0,seq=0;const tasks=new Map();const timers={setTimeout(fn,ms){tasks.set(++seq,{at:now+ms,fn});return seq;},clearTimeout(id){tasks.delete(id);}};
 const budget=createResearchBudget({limits,now:()=>now,timers});const parent=new AbortController();budget.open('r',{signal:parent.signal});t.after(()=>budget.finish('r'));
 return {budget,parent,tasks,tick(ms){now+=ms;for(const [id,task] of [...tasks])if(task.at<=now){tasks.delete(id);task.fn();}}};
}
const search=(b,n)=>b.claim('r',{name:'web_search',args:{queries:['query '+n]},callId:'s'+n});
test('concurrent claims respect counts and duplicates do not dispatch',t=>{
 const {budget:b}=fixture(t);const a=search(b,1);assert.throws(()=>search(b,1),/duplicate/);const c=search(b,2);assert.throws(()=>search(b,3),/budget/);a.finish();c.finish();
 for(let i=0;i<3;i++)b.claim('r',{name:'web_fetch',args:{url:'https://example.com/'+i},callId:'f'+i}).finish();
 assert.throws(()=>b.claim('r',{name:'web_fetch',args:{url:'https://example.com/4'}}),/budget/);assert.equal(b.snapshot('r').searchCalls,2);
});
test('soft deadline blocks new work without aborting the parent; hard deadline aborts leases',t=>{
 const {budget:b,tick,parent}=fixture(t);const a=search(b,1);tick(14999);a.finish();tick(14000);
 const c=search(b,2);tick(1001);assert.equal(b.snapshot('r').closed,true);assert.throws(()=>b.claim('r',{name:'web_fetch',args:{url:'https://example.com'}}),/budget/);
 assert.equal(c.signal.aborted,false);tick(15000);assert.equal(c.signal.aborted,true);assert.equal(parent.signal.aborted,false);
});
test('tool timeout and caller cancellation release timers; next request resets',t=>{
 const {budget:b,tick,parent,tasks}=fixture(t);const a=search(b,1);tick(15000);assert.equal(a.signal.aborted,true);a.finish();
 parent.abort();b.finish('r');assert.equal(tasks.size,0);
 b.open('next',{signal:new AbortController().signal});assert.equal(b.snapshot('next').searchCalls,0);b.finish('next');
});
test('two body failures close only fetching',t=>{
 const {budget:b}=fixture(t);for(let i=0;i<2;i++)b.claim('r',{name:'web_fetch',args:{url:'https://example.com/'+i}}).finish({failed:true});
 assert.throws(()=>b.claim('r',{name:'web_fetch',args:{url:'https://example.com/other'}}),/read_failures/);
 search(b,1).finish();assert.equal(b.snapshot('r').fetchCalls,2);
});
