import test from 'node:test';
import assert from 'node:assert/strict';
let protocol={};try{protocol=await import('../responses-protocol.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const tool={name:'web_search',description:'Search',parameters:{type:'object',properties:{queries:{type:'array',items:{type:'string'}}},required:['queries']}};
const opts={model:'gpt-6.1-sol',messages:[{role:'user',content:[{type:'text',text:'查一下'}]}],tools:[tool]};
const fc=(id='call_1')=>({type:'function_call',id:'fc_'+id,call_id:id,name:'web_search',namespace:'opennova',arguments:'{"queries":["测试"]}',status:'completed'});
const text={type:'message',id:'msg_1',role:'assistant',status:'completed',content:[{type:'output_text',text:'查到了。',annotations:[]}]};
test('protocol module exposes projection and stream bridge',()=>assert.equal(typeof protocol.projectToolRequest,'function'));
test('namespace and developer projection preserve input without enabling other tools',()=>{
 const r=protocol.projectToolRequest({...opts,messages:[{role:'system',content:[{type:'text',text:'voice'}]},...opts.messages]});
 assert.equal(r.tools[0].type,'namespace');assert.equal(r.tools[0].name,'opennova');assert.equal(r.tools[0].tools[0].name,'web_search');assert.equal(r.input[0].role,'developer');
 assert.throws(()=>protocol.projectToolRequest({...opts,tools:[{...tool,name:'bash'}]}),/tools/);
 assert.throws(()=>protocol.projectToolRequest({...opts,messages:[{role:'developer',content:[{type:'tool-removal',toolName:'web_search'}]}]}),/content/);
});
test('complete tool output is atomic and preserves replay plus multiple call ids',async()=>{
 const reasoning={type:'reasoning',id:'rs_1',encrypted_content:'opaque-test-only',summary:[]};
 const output=[reasoning,fc(),fc('call_2')];
 const chunks=await Array.fromAsync(protocol.responseToolChunks({async streamItems({onEvent}){onEvent?.({type:'response.function_call_arguments.delta',delta:'{'});return {output};}},opts));
 assert.equal(chunks.filter(x=>x.type==='block-end').length,2);assert.equal(chunks.at(-1).reason.kind,'tool-calls');
 const blocks=chunks.filter(x=>x.type==='block-end').map(x=>x.block);
 const r=protocol.projectToolRequest({...opts,messages:[...opts.messages,{role:'assistant',content:blocks,source:{replayState:chunks.at(-1).replayState}},...['call_1','call_2'].map(id=>({role:'tool',toolCallId:id,content:[{type:'text',text:id+' result'}]}))]});
 assert.deepEqual(r.input.slice(1,4),output);assert.equal(r.input[4].call_id,'call_1');assert.equal(r.input[5].call_id,'call_2');
});
test('text completion emits final text and keeps only provider replay data',async()=>{
 const chunks=await Array.fromAsync(protocol.responseToolChunks({streamItems:async()=>({output:[text]})},opts));
 assert.equal(chunks.find(x=>x.type==='text-delta').text,'查到了。');assert.equal(chunks.at(-1).reason.kind,'stop');
});
for(const [name,item] of [['missing id',{...fc(),call_id:''}],['bad JSON',{...fc(),arguments:'{'}],['wrong tool',{...fc(),name:'bash'}],['wrong namespace',{...fc(),namespace:'other'}]]){
 test(`rejects ${name} before emitting executable content`,async()=>{
 const seen=[];await assert.rejects(async()=>{for await(const c of protocol.responseToolChunks({streamItems:async()=>({output:[item]})},opts))seen.push(c);});assert.equal(seen.length,0);
 });
}
test('failed or cancelled response cannot commit a partial function',async()=>{
 const seen=[];await assert.rejects(async()=>{for await(const c of protocol.responseToolChunks({streamItems:async()=>{throw Error('stream_interrupted');}},opts))seen.push(c);});assert.equal(seen.length,0);
});
