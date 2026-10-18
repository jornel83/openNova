import test from 'node:test';import assert from 'node:assert/strict';
import {createCommandRunner,reconnectDelay} from '../connection.mjs';
test('duplicate IDs share execution; persisted in-flight IDs are unknown after worker restart',async()=>{
 let saved={},calls=0,finish;const storage={get:async()=>structuredClone(saved),set:async x=>{saved=structuredClone(x);}};
 const run=createCommandRunner({storage,execute:async()=>{calls++;return new Promise(r=>finish=r);}});
 const command={id:'c',method:'open',args:{url:'https://example.com'},deadlineAt:Date.now()+10000};
 const first=run(command),second=run(command);await new Promise(r=>setImmediate(r));assert.equal(calls,1);
 const restarted=createCommandRunner({storage,execute:async()=>{throw Error('must not replay');}});
 assert.equal((await restarted(command)).status,'unknown');
 finish({status:'completed'});assert.deepEqual(await first,await second);assert.equal((await run(command)).status,'completed');assert.equal(calls,1);
 assert.equal((await run({...command,args:{}})).error,'command_id_conflict');
});
test('expired and unsupported commands do not execute; reconnect backs off and caps',async()=>{
 const run=createCommandRunner({storage:{get:async()=>({}),set:async()=>{}},execute:()=>{throw Error('not called');}});
 assert.equal((await run({id:'c',method:'read',deadlineAt:1})).status,'cancelled');
 assert.equal((await run({id:'d',method:'shell',deadlineAt:Date.now()+1000})).error,'unsupported_method');
 assert.equal(reconnectDelay(0),1000);assert.equal(reconnectDelay(10),30000);
});
test('large DOM snapshots stay within the 128 KiB wire limit with visible truncation',async()=>{
 const {boundedResult}=await import('../connection.mjs');
 const r=boundedResult({id:'large',status:'completed',snapshot:{text:'中文'.repeat(6000),truncated:false,targets:Array.from({length:100},(_,i)=>({ref:'t'+i,name:'long',href:'https://example.test/'+('x'.repeat(8000))}))}});
 assert.equal(r.status,'completed');assert.ok(new TextEncoder().encode(JSON.stringify({type:'result',result:r})).length<=131072);assert.equal(r.snapshot.targetsTruncated,true);
});
