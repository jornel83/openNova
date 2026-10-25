import test from 'node:test';
import assert from 'node:assert/strict';
let install;try{({installModelGate:install}=await import('../model-gate.mjs'));}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
function fixture(){
 const bot={id:'bot',segments:[{sessionId:'old'}]},records=[];let hook,active;
 const rt={chatOf:()=> 'current',ownRequest:o=>o.messages===tagged};const tagged=[];
 assert.equal(typeof install,'function');
 install({on:(_,fn)=>{hook=fn;}},{rt,bot,getActive:()=>active,onMaintenance:x=>records.push(x)});
 const opts={provider:'opennova-chatgpt',model:'gpt-6.1-sol',sessionId:'current',messages:[],purpose:'compaction'};
 const run=(o=opts,next=async function*(){yield {type:'finish',reason:{kind:'stop'}};})=>Array.fromAsync(hook(o,next));
 return {run,opts,records,setActive:x=>{active=x;},tagged};
}
test('idle native compaction for current or archived owned part reaches the model',async()=>{
 const f=fixture();for(const sessionId of ['current','old','bot'])assert.equal((await f.run({...f.opts,sessionId})).at(-1).reason.kind,'stop');
 assert.deepEqual(f.records.map(r=>r.status),['running','completed','running','completed','running','completed']);
});
test('maintenance does not authorize unrelated sessions, purposes or a substituted model',async()=>{
 const f=fixture();for(const patch of [{sessionId:'other'},{sessionId:undefined},{purpose:'other'},{purpose:undefined}])await assert.rejects(async()=>f.run({...f.opts,...patch}),/bridge_request_required/);
 await assert.rejects(async()=>f.run({...f.opts,model:'other'}),/bot_model_not_allowed/);
 f.setActive({cancelled:true});await assert.rejects(async()=>f.run({...f.opts,purpose:undefined}),/bridge_request_required/);
 f.setActive({cancelled:false});await assert.rejects(async()=>f.run({...f.opts,sessionId:'unrelated'}),/bridge_request_required/);
});
test('foreground and tagged native requests retain their existing admission',async()=>{
 const f=fixture();f.setActive({cancelled:false});await f.run({...f.opts,purpose:undefined});
 f.setActive(undefined);await f.run({...f.opts,purpose:undefined,messages:f.tagged});
 assert.equal(f.records.length,0);
});
test('maintenance cancellation and native error finish are recorded without raw diagnostics',async()=>{
 const f=fixture(),c=new AbortController();c.abort();
 await assert.rejects(async()=>f.run({...f.opts,signal:c.signal}),/abort/i);
 await f.run(f.opts,async function*(){yield {type:'finish',reason:{kind:'error',failure:{code:'api_error',status:429,message:'private-token'}}};});
 assert.equal(f.records.at(-1).status,'failed');assert.equal(f.records.at(-1).diagnostic.status,429);
 assert.ok(!JSON.stringify(f.records).includes('private-token'));
});
