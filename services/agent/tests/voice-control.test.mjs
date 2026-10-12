import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceControl} from '../voice-control.mjs';

function setup() {
  const events = [];
  const control = new VoiceControl(value => events.push(value));
  const agent = {session:{id:'session-one'}, cancels:0, status:'running',
    cancel() { this.cancels++; }, async whenIdle() { this.status='idle'; }};
  return {control, events, agent};
}
test('only current session text deltas are forwarded, with attempt identity', () => {
  const {control,events,agent} = setup();
  control.arm(1,'session-one');
  control.frame(agent,{type:'start',attemptId:'a',revision:1});
  control.frame(agent,{type:'chunk',attemptId:'a',index:0,chunk:{type:'text-delta',text:'你好。'}});
  control.frame(agent,{type:'chunk',attemptId:'a',index:1,chunk:{type:'thinking-delta',text:'private'}});
  control.frame({session:{id:'other'}},{type:'chunk',attemptId:'a',chunk:{type:'text-delta',text:'wrong'}});
  assert.deepEqual(events,[{type:'delta',id:1,attemptId:'a',text:'你好。'}]);
});
test('cancel before agent creation cancels when activity begins and suppresses late text', async () => {
  const {control,events,agent} = setup();
  control.arm(1,'session-one');
  await control.cancel(1);
  control.running(agent);
  control.frame(agent,{type:'start',attemptId:'a'});
  control.frame(agent,{type:'chunk',attemptId:'a',chunk:{type:'text-delta',text:'old'}});
  assert.ok(agent.cancels >= 1); assert.deepEqual(events,[]);
});
test('cancel settles active agent and subsequent arm can stream in same session', async () => {
  const {control,events,agent} = setup();
  control.arm(1,'session-one'); control.running(agent);
  await control.cancel(1); assert.equal(agent.status,'idle');
  control.arm(2,'session-one');
  control.frame(agent,{type:'start',attemptId:'b'});
  control.frame(agent,{type:'chunk',attemptId:'b',chunk:{type:'text-delta',text:'继续'}});
  assert.equal(events.at(-1).id,2); assert.equal(events.at(-1).text,'继续');
  await control.cancel(1); assert.equal(agent.cancels,1);
});
