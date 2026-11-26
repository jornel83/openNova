import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {lifecycleHost} from './fixtures/lifecycle-host.mjs';
import {DRAFT} from './fixtures/skills-learning-provider.mjs';

function rows(h,table){const db=new DatabaseSync(join(h.home,'bridge.sqlite'),{readOnly:true});try{return db.prepare('SELECT body FROM '+table+' ORDER BY rowid').all().map(row=>JSON.parse(row.body));}finally{db.close();}}

test('readonly extraction recovers from long and Chinese skill names in one run without replaying accepted work',{timeout:90000},async t=>{
  const h=await lifecycleHost(t,{provider:'skills-learning-provider.mjs'});await h.start();const employee=await h.employee();
  writeFileSync(join(h.workspace,'ledger.csv'),'item,amount\nA,10.50\nB,20.25\n');
  const id='learning-repair-names';
  await h.api('/background-task-start',{id,kind:'agent',title:'金额汇总名称修正回归',assignedBotId:employee.id,workspaceMode:'general',permission:'full',inputFiles:['ledger.csv'],
    goal:'读取 ledger.csv 的 amount 列，用 Decimal 求和，在 summary.md 输出行数和合计并实际检查。LEARNING_REPAIR_NAMES',skillNames:[]});
  const source=await h.until(async()=>{const detail=await h.api('/background-task',{id});return detail.task.reviewStatus==='accepted'&&detail;},45000);
  const candidate=await h.until(async()=>{const catalog=await h.api('/skills'),candidate=catalog.candidates.find(item=>item.source.taskId===id);return ['ready','failed'].includes(candidate?.status)&&candidate;},45000);
  const entry=rows(h,'opennova_skill_learning').find(item=>item.source.taskId===id),internal=await h.api('/background-task',{id:entry.internalId});
  const drafts=internal.runs[0].jobs.filter(job=>job.tool==='skill_draft');
  assert.equal(candidate.status,'ready',JSON.stringify({candidateError:candidate.error,result:internal.runs[0].result,drafts:drafts.map(({status,output,error})=>({status,output,error}))}));
  assert.equal(candidate.ready,true);assert.equal(candidate.name,DRAFT.name);
  assert.equal(candidate.description,DRAFT.description);assert.equal(candidate.content,DRAFT.content.trim());
  assert.equal(entry.status,'completed');assert.equal(internal.task.status,'completed');assert.equal(internal.task.permission,'read-only');assert.equal(internal.task.managementReview.kind,'skill-extraction');
  assert.notEqual(internal.task.sessionId,source.task.sessionId);assert.equal(internal.runs.length,1);
  assert.deepEqual(internal.runs[0].jobs.map(job=>job.tool),['read','read','skill_draft','skill_draft','skill_draft']);
  assert.deepEqual(drafts.map(job=>job.status),['failed','failed','completed']);
  assert.deepEqual(drafts.map(job=>job.arguments.name),['csv-decimal-amount-summary-validation','金额汇总技能',DRAFT.name]);
  for(const draft of drafts.slice(0,2)){
    const feedback=draft.output??draft.error;assert.match(feedback,/invalid_skill/);assert.match(feedback,/name/);assert.match(feedback,/32/);assert.match(feedback,/(?:小写英文字母|a-z)/);assert.match(feedback,/中文/);
  }
  assert.match(drafts[2].output,/"submitted":true/);
  const catalog=await h.api('/skills');assert.equal(catalog.skills.some(skill=>skill.name===DRAFT.name),false,'draft recovery does not enable a skill');
  assert.equal(catalog.candidates.filter(item=>item.source.taskId===id).length,1);
  const request={taskId:id,runId:source.task.runId,reportId:source.teamReview.current.id,reviewId:source.task.reviewVersion,actionId:'repair-names-replay'};
  const existing=await h.api('/skill-candidate',request),replay=await h.api('/skill-candidate',request);
  assert.equal(existing.learning.internalId,entry.internalId);assert.equal(replay.learning.internalId,entry.internalId);assert.equal(replay.replayed,true);
  assert.equal(rows(h,'background_task').filter(task=>task.managementReview?.kind==='skill-extraction').length,1);
  assert.equal(rows(h,'opennova_skill_learning').filter(item=>item.source.taskId===id).length,1);
  const preserved=await h.api('/background-task',{id});assert.equal(preserved.runs.length,1);assert.equal(preserved.task.status,'completed');assert.equal(preserved.task.reviewStatus,'accepted');
  assert.equal(preserved.task.runId,source.task.runId);assert.equal(preserved.task.reviewVersion,source.task.reviewVersion);
  assert.equal(readFileSync(join(preserved.workspace.path,'summary.md'),'utf8'),'行数：2\n合计：30.75\n');
});
