import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {existsSync,readFileSync} from 'node:fs';
const manifest=new URL('../../../output/deps/siwc/current.json',import.meta.url);
const root=process.env.OPENNOVA_TEST_SIWC || (existsSync(manifest) ? JSON.parse(readFileSync(manifest)).path : join(homedir(),'.local/share/opennova/siwc-devkit'));
let items;
try {items=await import(pathToFileURL(join(root,'packages/local/dist/items.js')));} catch(e) {if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const call=(options={})=>items.streamItems('synthetic-token',{model:'gpt-6.1-sol',input:[{role:'user',content:'hello'}],...options},new AbortController().signal);
const frame=x=>`data: ${JSON.stringify(x)}\n\n`;
const output=[{type:'function_call',id:'fc_1',call_id:'call_1',name:'web_search',namespace:'opennova',arguments:'{"queries":["hello"]}',status:'completed'}];
const done={type:'response.completed',response:{status:'completed',output}};
const response=events=>new Response(events.map(frame).join(''),{headers:{'Content-Type':'text/event-stream'}});
test('installed extension exposes item streaming',()=>assert.equal(typeof items?.streamItems,'function'));
test('sends namespaced tools and preserves function events and completed items',async t=>{
 const tools=[{type:'namespace',name:'opennova',tools:[{type:'function',name:'web_search',parameters:{type:'object',properties:{}},strict:false}]}];
 let body;
 t.mock.method(globalThis,'fetch',async(url,init)=>{assert.equal(String(url),'https://api.openai.com/v1/responses');body=JSON.parse(init.body);assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-token');return response([{type:'response.function_call_arguments.delta',delta:'{"queries":'},done]);});
 const events=[];assert.deepEqual(await call({tools,onEvent:e=>events.push(e)}),{output});
 assert.deepEqual(body.tools,tools);assert.equal(body.store,false);assert.equal(body.stream,true);assert.deepEqual(body.include,['reasoning.encrypted_content']);
 assert.equal(body.previous_response_id,undefined);assert.equal(events[0].type,'response.function_call_arguments.delta');
});
for(const [name,events,code] of [
 ['EOF',[{type:'response.output_text.delta',delta:'partial'}],'stream_interrupted'],
 ['incomplete',[{type:'response.incomplete'}],'response_incomplete'],
 ['failed',[{type:'response.failed',response:{error:{code:'model_not_found',message:'private detail'}}}],'model_not_found']]){
 test(`${name} cannot commit output`,async t=>{t.mock.method(globalThis,'fetch',async()=>response(events));await assert.rejects(call(),e=>e.code===code&&!e.message.includes('private detail'));});
}
test('caller abort after event does not report completion',async t=>{
 const c=new AbortController();t.mock.method(globalThis,'fetch',async()=>response([{type:'response.output_text.delta',delta:'hello'},done]));
 await assert.rejects(call({signal:c.signal,onEvent:()=>c.abort()}),e=>e.code==='cancelled');
});
test('subscription sparse completion uses ordered done items, never partial added items',async t=>{
 const empty={type:'response.completed',response:{status:'completed',output:[]}};
 const added={type:'response.output_item.added',output_index:0,item:{...output[0],arguments:'',status:'in_progress'}};
 t.mock.method(globalThis,'fetch',async()=>response([added,{type:'response.function_call_arguments.delta',output_index:0,delta:'{'},{type:'response.output_item.done',output_index:0,item:output[0]},empty]));
 assert.deepEqual(await call(),{output});
 globalThis.fetch=async()=>response([added,empty]);
 await assert.rejects(call(),e=>e.code==='invalid_stream');
});
test('callback failure closes the body and yields a sanitized failure',async t=>{
 let cancelled=false;t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(frame({type:'response.output_text.delta',delta:'hello'})));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}}));
 await assert.rejects(call({onEvent(){throw Error('private callback');}}),e=>!e.message.includes('private callback'));assert.equal(cancelled,true);
});
