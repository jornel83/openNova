import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewView,inboxTasks,inboxText,reviewConflict,canEditDependencies,employeeTask,dependencyReason,artifactLabel} from '../web/team-view.mjs';

function fixture(){
  const current={id:'report-2',taskId:'task',runId:'run-2',assignmentVersion:2,status:'completed',version:2,evidence:{execution:{status:'completed',exitCode:0,cleanupConfirmed:true}},artifacts:[{id:'file',name:'report.md',status:'available',sourceStatus:'available'}]};
  const old={...current,id:'report-1',runId:'run-1',assignmentVersion:1,version:1};
  return {task:{id:'task',kind:'agent',runId:'run-2',assignmentVersion:2,status:'completed'},runs:[{id:'run-1',startedAt:1},{id:'run-2',startedAt:2}],teamReview:{current,history:[current,old],reviews:[{id:'old-review',reportId:'report-1',status:'accepted',createdAt:1},{id:'current-review',reportId:'report-2',status:'needs_user',createdAt:2}]}};
}
test('candidate card keeps resolved failures in history and disables acceptance for outstanding or stale checks',()=>{
  const d=fixture(),e=d.teamReview.current.evidence;
  e.candidateReview={status:'passed',coveredStepIds:['old']};
  e.commands=[{stepId:'old',status:'failed',exitCode:1}];
  e.steps=[{id:'old',tool:'task_command',status:'failed'}];
  assert.equal(reviewView(d).canAccept,true);assert.ok(reviewView(d).covered.has('old'));
  e.checks=[{taskId:'child',status:'failed',exitCode:1}];assert.equal(reviewView(d).canAccept,false);
  e.checks=[];e.steps.push({id:'other',tool:'read',status:'failed'});assert.equal(reviewView(d).canAccept,false);
  e.steps.pop();e.candidateReview.patchCurrent=false;assert.equal(reviewView(d).actionable,false);
  e.candidateReview={status:'incomplete',coveredStepIds:['old']};assert.equal(reviewView(d).canAccept,false);assert.equal(reviewView(d).covered.size,0);
});
test('review actions bind the exact current report and assignment while historical reports stay readable',()=>{
  const detail=fixture(),current=reviewView(detail),old=reviewView(detail,'run-1');
  assert.deepEqual(current.binding,{id:'task',runId:'run-2',reportId:'report-2',assignmentVersion:2});
  assert.equal(current.canAccept,true);assert.equal(current.review.status,'needs_user');
  assert.equal(old.report.id,'report-1');assert.equal(old.review.status,'accepted');assert.equal(old.actionable,false);
  detail.task.assignmentVersion=3;assert.equal(reviewView(detail).actionable,false);
  detail.task.runId='run-3';assert.equal(reviewView(detail).report,null);
});
test('effective stale review overrides accepted history and failed verification disables acceptance',()=>{
  const d=fixture();d.teamReview.reviews[1].status='accepted';d.teamReview.currentReview={...d.teamReview.reviews[1],status:'stale'};
  assert.equal(reviewView(d).review.status,'stale');assert.equal(reviewView(d).reviews[0].status,'accepted');
  d.teamReview.current.evidence.commands=[{status:'completed',exitCode:7}];assert.equal(reviewView(d).canAccept,false);assert.equal(reviewView(d).actionable,true);
  d.teamReview.current.evidence.commands=[];d.teamReview.current.evidence.checks=[{status:'running'}];assert.equal(reviewView(d).canAccept,false);
  assert.match(inboxText({inboxReason:'accepted_report_evidence_changed'}),/证据发生变化/);
});
test('missing cleanup or changed report files never offer acceptance; immutable historical snapshots remain openable',()=>{
  for(const patch of [{status:'running'},{status:'failed'}]){const detail=fixture();Object.assign(detail.task,patch);detail.teamReview.current.status=patch.status;assert.equal(reviewView(detail).canAccept,false);}
  const d=fixture();d.teamReview.current.evidence.execution.cleanupConfirmed=false;assert.equal(reviewView(d).actionable,false);
  delete d.teamReview.current.evidence.execution.cleanupConfirmed;assert.equal(reviewView(d).actionable,false);
  d.teamReview.current.evidence.execution.cleanupConfirmed=true;d.teamReview.current.artifacts[0].sourceStatus='changed';
  assert.equal(reviewView(d).evidenceChanged,true);assert.equal(reviewView(d).canAccept,false);assert.equal(artifactLabel(d.teamReview.current.artifacts[0]),'可打开');
  d.teamReview.current.artifacts[0].sourceStatus='available';d.teamReview.current.evidence.captureIncomplete=true;assert.equal(reviewView(d).actionable,false);
});
test('inbox keeps actual questions and review reasons and includes paused or exhausted management',()=>{
  const rows=[{id:'idle',status:'completed',reviewStatus:'accepted'},{id:'question',status:'waiting_input',question:'请选择颜色'},{id:'budget',reviewStatus:'budget_exhausted',inboxReason:'累计额度不足，请核对成果'},{id:'paused',reviewStatus:'paused'}];
  assert.deepEqual(inboxTasks(rows).map(t=>t.id),['question','budget','paused']);assert.equal(inboxText(rows[1]),'请选择颜色');assert.equal(inboxText(rows[2]),'累计额度不足，请核对成果');
});
test('dependency editing is limited to an unstarted current run and reassigned employees keep their identity',()=>{
  const detail={task:{kind:'agent',runId:'r',status:'blocked'},runs:[{id:'old',startedAt:1},{id:'r'}]};assert.equal(canEditDependencies(detail),true);
  detail.runs[1].startedAt=2;assert.equal(canEditDependencies(detail),false);
  assert.equal(employeeTask({routing:'user-reassigned',assignedBotId:'employee',supervisorBotId:'chief'}),true);
  assert.equal(employeeTask({routing:'user-reassigned',assignedBotId:'chief',supervisorBotId:'chief'}),false);
  assert.match(dependencyReason('dependency_waiting_acceptance:other',[{id:'other',title:'竞品报告'}]),/竞品报告.*验收/);
  assert.equal(reviewConflict({code:'team_report_artifact_changed'}),true);assert.equal(reviewConflict({code:'network'}),false);
});
