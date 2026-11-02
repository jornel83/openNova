import test from 'node:test';
import assert from 'node:assert/strict';
import {responseToolChunks} from '../responses-protocol.mjs';
import {createResponsePreview} from '../response-preview.mjs';

const opts={model:'gpt-6.1-sol',sessionId:'owned',messages:[{role:'user',content:[{type:'text',text:'解释'}]}],tools:[]};
const message=(text,phase='final_answer')=>({type:'message',id:'m',role:'assistant',phase,status:'completed',content:[{type:'output_text',text,annotations:[]}]});
const added=(onEvent,phase='final_answer')=>onEvent({type:'response.output_item.added',output_index:0,item:{...message('',phase),status:'in_progress'}});
const delta=(onEvent,text)=>onEvent({type:'response.output_text.delta',output_index:0,content_index:0,item_id:'m',delta:text});

test('final-answer preview arrives before provider completion, executable output waits for validated completion',async()=>{
  let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),previews=[],chunks=[];
  const client={async streamItems({onEvent}){added(onEvent);delta(onEvent,'第一句。');entered();await gate;delta(onEvent,'第二句。');return {output:[message('第一句。第二句。')]};}};
  const work=(async()=>{for await(const chunk of responseToolChunks(client,opts,[],e=>previews.push(e)))chunks.push(chunk);})();
  await ready;
  assert.equal(previews.find(e=>e.type==='text').text,'第一句。');assert.deepEqual(chunks,[]);
  release();await work;
  assert.equal(previews.at(-1).type,'settled');assert.equal(chunks.at(-1).reason.kind,'stop');
  assert.equal(chunks.find(c=>c.type==='text-delta').text,'第一句。第二句。');
});

for(const phase of ['commentary',undefined,null])test(`phase ${phase} is not presented as a speakable answer`,async()=>{
  const seen=[];await Array.fromAsync(responseToolChunks({async streamItems({onEvent}){
    added(onEvent,phase===undefined?'':phase);delta(onEvent,'准备调用工具。');return {output:[message('准备调用工具。',phase)]};
  }},opts,[],e=>seen.push(e)));
  assert.equal(seen.some(e=>e.type==='text'||e.type==='answer-start'),false);
  assert.ok(seen.some(e=>e.type==='model-text'));
});

test('a function after an announced final answer abandons preview and emits no executable tool',async()=>{
  const seen=[],chunks=[];
  await assert.rejects(async()=>{for await(const c of responseToolChunks({async streamItems({onEvent}){
    added(onEvent);delta(onEvent,'完成。');onEvent({type:'response.output_item.added',output_index:1,item:{type:'function_call',name:'bash'}});
    assert.fail('must stop malformed final answer');
  }},opts,[],e=>seen.push(e)))chunks.push(c);});
  assert.equal(seen.at(-1).type,'abandoned');assert.deepEqual(chunks,[]);
});

test('mixed responses with a preceding tool or commentary retain settled-only behavior',()=>{
  for(const item of [{type:'function_call',id:'f'},message('准备检查。','commentary')]){
    const seen=[],p=createResponsePreview(e=>seen.push(e));
    p.event({type:'response.output_item.added',output_index:1,item});
    added(p.event);delta(p.event,'答案。');p.settle([item,message('答案。')]);
    assert.equal(seen.some(e=>e.type==='answer-start'||e.type==='text'),false);
  }
});

test('truncated, revised and cancelled streams abandon drafts without committing history',async()=>{
  for(const mode of ['failed','mismatch','cancelled']){
    const seen=[],chunks=[],controller=new AbortController();
    await assert.rejects(async()=>{for await(const c of responseToolChunks({async streamItems({onEvent}){
      added(onEvent);delta(onEvent,'部分回答。');
      if(mode==='failed')throw Object.assign(Error('private'),{code:'stream_interrupted'});
      if(mode==='cancelled')controller.abort();
      return {output:[message('不同回答。')]};
    }},{...opts,signal:controller.signal},[],e=>seen.push(e)))chunks.push(c);});
    assert.deepEqual(chunks,[]);assert.equal(seen.at(-1).type,'abandoned');
  }
});

test('viewer exceptions cannot interrupt the provider and compaction has no preview',async()=>{
  const p=createResponsePreview(()=>{throw Error('broken viewer');});
  added(p.event);delta(p.event,'回答。');p.settle([message('回答。')]);
  let watched=false;
  await Array.fromAsync(responseToolChunks({async streamItems({onEvent}){assert.equal(onEvent,undefined);return {output:[message('summary')]};}},
    {...opts,purpose:'compaction'},[],()=>{watched=true;}));
  assert.equal(watched,false);
});
test('settled fallback still measures model latency without releasing previews or imposing phase rules',async()=>{
  const seen=[],text=message('answer');
  await Array.fromAsync(responseToolChunks({async streamItems({onEvent}){
    added(onEvent);delta(onEvent,'answer');return {output:[{...text,phase:null}]};
  }},opts,[],e=>seen.push(e),{enabled:false}));
  assert.deepEqual(seen.map(e=>e.type),['start','model-text','model-completed']);
});
