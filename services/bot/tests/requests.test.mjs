import test from 'node:test';
import assert from 'node:assert/strict';
import {Requests} from '../requests.mjs';
function store(){const rows=new Map();return {list:()=>[...rows.values()],request:id=>{if(!rows.has(id))throw Error('unknown_id');return rows.get(id);},submit(id,input,source){if(rows.has(id)){const r=rows.get(id);if(r.input!==input)throw Error('request_conflict');return {...r,duplicate:true};}const r={id,input,source,status:'queued'};rows.set(id,r);return r;},finish(id,patch){const r={...rows.get(id),...patch};rows.set(id,r);return r;}};}
test('admission is synchronous and duplicate request never runs twice',async()=>{
  const ops=store();let calls=0,release;
  const requests=new Requests(ops,async()=>{calls++;await new Promise(r=>release=r);return {text:'ok'};});
  requests.submit('one','hello');assert.throws(()=>requests.submit('two','other'),/bot_busy/);
  assert.equal(requests.submit('one','hello').duplicate,true);
  await new Promise(r=>setImmediate(r));release();await requests.active.work;
  assert.equal(calls,1);assert.equal(ops.request('one').status,'completed');
});
test('cancel before the runner starts cannot admit model work',async()=>{
  const ops=store();let calls=0;
  const requests=new Requests(ops,async()=>{calls++;return {text:'wrong'};});
  requests.submit('one','hello');await requests.cancel('one');
  assert.equal(calls,0);assert.equal(ops.request('one').status,'cancelled');
});
test('restart marks unfinished requests interrupted without rerunning them',()=>{
  const ops=store();ops.submit('one','hello');
  new Requests(ops,async()=>assert.fail());
  assert.equal(ops.request('one').status,'interrupted');
});
test('cancel keeps foreground admission until native handoff cleanup has drained',async()=>{
 const ops=store();let finish,cleaned,entered;
 const ready=new Promise(r=>entered=r),requests=new Requests(ops,async(_,active)=>{
  active.cancel=()=>new Promise(r=>{cleaned=r;finish();});entered();await new Promise(r=>finish=r);
 });
 requests.submit('old','old input');await ready;
 const cancelled=requests.cancel('old');await new Promise(r=>setImmediate(r));
 assert.throws(()=>requests.submit('new','new input'),/bot_busy/);
 cleaned();await cancelled;assert.equal(requests.active,undefined);
});
test('failed cancellation remains exclusive but cleanup can be retried',async()=>{
 const ops=store();let finish,entered,attempts=0;
 const ready=new Promise(r=>entered=r),requests=new Requests(ops,async(_,active)=>{
  active.cancel=async()=>{finish();if(++attempts===1)throw Error('cancel_cleanup_failed');};
  entered();await new Promise(r=>finish=r);
 });
 requests.submit('old','old input');await ready;
 await assert.rejects(requests.cancel('old'),/cancel_cleanup_failed/);
 await requests.active.work;
 assert.throws(()=>requests.submit('new','new input'),/bot_busy/);
 await requests.cancel('old');assert.equal(ops.request('old').status,'cancelled');assert.equal(requests.active,undefined);assert.equal(attempts,2);
});
