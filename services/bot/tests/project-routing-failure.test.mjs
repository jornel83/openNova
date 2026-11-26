import test from 'node:test';
import assert from 'node:assert/strict';
import {projectRoutingFailure} from '../projects/routing-failure.mjs';

const base={focus:'clarify',projectId:null,reason:'route_unavailable'};
const diagnostic={type:'error',code:'network_error',stage:'conversation',status:503,requestId:'req_route_legacy'};
const terminal=(reason=base.reason)=>({attempts:2,recovered:false,failures:[
  {attempt:1,reason,diagnostic:{...diagnostic,code:'connection_error'}},
  {attempt:2,reason,diagnostic},
]});

test('new failure metadata is sanitized while explicit successful clarification is authoritative',()=>{
  assert.deepEqual(projectRoutingFailure({...base,failure:{...diagnostic,message:'private-token',cause:{message:'private-proxy'}}}),{...diagnostic,stage:'routing'});
  assert.equal(projectRoutingFailure({...base,failure:null,diagnostics:terminal()}),undefined);
  for(const route of [null,{}, {...base,focus:'work'}, {...base,projectId:'project-a'},base])assert.equal(projectRoutingFailure(route),undefined);
});

test('legacy diagnostics require a terminal failed attempt and preserve the final safe provider error',()=>{
  assert.deepEqual(projectRoutingFailure({...base,diagnostics:terminal()}),{...diagnostic,stage:'routing'});
  for(const diagnostics of [
    {...terminal(),recovered:true},
    {...terminal(),failures:terminal().failures.slice(0,1)},
    {...terminal(),failures:[{attempt:2,reason:'route_incomplete',diagnostic}]},
  ])assert.equal(projectRoutingFailure({...base,question:'你希望继续哪一个项目？',diagnostics}),undefined);
  assert.equal(projectRoutingFailure({...base,reason:'ambiguous_project',diagnostics:terminal()}),undefined);
});

test('old fixed host notices are recognized without rewriting records or interpreting arbitrary model reasons',()=>{
  const record={...base,question:'话题识别服务暂时不可用，当前项目保持不变，请稍后重试。'},before=structuredClone(record);
  assert.deepEqual(projectRoutingFailure(record),{type:'error',code:'agent_runtime_failed',stage:'routing'});
  assert.deepEqual(record,before);
  assert.equal(projectRoutingFailure({...record,diagnostics:{...terminal(),recovered:true}}),undefined);
  assert.equal(projectRoutingFailure({...base,question:'网络并非本次问题，你指哪个项目？'}),undefined);
  for(const [reason,question,code] of [
    ['route_timeout','话题识别暂时超时，当前项目保持不变，请稍后重试。','routing_timeout'],
    ['route_incomplete','话题识别回复未完整完成，当前项目保持不变，请稍后重试。','incomplete_model_response'],
    ['invalid_route_json','你希望继续哪个项目，还是先聊聊日常？','invalid_route_response'],
  ])assert.deepEqual(projectRoutingFailure({...base,reason,question,diagnostics:terminal()}),{type:'error',code,stage:'routing'});
});
