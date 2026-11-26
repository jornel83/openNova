import test from 'node:test';
import assert from 'node:assert/strict';
import {errorEvent,diagnosticHint,diagnosticText,requiresChatGPTAuthorization} from '../errors.mjs';

test('routing gives an actionable cause; diagnostic details are kept out of the spoken hint',()=>{
  const cases=[
    [{code:'network_error'},/网络或 OpenNova 的代理设置/],
    [{code:'stream_interrupted'},/连接在回复完成前中断/],
    [{code:'invalid_grant',status:400},/重新完成 OpenNova 的 ChatGPT 授权/],
    [{code:'api_error',status:403},/访问权限/],
    [{code:'api_error',status:429},/请求受限/],
    [{code:'model_service_unavailable',status:503},/服务暂时不可用/],
    [{code:'routing_timeout'},/超时/],
    [{code:'invalid_route_response'},/话题识别结果无法使用/],
  ];
  for(const [facts,expected] of cases){
    const d={...facts,stage:'routing',requestId:'req_test',message:'private'};
    const hint=diagnosticHint(d);
    assert.match(hint,/话题识别失败/);assert.match(hint,expected);assert.match(hint,/当前项目保持不变/);
    assert.doesNotMatch(hint,/req_test|HTTP|private/);
    assert.match(diagnosticText(d),/req_test/);
    assert.doesNotMatch(diagnosticHint({...d,stage:'conversation'}),/当前项目保持不变/);
  }
});

test('preserves model API status and stage without exposing SDK response text', () => {
  const error=Object.assign(new Error('private-token and private-prompt'), {code:'api_error',status:403});
  assert.deepEqual(errorEvent(error,'model_catalog'),
    {type:'error',code:'api_error',stage:'model_catalog',status:403});
  assert.ok(!JSON.stringify(errorEvent(error,'model_catalog')).includes('private'));
});

test('distinguishes network failure and Harness early exit', () => {
  assert.equal(errorEvent({code:'network_error',message:'private'},'model_catalog').code,'network_error');
  assert.equal(errorEvent({name:'TransportClosedError',message:'private stderr'},'harness_start').code,'harness_connection_closed');
});

test('unrecognized diagnostics cannot echo credentials or user text', () => {
  assert.deepEqual(errorEvent({code:'private_secret',message:'private_secret',status:'private'},'private'),
    {type:'error',code:'agent_runtime_failed',stage:'agent'});
  assert.equal(errorEvent(new Error('chatgpt_authorization_required'),'authorization').code,'chatgpt_authorization_required');
});

test('refresh rejection and later local sign-in failures retain an actionable safe diagnosis',()=>{
  for(const code of ['invalid_grant','invalid_refresh_token','token_expired','refresh_token_expired','refresh_token_invalidated','refresh_token_reused','sign_in_required','chatgpt_authorization_required']){
    const error={code,message:'private-token',...(code==='invalid_grant'?{status:400}:{})};
    assert.equal(errorEvent(error,'conversation').code,code);
    assert.equal(requiresChatGPTAuthorization(error),true);
    const text=diagnosticText(error);
    assert.match(text,/重新完成 OpenNova 的 ChatGPT 授权/);
    assert.ok(!text.includes('请求格式'));assert.ok(!text.includes('private-token'));
  }
  for(const error of [{code:'api_error',status:401},{code:'api_error',status:403},{code:'invalid_token'},new Error('private-token')]){
    assert.equal(requiresChatGPTAuthorization(error),false);
    assert.ok(!diagnosticText(error).includes('private-token'));
  }
});
