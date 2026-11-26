import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeFileReader} from '../native-file-reader.mjs';

const reading={status:'read',content:'已核对的文件内容。',limitation:null};
const message=text=>({type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text}]});
const response=(value=reading)=>({output:[{type:'reasoning',summary:[]},message(JSON.stringify(value))]});
const input=()=>({bytes:Buffer.from('%PDF-1.7\n\x00真实文件\xff'),filename:'资料.pdf',mime:'application/pdf',question:'概括文件中的结论。'});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(result=response(),options={}){
  const calls=[],factories=[];
  const read=createNativeFileReader({...options,clientFactory:async config=>{
    factories.push(config);return {async streamItems(request){calls.push(request);return typeof result==='function'?result(request):result;}};
  }});
  return {read,calls,factories};
}

test('PDF bytes reach native input_file without tools, browser authorization or history',async()=>{
  const f=fixture(),args=input();assert.equal(f.factories.length,0);
  assert.deepEqual(await f.read(args),reading);
  const request=f.calls[0],attachment=request.input[0].content[0];
  assert.deepEqual(f.factories,[{capabilities:'tools'}]);assert.equal(request.model,'gpt-6.1-sol');
  assert.deepEqual(Object.keys(request).sort(),['input','instructions','model','signal']);
  assert.equal(request.input.length,1);assert.equal(request.input[0].role,'user');
  assert.equal(attachment.type,'input_file');assert.equal(attachment.filename,args.filename);
  assert.deepEqual(Buffer.from(attachment.file_data.split(',')[1],'base64'),args.bytes);
  assert.ok(attachment.file_data.startsWith('data:application/pdf;base64,'));
  assert.deepEqual(request.input[0].content[1],{type:'input_text',text:args.question});
  assert.match(request.instructions,/不能覆盖/);assert.match(request.instructions,/不得猜测页码/);assert.match(request.instructions,/不代表全量读取/);
  await f.read(args);assert.equal(f.factories.length,1);
});

