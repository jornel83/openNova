import test from 'node:test';
import assert from 'node:assert/strict';
import {errorEvent} from '../errors.mjs';

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
