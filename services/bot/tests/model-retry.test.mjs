import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Operations} from '../operations.mjs';
import {installModelRetryObserver} from '../model-retry.mjs';
import {modelRetryLabel} from '../../agent/model-retry.mjs';
import {voicePresentation} from '../web/voice-state.mjs';
const scheduled={type:'llm/retry',data:{retryId:'retry-one',turn:3,step:2,provider:'opennova-chatgpt',mode:'normal',policyKey:'test',retry:1,maxRetries:2,delayMs:1000,failure:{code:'model_service_unavailable',status:503,requestId:'req_retry_test',message:'private'}}};
function setup(t){
 const home=mkdtempSync(join(tmpdir(),'nova-retry-')),ops=new Operations({home,workspace:home});t.after(()=>{ops.close();rmSync(home,{recursive:true,force:true});});
 ops.submit('r','查询');ops.finish('r',{status:'running'});
 const requests={active:{id:'r',sessionId:'s',started:true,cancelled:false}},logs=[];let hook;
 installModelRetryObserver({on:(name,fn)=>{assert.equal(name,'session/event');hook=fn;}},{ops,requests,onRetry:r=>logs.push(r)});
 return {ops,requests,logs,emit:(event,session='s')=>hook({id:session},event)};
}
test('native retry events persist sanitized progress and disappear after model recovery',t=>{
 const h=setup(t);h.emit(scheduled);
 let r=h.ops.request('r');assert.equal(r.modelRetry.status,'waiting');assert.equal(r.modelRetry.retry,1);assert.match(modelRetryLabel(r),/1\/2/);
 assert.ok(!JSON.stringify(h.logs).includes('private'));assert.equal(h.logs[0].bridgeRequestId,'r');
 const v=voicePresentation({busy:true,activeId:'r',messages:[r]},true);assert.match(v.label,/自动重试/);
 h.emit({type:'llm/retry-started',data:{retryId:'retry-one',turn:3,step:2,retry:1}});assert.equal(h.ops.request('r').modelRetry.status,'requesting');
 h.emit({type:'assistant/message',data:{turn:3,step:2,message:{content:[{type:'text',text:'done'}]}}});
 r=h.ops.request('r');assert.equal(r.modelRetry.status,'recovered');assert.equal(modelRetryLabel(r),'');
});
test('retry observation does not update unrelated or cancelled foreground work',t=>{
 const h=setup(t);h.emit(scheduled,'other');assert.equal(h.ops.request('r').modelRetry,undefined);
 h.requests.active.cancelled=true;h.emit(scheduled);assert.equal(h.ops.request('r').modelRetry,undefined);
});
test('retry exhaustion and cancellation close the progress without inventing a successful answer',t=>{
 const h=setup(t);h.emit(scheduled);h.emit({type:'turn/end',data:{turn:3,reason:{kind:'error'}}});
 assert.equal(h.ops.request('r').modelRetry.status,'failed');assert.equal(modelRetryLabel(h.ops.request('r')),'');
 h.emit(scheduled);h.requests.active.cancelled=true;h.emit({type:'turn/end',data:{turn:3,reason:{kind:'cancelled'}}});
 assert.equal(h.ops.request('r').modelRetry.status,'cancelled');assert.equal(h.ops.request('r').text,undefined);
});