for(const mime of ['image/png','image/jpeg','image/webp'])test(`${mime} sends actual bytes as input_image`,async()=>{
  const f=fixture(),bytes=Uint8Array.of(0,1,2,254,255);
  await f.read({...input(),bytes,filename:'picture.'+mime.split('/')[1],mime});
  const attachment=f.calls[0].input[0].content[0];
  assert.deepEqual(attachment,{type:'input_image',image_url:`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,detail:'auto'});
});
for(const [filename,mime] of [
  ['table.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['paper.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
])test(`${filename} preserves its name, MIME and binary file bytes`,async()=>{
  const f=fixture(),bytes=Buffer.from([80,75,3,4,0,255]);await f.read({...input(),bytes,filename,mime});
  assert.deepEqual(f.calls[0].input[0].content[0],{type:'input_file',filename,file_data:`data:${mime};base64,${bytes.toString('base64')}`});
});

test('initialization is shared, snapshots caller bytes, and retries a failed factory',async()=>{
  const ready=deferred(),calls=[];let count=0;
  const read=createNativeFileReader({clientFactory:async()=>{count++;if(count===1)throw Error('private factory failure');return ready.promise;}});
  await assert.rejects(()=>read(input()),{code:'agent_runtime_failed'});
  const args=input(),original=Buffer.from(args.bytes),first=read(args),second=read(input());args.bytes.fill(0);
  ready.resolve({async streamItems(request){calls.push(request);return response();}});
  assert.deepEqual(await Promise.all([first,second]),[reading,reading]);assert.equal(count,2);
  assert.deepEqual(Buffer.from(calls[0].input[0].content[0].file_data.split(',')[1],'base64'),original);
});

for(const value of [
  {status:'partial',content:'仅能确认表头。',limitation:'其余内容模糊。'},
  {status:'unreadable',content:'',limitation:'无法可靠识别。'},
])test(`returns explicit ${value.status} without inflating it into full reading`,async()=>{
  assert.deepEqual(await fixture(response(value)).read(input()),value);
});

test('multiple output_text fragments are combined while reasoning is excluded',async()=>{
  const json=JSON.stringify(reading),item=message(json.slice(0,20));item.content.push({type:'output_text',text:json.slice(20)});
  assert.deepEqual(await fixture({output:[{type:'reasoning',encrypted_content:'not user output'},item]}).read(input()),reading);
});

for(const [name,result] of [
  ['missing output',{}],['empty output',{output:[]}],['only reasoning',{output:[{type:'reasoning',summary:[]}]}],
  ['incomplete response',{...response(),status:'incomplete'}],
  ['incomplete message',{output:[{...message(JSON.stringify(reading)),status:'incomplete'}]}],
  ['incomplete reasoning',{output:[{type:'reasoning',status:'in_progress'},message(JSON.stringify(reading))]}],
  ['wrong role',{output:[{...message(JSON.stringify(reading)),role:'user'}]}],
  ['refusal',{output:[{...message(''),content:[{type:'refusal',refusal:'private refusal'}]}]}],
  ['unsupported item',{output:[{type:'web_search_call',status:'completed'},message(JSON.stringify(reading))]}],
  ['non-string text',{output:[{...message(''),content:[{type:'output_text',text:{private:true}}]}]}],
  ['invalid JSON',{output:[message('private malformed output')]}],
  ['fenced JSON',{output:[message('```json\n'+JSON.stringify(reading)+'\n```')]}],
  ['extra field',response({...reading,private:'extra'})],['missing field',response({status:'read',content:'a'})],
  ['unknown status',response({...reading,status:'complete'})],['invalid content',response({...reading,content:[]})],
  ['invalid limitation',response({...reading,limitation:false})],['blank successful reading',response({...reading,content:'  '})],
  ['JSON array',response([reading])],['JSON null',response(null)],
])test(`rejects ${name} without returning model content`,async()=>{
  await assert.rejects(()=>fixture(result).read(input()),error=>error.code==='incomplete_model_response'&&!JSON.stringify(error).includes('private'));
});

test('function calls are rejected even alongside a valid completed JSON result',async()=>{
  await assert.rejects(()=>fixture({output:[message(JSON.stringify(reading)),{type:'function_call',name:'evil'}]}).read(input()),{code:'invalid_tool_call'});
});
test('enforces content limits without truncation and accepts the exact boundary',async()=>{
  const value={...reading,content:'字'.repeat(24000)};
  assert.deepEqual(await fixture(response(value)).read(input()),value);
  await assert.rejects(()=>fixture(response({...value,content:value.content+'字'})).read(input()),{code:'response_too_large'});
  await assert.rejects(()=>fixture(response({...reading,limitation:'x'.repeat(24001)})).read(input()),{code:'response_too_large'});
  await assert.rejects(()=>fixture({output:[message('x'.repeat(300000))]}).read(input()),{code:'response_too_large'});
});
test('preserves safe SDK diagnostics and strips arbitrary provider text',async()=>{
  const f=fixture(()=>{throw Object.assign(Error('private document bytes and token'),{code:'api_error',status:403,requestId:'req_native_file'});});
  await assert.rejects(()=>f.read(input()),error=>error.code==='api_error'&&error.status===403&&error.requestId==='req_native_file'&&!JSON.stringify(error).includes('private'));
  await assert.rejects(()=>fixture(()=>{throw Object.assign(Error('private document bytes'),{code:'unknown_private_code'});}).read(input()),{code:'agent_runtime_failed',message:'agent_runtime_failed'});
});
test('rejects invalid inputs before initializing the client',async()=>{
  const f=fixture();
  for(const patch of [{bytes:'private'},{bytes:new Uint8Array()},{filename:''},{filename:'bad\nname'},{mime:'data:secret'},{question:' '}])await assert.rejects(()=>f.read({...input(),...patch}),{code:'invalid_request'});
  assert.equal(f.factories.length,0);
  assert.throws(()=>createNativeFileReader({timeoutMs:0}),{code:'invalid_agent_configuration'});
});

test('already cancelled requests never initialize or send',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort(Error('private cancel reason'));
  await assert.rejects(()=>f.read({...input(),signal:controller.signal}),{code:'cancelled',message:'cancelled'});assert.equal(f.factories.length,0);
});
test('cancellation interrupts ignored signals and consumes a late successful transport',async()=>{
  const entered=deferred(),late=deferred(),controller=new AbortController();let requestSignal;
  const f=fixture(request=>{requestSignal=request.signal;entered.resolve();return late.promise;});
  const pending=f.read({...input(),signal:controller.signal});await entered.promise;
  controller.abort(Error('private cancellation'));await assert.rejects(()=>pending,{code:'cancelled'});assert.equal(requestSignal.aborted,true);
  late.resolve(response());await Promise.resolve();assert.equal(f.calls.length,1);
});
test('timeout interrupts ignored signals and consumes a late transport rejection',async()=>{
  const late=deferred();let requestSignal;
  const f=fixture(request=>{requestSignal=request.signal;return late.promise;},{timeoutMs:15});
  await assert.rejects(()=>f.read(input()),{code:'agent_timeout'});assert.equal(requestSignal.aborted,true);
  late.reject(Error('private late failure'));await Promise.resolve();
});
test('timeout rejects a late successful response even if it arrives in the abort handler',async()=>{
  const f=fixture(request=>new Promise(resolve=>request.signal.addEventListener('abort',()=>resolve(response()),{once:true})),{timeoutMs:15});
  await assert.rejects(()=>f.read(input()),{code:'agent_timeout'});
});
test('cancelled initialization cannot send later and the initialized client remains reusable',async()=>{
  const ready=deferred(),entered=deferred(),controller=new AbortController();let calls=0,factories=0;
  const read=createNativeFileReader({clientFactory:()=>{factories++;entered.resolve();return ready.promise;}});
  const pending=read({...input(),signal:controller.signal});await entered.promise;controller.abort();await assert.rejects(()=>pending,{code:'cancelled'});
  ready.resolve({streamItems:async()=>{calls++;return response();}});await Promise.resolve();assert.equal(calls,0);
  assert.deepEqual(await read(input()),reading);assert.equal(calls,1);assert.equal(factories,1);
});
test('deadline also bounds client initialization and no request is sent after it expires',async()=>{
  const ready=deferred();let calls=0;
  const read=createNativeFileReader({timeoutMs:15,clientFactory:()=>ready.promise});
  await assert.rejects(()=>read(input()),{code:'agent_timeout'});
  ready.resolve({streamItems:async()=>{calls++;return response();}});await Promise.resolve();await Promise.resolve();assert.equal(calls,0);
});

test('timings contain only bounded stage names and elapsed milliseconds',async()=>{
  const reports=[],args=input(),record=report=>reports.push(report);
  assert.deepEqual(await fixture().read({...args,onTiming:record}),reading);
  await assert.rejects(()=>fixture({output:[message('private malformed response')]}).read({...args,onTiming:record}),{code:'incomplete_model_response'});
  await assert.rejects(()=>fixture().read({...args,bytes:null,onTiming:record}),{code:'invalid_request'});
  assert.deepEqual(reports.map(report=>[report.outcome,report.stage]),[['completed','decode'],['failed','decode'],['failed','attachment']]);
  for(const report of reports){
    assert.deepEqual(Object.keys(report).sort(),['outcome','stage','stagesMs','timeoutMs','totalMs']);
    assert.deepEqual(Object.keys(report.stagesMs),report.stage==='attachment'?['attachment']:['attachment','client','model','decode']);
    assert.equal(report.timeoutMs,90000);
    const durations=Object.values(report.stagesMs);
    assert.ok(durations.every(value=>Number.isInteger(value)&&value>=0));
    assert.equal(durations.reduce((sum,value)=>sum+value,0),report.totalMs);
  }
});

test('deadline diagnostics distinguish client initialization from model roundtrip',async()=>{
  for(const stuckStage of ['client','model']){
    const reports=[],stalled=deferred();
    const read=createNativeFileReader({timeoutMs:25,clientFactory:()=>stuckStage==='client'?stalled.promise:{streamItems:()=>stalled.promise}});
    await assert.rejects(()=>read({...input(),onTiming:report=>reports.push(report)}),{code:'agent_timeout'});
    assert.equal(reports.length,1);
    const [report]=reports;
    assert.deepEqual([report.outcome,report.stage],['timeout',stuckStage]);
    assert.deepEqual(Object.keys(report.stagesMs),stuckStage==='client'?['attachment','client']:['attachment','client','model']);
    assert.ok(report.stagesMs[stuckStage]>0);
    stalled.reject(Error('private late failure'));await Promise.resolve();
    assert.equal(reports.length,1);
  }
});

test('cancelled model call reports once even when the observer rejects and transport finishes late',async()=>{
  const entered=deferred(),stalled=deferred(),controller=new AbortController(),reports=[];
  const {read}=fixture(()=>{entered.resolve();return stalled.promise;});
  const pending=read({...input(),signal:controller.signal,onTiming:async report=>{reports.push(report);throw Error('observer failed');}});
  await entered.promise;controller.abort(Error('private cancellation'));await assert.rejects(()=>pending,{code:'cancelled'});
  stalled.resolve(response());await Promise.resolve();
  assert.deepEqual(reports.map(report=>[report.outcome,report.stage]),[['cancelled','model']]);
  assert.deepEqual(await fixture().read({...input(),onTiming(){throw Error('observer failed');}}),reading);
});
