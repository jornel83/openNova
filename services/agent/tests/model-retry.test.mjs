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
async function harness(t,entries,{onPreview=()=>{}}={}){
 const ctx=new Context(),calls=[],previews=[];
 t.after(()=>ctx.fiber.dispose());
 for(const pkg of ['llm','session','session-projection','system-prompt','tools','agent'])await ctx.plugin(require('@deepseek-ai/dsh-'+pkg).default);
 await ctx.plugin(require('@deepseek-ai/dsh-llm-retry'));
 await ctx.plugin(require('@deepseek-ai/dsh-agent-loop').default,{agents:[]});
 const client={async streamItems(request){calls.push(request);const entry=entries.shift();if(entry instanceof Error)throw entry;if(!entry)throw Error('fixture exhausted');return typeof entry==='function'?entry(request):entry;}};
 ctx.llm.registerAdapter(['opennova-chatgpt'],createSubscriptionAdapter(llm,client,{enableTools:true,allowedTools:['lookup']},undefined,frame=>{previews.push(frame);onPreview(frame);}));
 const agent=await ctx.agentLoop.create('retry-'+crypto.randomUUID(),{provider:'opennova-chatgpt',model:'gpt-6.1-sol'});
 const run=async()=>{agent.followup(llm.createUserMessage({content:[{type:'text',text:'查天气'}],source:{kind:'user'}}));await agent.whenIdle();return agent.session.snapshotEvents();};
 return {ctx,agent,calls,previews,run};
}
const streamEntry=(value,{fail=false}={})=>({onEvent})=>{
 const message={type:'message',id:'answer-'+value,role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:value}]};
 onEvent?.({type:'response.output_item.added',output_index:0,item:{...message,status:'in_progress',content:[]}});
 onEvent?.({type:'response.output_text.delta',output_index:0,content_index:0,item_id:message.id,delta:value});
 if(fail)throw failure();
 return {output:[message]};
};
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
test('503 after provisional text abandons its attempt, retains prior tool evidence and never repeats the tool',async t=>{
 const tool={output:[{type:'function_call',call_id:'lookup-once',name:'lookup',namespace:'opennova',arguments:'{}'}]};
 const h=await harness(t,[tool,streamEntry('旧的部分回答。',{fail:true}),streamEntry('新的完整回答。')]);let executions=0;
 h.ctx.tools.register(require('@deepseek-ai/dsh-tools').defineContentToolFixture({name:'lookup',description:'查询',parameters:{},async execute(){executions++;return [{type:'text',text:'evidence retained'}];}}));
 const events=await h.run();assert.equal(executions,1);assert.equal(h.calls.length,3);
 assert.equal(completedReply({events,finalResponse:'新的完整回答。'}),'新的完整回答。');
 const textFrames=h.previews.filter(p=>p.type==='text');assert.deepEqual(textFrames.map(p=>p.text),['旧的部分回答。','新的完整回答。']);
 assert.notEqual(textFrames[0].attemptId,textFrames[1].attemptId);
 assert.ok(h.previews.some(p=>p.type==='abandoned'&&p.attemptId===textFrames[0].attemptId));
 assert.deepEqual(h.calls[1].input,h.calls[2].input);
 assert.equal(events.filter(e=>e.type==='assistant/message').some(e=>e.data.message.content.some(c=>c.text==='旧的部分回答。')),false);
});
test('client cancellation after abandoned speech prevents native retry and preserves executed tool count',async t=>{
 const tool={output:[{type:'function_call',call_id:'lookup-once',name:'lookup',namespace:'opennova',arguments:'{}'}]};
 let h,executions=0;
 h=await harness(t,[tool,streamEntry('已经播出的部分。',{fail:true}),streamEntry('must not run')],{onPreview:frame=>{
  if(frame.type==='abandoned')h.agent.cancel({kind:'user'});
 }});
 h.ctx.tools.register(require('@deepseek-ai/dsh-tools').defineContentToolFixture({name:'lookup',description:'查询',parameters:{},async execute(){executions++;return [{type:'text',text:'evidence'}];}}));
 const events=await h.run();assert.equal(executions,1);assert.equal(h.calls.length,2);
 assert.throws(()=>completedReply({events}));
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
