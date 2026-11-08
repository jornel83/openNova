import test from 'node:test';
import assert from 'node:assert/strict';
import {skillTools,SKILL_TOOLS} from '../skills/tools.mjs';

test('voice and text skill extraction bind exact evidence and stable request replay without accepting caller operation IDs',()=>{
  let request={id:'voice-request'},received=[];
  const handlers=Object.fromEntries(skillTools({candidate:body=>{received.push(body);return body;},mutate:body=>body},()=>request).map(([name,,,fn])=>[name,fn]));
  const source={taskId:'task-1',runId:'run-1',reportId:'report-1',reviewId:'review-1'};
  assert.ok(SKILL_TOOLS.includes('skill_extract'));
  const first=handlers.skill_extract(source),replay=handlers.skill_extract(source);
  assert.equal(first.actionId,replay.actionId);assert.deepEqual(Object.fromEntries(Object.entries(first).filter(([key])=>key!=='actionId')),source);
  assert.notEqual(handlers.skill_extract({...source,reviewId:'review-2'}).actionId,first.actionId);
  request={id:'text-request'};assert.notEqual(handlers.skill_extract(source).actionId,first.actionId);
  assert.notEqual(handlers.skill_extract({...source,actionId:'caller-chosen'}).actionId,'caller-chosen');
  for(const current of [null,{id:'stopped',cancelled:true},{id:'aborted',signal:AbortSignal.abort()}]){
    request=current;assert.throws(()=>handlers.skill_extract(source),/bridge_request_required/);assert.throws(()=>handlers.skill_manage({action:'promote',candidateId:'candidate-1'}),/bridge_request_required/);
  }
  assert.equal(received.length,5);
});
