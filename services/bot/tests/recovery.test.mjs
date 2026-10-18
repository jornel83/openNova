import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Operations} from '../operations.mjs';
import {MemoryApprovals} from '../memory.mjs';
import {Requests} from '../requests.mjs';
import {admitText,withoutNativeChannel,ownResources} from '../lifecycle.mjs';

function fixture(t){
 const home=mkdtempSync(join(tmpdir(),'bot-recovery-'));const ops=new Operations({home,workspace:join(home,'project')});
 t.after(()=>{ops.close();rmSync(home,{recursive:true,force:true});});
 let entries=[],crash=false,writes=0,invalidated=0;
 const memory=new MemoryApprovals(ops,{view:async()=>{if(crash&&writes)throw Error('simulated_crash_after_write');return {entries};},context:async()=>({messageIds:['old']}),invalidate:async()=>{invalidated++;},execute:async(tool,args)=>{
   writes++;
   if(tool==='forget')entries=entries.filter(e=>e.text!==args.entry);
   else if(args.replace)entries=entries.map(e=>e.text===args.replace?{...e,text:args.text}:e);
   else entries.push({scope:'own',text:args.text});
   if(crash)throw Error('simulated_crash_after_write');
   return 'Saved to memory';
 }});
 return {ops,memory,get writes(){return writes;},get invalidated(){return invalidated;},set crash(v){crash=v;},get entries(){return entries;},set entries(v){entries=v;}};
}
for(const tool of ['add','replace','forget'])test(`memory ${tool}: crash after mutation reconciles without another write`,async t=>{
 const f=fixture(t);f.entries=tool==='add'?[]:[{scope:'own',text:'old fact',topic:'preferences'}];
 const p=await f.memory.propose(tool==='forget'?'forget':'remember',tool==='add'?{text:'new fact'}:tool==='replace'?{text:'new fact',replace:'old',topic:'preferences'}:{entry:'old',topic:'preferences'});
 f.crash=true;await assert.rejects(f.memory.approve(p.id),/simulated_crash/);
 assert.equal(f.ops.get(p.id).status,'applying');f.crash=false;
 await f.memory.recover();assert.equal(f.ops.get(p.id).status,'applied');assert.equal(f.writes,1);assert.equal(f.invalidated,1);
 if(tool!=='add')assert.equal(f.ops.retired()[0].text,'old fact');
});
test('memory proposal binds exact text and topic before human approval',async t=>{
 const f=fixture(t);f.entries=[{scope:'own',text:'old fact',topic:'one'}];
 const p=await f.memory.propose('forget',{entry:'old',topic:'one'});
 f.entries=[{scope:'own',text:'old changed fact',topic:'one'}];
 await assert.rejects(f.memory.approve(p.id),/memory_match_changed/);assert.equal(f.writes,0);
});
test('approval holds admission across awaits, competing transitions are rejected',async t=>{
 const f=fixture(t),requests=new Requests(f.ops,async()=>({text:'x'}));let release;
 const held=requests.exclusive(()=>new Promise(r=>release=r));
 assert.throws(()=>requests.submit('other','hello'),/bot_busy/);
 await assert.rejects(requests.exclusive(()=>{}),/bot_busy/);
 release();await held;assert.equal(requests.submit('other','hello').status,'queued');await requests.active.work;
});
test('cancellation during async agent resolution cannot enqueue a turn',async()=>{
 let release,followups=0;const active={cancelled:false};
 const work=admitText({active,resolve:()=>new Promise(r=>release=r),message:{}});
 active.cancelled=true;release({followup(){followups++;},cancel(){},whenIdle:async()=>{}});
 await work;assert.equal(followups,0);
});
test('native bot API registration is disabled while effects retain context',()=>{
 let registered=0;const ctx={connection:{fetch:{register(){registered++;}}},effect:f=>f()};
 const restricted=withoutNativeChannel(ctx);restricted.effect(()=>restricted.connection.fetch.register({path:'/bot'}));assert.equal(registered,0);
});
test('effect cleanup drains work before closing resources and runs once on startup error',async()=>{
 const effects=[],order=[];const ctx={effect:fn=>effects.push(fn())};
 const resource=ownResources(ctx);resource.add(()=>order.push('database'));resource.add(async()=>{await Promise.resolve();order.push('work');});
 await resource.close();await effects[0]();assert.deepEqual(order,['work','database']);
});
test('late resources after disposal are immediately released and startup is rejected',async()=>{
 const effects=[],ctx={effect:fn=>effects.push(fn())},owner=ownResources(ctx);let released=0;
 await owner.close();assert.throws(()=>owner.assertOpen(),/disposed/);
 owner.add(()=>released++);await Promise.resolve();assert.equal(released,1);
});
test('definite memory rejection stays queryable and does not block recovery',async t=>{
 const f=fixture(t);f.memory.execute=async()=> 'memory capacity exceeded';
 const p=await f.memory.propose('remember',{text:'new'});
 await assert.rejects(f.memory.approve(p.id),/memory_apply_failed/);
 assert.equal(f.ops.get(p.id).status,'failed');await f.memory.recover();assert.equal(f.ops.get(p.id).status,'failed');
});
test('memory uses supplied upstream normalization and deduplicates across topics',async t=>{
 const f=fixture(t);f.memory.cleanEntry=s=>s.split(' [')[0];f.memory.cleanTopic=s=>s.toLowerCase();
 const p=await f.memory.propose('remember',{text:'new [added: today]',topic:'Preferences'});
 assert.equal(p.args.text,'new');assert.equal(p.args.topic,'preferences');
 f.entries=[{scope:'own',text:'new',topic:'elsewhere'}];await f.memory.approve(p.id);assert.equal(f.writes,0);
});
test('upstream error after deleting memory still retires the fact and invalidates snapshots',async t=>{
 const f=fixture(t);f.entries=[{scope:'own',topic:null,text:'old fact'}];
 const p=await f.memory.propose('forget',{entry:'old'});
 assert.equal(Object.hasOwn(p.args,'topic'),false);
 f.memory.execute=async()=>{f.entries=[];return 'journal write failed';};
 await f.memory.approve(p.id);assert.equal(f.ops.get(p.id).status,'applied');assert.equal(f.invalidated,1);assert.equal(f.ops.retired()[0].text,'old fact');
});

