import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {loadSettings} from '../settings.mjs';
import * as provider from '../provider.mjs';
import {completedReply} from '../result.mjs';
import {errorEvent} from '../errors.mjs';
import {Requests} from '../../bot/requests.mjs';
import {Operations} from '../../bot/operations.mjs';
const require=createRequire(join(loadSettings().harnessRoot,'packages/llm/llm/package.json'));
const {Context}=require('@deepseek-ai/cordis'),llm=require('@deepseek-ai/dsh-llm');

for(const facts of [{code:'api_error',status:403,requestId:'req_access_123'},{code:'api_error',status:429,requestId:'req_limit_456'},{code:'network_error'},{code:'stream_interrupted'}]){
 test(`native model failure survives settlement and durable request: ${facts.code}/${facts.status??'no HTTP'}`,async()=>{
  const ctx=new Context(),home=mkdtempSync(join(tmpdir(),'nova-diagnostic-')),ops=new Operations({home,workspace:home});
  try{
   await ctx.plugin(llm.default);
   assert.equal(typeof provider.createSubscriptionAdapter,'function');
   const fail=async()=>{throw Object.assign(Error('private-token private-prompt'),facts);};
   ctx.llm.registerAdapter(['opennova-chatgpt'],provider.createSubscriptionAdapter(llm,{streamItems:fail},{enableTools:true,allowedTools:[]}));
   const requests=new Requests(ops,async()=>{
    const chunks=await Array.fromAsync(ctx.llm.stream({provider:'opennova-chatgpt',model:'gpt-6.1-sol',messages:[{role:'user',content:[{type:'text',text:'test'}]}]}));
    const finish=chunks.at(-1).reason;
    assert.equal(finish.kind,'error');assert.equal(finish.failure.code,facts.code);assert.equal(finish.failure.status,facts.status);
    completedReply({events:[{type:'turn/end',data:{turn:1,reason:{kind:'error',error:finish.failure}}}]});
   });
   requests.submit('request-one','test');await requests.active.work;
   const result=ops.request('request-one');assert.equal(result.status,'failed');assert.equal(result.error,facts.code);
   assert.deepEqual(result.diagnostic,{type:'error',stage:'conversation',...facts});
   assert.ok(!JSON.stringify(result).includes('private'));
  }finally{ops.close();await ctx.fiber.dispose();rmSync(home,{recursive:true,force:true});}
 });
}
test('known terminal HTTP facts survive even when the error code is unknown',()=>{
 const events=[{type:'turn/end',data:{reason:{kind:'error',error:{code:'UNKNOWN',message:'private',status:502,requestId:'req_gateway_1'}}}}];
 assert.throws(()=>completedReply({events}),e=>e.status===502&&e.requestId==='req_gateway_1'&&!e.message.includes('private'));
});
test('explicit unknown model failure keeps its trace ID even without HTTP status',()=>{
 const events=[{type:'turn/end',data:{reason:{kind:'error',error:{code:'UNKNOWN',message:'private',requestId:'req_trace_123'}}}}];
 assert.throws(()=>completedReply({events}),e=>e.message==='agent_runtime_failed'&&e.requestId==='req_trace_123'&&e.stage==='conversation');
});
test('unsafe identifiers and arbitrary detail fields are excluded from diagnostics',()=>{
 for(const requestId of ['Bearer secret','sk-private-secret','req_bad\nsecret','x'.repeat(300)]){
  const d=errorEvent({code:'api_error',status:403,requestId,body:'private',cause:Error('private')},'conversation');
  assert.equal(d.requestId,undefined);assert.ok(!JSON.stringify(d).includes('private'));
 }
 assert.equal(errorEvent({code:'api_error',status:403,requestId:'req_abc123'},'conversation').requestId,'req_abc123');
});
