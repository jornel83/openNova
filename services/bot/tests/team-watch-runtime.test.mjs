import test from 'node:test';
import assert from 'node:assert/strict';
import {lifecycleHost} from './fixtures/lifecycle-host.mjs';

test('real host exposes team overview and voice tool policy/ack, survives restart and never restarts an acknowledged job',{timeout:60000},async t=>{
  const h=await lifecycleHost(t),health=await h.start();assert.equal(health.team.version,4);assert.equal(health.team.overview,true);
  const initial=await h.api('/team-overview');assert.equal(initial.counts.total,0);assert.equal(initial.watch.policy.raiseQueuedPriority,false);
  await h.foreground('watch-settings','team_watch_policy',{revision:1,dueSoonMs:0,inactiveMs:0});
  const task=await h.api('/background-task-start',{id:'long-command',title:'值守命令',command:'sleep 30',dueAt:Date.now()+1000});
  const waiting=await h.until(async()=>{const v=await h.api('/team-overview');return v.watch.unacknowledged===1&&v;},15000);
  assert.equal(waiting.counts.total,1);assert.equal(waiting.counts.active,1);assert.equal(waiting.counts.attention,1);
  assert.equal(waiting.watch.alerts[0].type,'overdue');assert.equal(waiting.watch.actions.length,0);
  await h.foreground('ask-team','team_overview',{period:'today'});
  const alert=waiting.watch.alerts[0];
  await h.foreground('ack-watch','team_watch_ack',{id:alert.id,taskId:alert.taskId,runId:alert.runId,assignmentVersion:alert.assignmentVersion});
  const acked=await h.api('/team-overview');assert.equal(acked.watch.unacknowledged,0);assert.equal(acked.counts.attention,0);assert.equal(acked.counts.active,1);
  assert.equal((await h.api('/background-task',{id:'long-command'})).runs.length,1);
  await h.api('/background-task-cancel',{id:'long-command',runId:task.task.runId});
  await h.until(async()=>{const d=await h.api('/background-task',{id:'long-command'});return d.task.status==='cancelled'&&d.task.cleanupConfirmed;});
  await h.stop();await h.start();
  const restored=await h.api('/team-overview');assert.equal(restored.watch.policy.revision,2);assert.equal(restored.watch.policy.inactiveMs,0);assert.equal(restored.watch.total,0);
  assert.equal(restored.counts.total,1);assert.equal(restored.counts.active,0);assert.equal((await h.api('/background-task',{id:'long-command'})).runs.length,1);
});
