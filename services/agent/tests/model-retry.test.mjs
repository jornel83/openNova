import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {loadSettings} from '../settings.mjs';
import {createSubscriptionAdapter} from '../provider.mjs';
import {completedReply} from '../result.mjs';
import {errorEvent} from '../errors.mjs';
const require=createRequire(join(loadSettings().harnessRoot,'packages/bundle/base/package.json'));
const {Context}=require('@deepseek-ai/cordis'),llm=require('@deepseek-ai/dsh-llm');
const text=value=>({output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:value}]}]});
const failure=(status=503)=>Object.assign(Error('private provider body'),{code:'api_error',status,requestId:'req_retry_last'});
async function harness(t,entries){
 const ctx=new Context(),calls=[];
 t.after(()=>ctx.fiber.dispose());
 for(const pkg of ['llm','session','session-projection','system-prompt','tools','agent'])await ctx.plugin(require('@deepseek-ai/dsh-'+pkg).default);
 await ctx.plugin(require('@deepseek-ai/dsh-llm-retry'));
 await ctx.plugin(require('@deepseek-ai/dsh-agent-loop').default,{agents:[]});
 const client={async streamItems(request){calls.push(request);const entry=entries.shift();if(entry instanceof Error)throw entry;if(!entry)throw Error('fixture exhausted');return entry;}};
 ctx.llm.registerAdapter(['opennova-chatgpt'],createSubscriptionAdapter(llm,client,{enableTools:true,allowedTools:['lookup']}));
 const agent=await ctx.agentLoop.create('retry-'+crypto.randomUUID(),{provider:'opennova-chatgpt',model:'gpt-6.1-sol'});
 const run=async()=>{agent.followup(llm.createUserMessage({content:[{type:'text',text:'查天气'}],source:{kind:'user'}}));await agent.whenIdle();return agent.session.snapshotEvents();};
 return {ctx,agent,calls,run};
}
test('503 after a successful tool retries only the failed model step and keeps its evidence',async t=>{
 const tool={output:[{type:'function_call',call_id:'lookup-once',name:'lookup',namespace:'opennova',arguments:'{}'}]};
 const h=await harness(t,[tool,failure(),text('资料已核对')]);let executions=0;
 h.ctx.tools.register(require('@deepseek-ai/dsh-tools').defineContentToolFixture({name:'lookup',description:'天气查询',parameters:{},async execute(){executions++;return [{type:'text',text:'verified weather evidence'}];}}));
 const events=await h.run();
 assert.equal(completedReply({events,finalResponse:'资料已核对'}),'资料已核对');assert.equal(executions,1);assert.equal(h.calls.length,3);
 assert.deepEqual(h.calls[1].input,h.calls[2].input);assert.ok(h.calls[2].input.some(x=>x.type==='function_call_output'&&x.output==='verified weather evidence'));
 assert.deepEqual(events.filter(e=>e.type==='llm/retry').map(e=>e.data.delayMs),[1000]);
 assert.equal(events.filter(e=>e.type==='user/message').length,1);assert.equal(events.filter(e=>e.type==='tool/call').length,1);
});
test('persistent 503 stops after two retries and retains the final HTTP diagnostic',async t=>{
 const h=await harness(t,[failure(),failure(),failure(),text('must not run')]);const events=await h.run();
 assert.equal(h.calls.length,3);assert.deepEqual(events.filter(e=>e.type==='llm/retry').map(e=>e.data.delayMs),[1000,2000]);
 assert.throws(()=>completedReply({events}),e=>e.status===503&&e.requestId==='req_retry_last');
 const end=events.findLast(e=>e.type==='turn/end');assert.equal(errorEvent(end.data.reason.error,'conversation').code,'model_service_unavailable');
 assert.equal(events.filter(e=>e.type==='assistant/message').length,0);
});
test('cancellation during native backoff prevents another model request',async t=>{
 const h=await harness(t,[failure(),text('must not run')]);
 h.ctx.on('session/event',(s,e)=>{if(s===h.agent.session&&e.type==='llm/retry')h.agent.cancel({kind:'user'});});
 const start=Date.now(),events=await h.run();
 assert.equal(events.filter(e=>e.type==='llm/retry').length,1);assert.equal(h.calls.length,1);assert.ok(Date.now()-start<900);
 assert.throws(()=>completedReply({events}),/incomplete_agent_turn/);
});
for(const status of [401,403,429,500,502,504])test(`HTTP ${status} does not expand the retry scope`,async t=>{
 const h=await harness(t,[failure(status),text('must not run')]);const events=await h.run();
 assert.equal(h.calls.length,1);assert.equal(events.filter(e=>e.type==='llm/retry').length,0);
 assert.throws(()=>completedReply({events}),e=>e.status===status);
});
for(const code of ['network_error','stream_interrupted'])test(`${code} is not retried`,async t=>{
 const h=await harness(t,[Object.assign(Error(code),{code}),text('must not run')]);const events=await h.run();
 assert.equal(h.calls.length,1);assert.equal(events.filter(e=>e.type==='llm/retry').length,0);
 assert.throws(()=>completedReply({events}),e=>e.code===code);
});
