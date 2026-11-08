import test from 'node:test';
import assert from 'node:assert/strict';
import {taskClosureTools,TASK_CLOSURE_TOOLS} from '../tasks/closure-tools.mjs';
import {ALLOWED_TOOLS} from '../policy.mjs';

test('closure tools bind actions to a live user request and are exposed to the foreground bot',()=>{
  let request={id:'request-one',actor:{kind:'user'}},called=[];
  const tasks={closeTask:a=>{called.push(a);return a;},reopenTask:a=>a};
  const tools=Object.fromEntries(taskClosureTools(tasks,()=>request).map(row=>[row[0],row[3]]));
  const args={id:'task',runId:'run',assignmentVersion:1};
  for(const name of TASK_CLOSURE_TOOLS)assert.ok(ALLOWED_TOOLS.includes(name));
  const first=tools.background_task_close(args);assert.deepEqual(tools.background_task_close(args),first);
  assert.notEqual(tools.background_task_reopen(args).actionId,first.actionId);
  request={id:'request-two',actor:{kind:'user'}};assert.notEqual(tools.background_task_close(args).actionId,first.actionId);
  for(const invalid of [null,{id:'cancelled',cancelled:true},{id:'employee',actor:{kind:'employee'}},{id:'supervisor',actor:{kind:'supervisor'}}]){
    request=invalid;assert.throws(()=>tools.background_task_close(args),/bridge_request_required|actor_denied/);
    assert.throws(()=>tools.background_task_reopen(args),/bridge_request_required|actor_denied/);
  }
  assert.equal(called.length,3);
});