test('direct memory add, correction and deletion persist without an approval roundtrip',async t=>{
 const f=fixture(t);
 const added=await f.memory.mutate('remember',{text:'test old'});
 assert.equal(added.status,'applied');assert.equal(added.executionMode,'direct');
 assert.deepEqual(f.entries,[{scope:'own',text:'test old'}]);
 const changed=await f.memory.mutate('remember',{text:'test new',replace:'test old'});
 assert.equal(changed.status,'applied');assert.equal(f.entries[0].text,'test new');
 assert.ok(f.ops.retired().some(r=>r.text==='test old'));
 await f.memory.mutate('forget',{entry:'test new'});
 assert.deepEqual(f.entries,[]);assert.equal(f.writes,3);assert.equal(f.invalidated,3);
 assert.ok(f.ops.list('approval').every(r=>r.status==='applied'));
});

test('memory recovery finishes a direct intent but leaves old manual proposals untouched',async t=>{
 const f=fixture(t);
 const old=await f.memory.propose('remember',{text:'manual old'});
 const direct=await f.memory.propose('remember',{text:'direct new'},'direct');
 await f.memory.recover();
 assert.equal(f.ops.get(old.id).status,'pending');assert.equal(f.ops.get(direct.id).status,'applied');
 assert.deepEqual(f.entries,[{scope:'own',text:'direct new'}]);
});

test('stopping during memory preparation prevents the write and restart cannot revive it',async t=>{
 const f=fixture(t),controller=new AbortController();let release,entered;
 const prepared=new Promise(r=>entered=r);
 f.memory.context=()=>{entered();return new Promise(r=>release=r);};
 const work=f.memory.mutate('remember',{text:'cancelled fact'},controller.signal);
 await prepared;controller.abort();release({messageIds:[]});
 await assert.rejects(work,/abort/i);
 assert.deepEqual(f.entries,[]);assert.equal(f.writes,0);
 assert.equal(f.ops.list('approval')[0].status,'cancelled');
 await f.memory.recover();assert.deepEqual(f.entries,[]);
});

test('a reported memory preparation failure is not saved later by recovery',async t=>{
 const f=fixture(t);f.memory.context=async()=>{throw Error('context_unavailable');};
 await assert.rejects(f.memory.mutate('remember',{text:'failed fact'}),/context_unavailable/);
 assert.equal(f.ops.list('approval')[0].status,'failed');assert.deepEqual(f.entries,[]);
 f.memory.context=async()=>({messageIds:[]});
 await f.memory.recover();assert.deepEqual(f.entries,[]);assert.equal(f.writes,0);
});
