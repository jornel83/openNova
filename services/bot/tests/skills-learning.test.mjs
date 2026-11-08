import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {lifecycleHost} from './fixtures/lifecycle-host.mjs';
import {DRAFT} from './fixtures/skills-learning-provider.mjs';

function rows(h,table){const db=new DatabaseSync(join(h.home,'bridge.sqlite'),{readOnly:true});try{return db.prepare('SELECT body FROM '+table+' ORDER BY rowid').all().map(row=>JSON.parse(row.body));}finally{db.close();}}
const learning=(h,id)=>rows(h,'opennova_skill_learning').find(item=>item.source.taskId===id);
async function policy(h,patch){const catalog=await h.api('/skills');return h.api('/skill-action',{action:'policy',actionId:'policy-'+Date.now()+'-'+Math.random().toString(36).slice(2),revision:catalog.policy.revision,...patch});}
async function startSource(h,employee,id,marker=''){
  return h.api('/background-task-start',{id,kind:'agent',title:'金额汇总 '+id,assignedBotId:employee.id,workspaceMode:'general',permission:'full',inputFiles:['ledger.csv'],
    goal:'读取 ledger.csv 的 amount 列，用 Decimal 求和，保留两位小数，在 summary.md 输出行数和合计，实际执行检查。'+marker,skillNames:[]});
}
async function accepted(h,id){return h.until(async()=>{const detail=await h.api('/background-task',{id});return detail.task.reviewStatus==='accepted'&&detail;},45000);}
async function candidate(h,id,status){return h.until(async()=>{const catalog=await h.api('/skills');const value=catalog.candidates.find(item=>item.source.taskId===id);return value?.status===status&&value;},45000);}
const sourceBody=detail=>({taskId:detail.task.id,runId:detail.task.runId,reportId:detail.teamReview.current.id,reviewId:detail.task.reviewVersion});

test('accepted work is extracted by a real readonly Harness and reused with new inputs and a pinned skill version',{timeout:120000},async t=>{
  const h=await lifecycleHost(t,{provider:'skills-learning-provider.mjs'});await h.start();const employee=await h.employee();
  const original='item,amount\nA,10.50\nB,20.25\n';writeFileSync(join(h.workspace,'ledger.csv'),original);
  await startSource(h,employee,'learning-first');const source=await accepted(h,'learning-first'),ready=await candidate(h,'learning-first','ready');
  assert.match(ready.content,/csv\.DictReader/);assert.match(ready.content,/Decimal/);assert.match(ready.content,/\{\{input_csv\}\}/);assert.ok(!ready.content.includes('10.50'));
  assert.equal(readFileSync(join(h.workspace,'ledger.csv'),'utf8'),original);
  const entry=learning(h,'learning-first'),internal=await h.api('/background-task',{id:entry.internalId});
  assert.equal(entry.status,'completed');assert.equal(internal.task.permission,'read-only');assert.equal(internal.task.managementReview.kind,'skill-extraction');
  assert.deepEqual(internal.runs[0].jobs.map(job=>job.tool),['read','read','skill_draft']);assert.ok(internal.runs[0].jobs.every(job=>job.status==='completed'));
  assert.equal(source.runs.length,1);assert.equal((await h.api('/team-overview')).counts.total,1,'internal learning is excluded from user work counts');
  await h.api('/skill-action',{action:'promote',actionId:'promote-csv',candidateId:ready.id});
  const catalog=await h.api('/skills',{botId:employee.id}),skill=catalog.skills.find(item=>item.name===DRAFT.name);
  assert.ok(catalog.assignment.names.includes(DRAFT.name),'saving a refined skill makes it available to the source employee');
  const chief=(await h.api('/team')).chiefBotId;assert.ok((await h.api('/skills',{botId:chief})).assignment.names.includes(DRAFT.name));
  await policy(h,{autoCandidate:false});
  writeFileSync(join(h.workspace,'ledger.csv'),'item,amount\nC,4.10\nD,5.20\n');
  await h.api('/background-task-start',{id:'learning-reuse',kind:'agent',title:'复用金额汇总',assignedBotId:employee.id,workspaceMode:'general',permission:'full',inputFiles:['ledger.csv'],goal:'USE_LEARNED_SKILL 对新 ledger.csv 金额求和并验证 summary.md。',skillNames:[DRAFT.name]});
  const reused=await accepted(h,'learning-reuse');assert.equal(readFileSync(join(reused.workspace.path,'summary.md'),'utf8'),'行数：2\n合计：9.30\n');
  assert.equal(reused.skills[0].version,skill.version);const loaded=reused.runs[0].jobs.find(job=>job.tool==='skill');assert.ok(loaded,JSON.stringify(reused.runs[0].jobs));assert.match(loaded.output,/Decimal/);
  assert.equal(rows(h,'opennova_skill_record').find(item=>item.kind==='usage'&&item.taskId==='learning-reuse').status,'accepted','usage feedback is independent of automatic extraction');
  await h.stop();await h.start();await delay(1100);
  assert.equal(rows(h,'opennova_skill_learning').filter(item=>item.source.taskId==='learning-first').length,1);
  assert.equal(rows(h,'background_task').filter(item=>item.managementReview?.kind==='skill-extraction').length,1);
  const replay=await h.api('/skill-candidate',{...sourceBody(source),actionId:'explicit-existing'});assert.equal(replay.learning.internalId,entry.internalId);
  assert.equal(rows(h,'background_task').filter(item=>item.managementReview?.kind==='skill-extraction').length,1);
});

test('historical accepted work remains idle until explicitly requested when automatic extraction is disabled',{timeout:90000},async t=>{
  const h=await lifecycleHost(t,{provider:'skills-learning-provider.mjs',foregroundProvider:'skills-provider.mjs'});await h.start();const employee=await h.employee();await policy(h,{autoCandidate:false,autoEnable:true});
  writeFileSync(join(h.workspace,'ledger.csv'),'item,amount\nA,1.00\nB,2.00\n');await startSource(h,employee,'historical-source');const source=await accepted(h,'historical-source');
  assert.equal(rows(h,'opennova_skill_learning').length,0);await h.stop();await h.start();await delay(1100);assert.equal(rows(h,'opennova_skill_learning').length,0);
  await h.foreground('manual-history-voice','skill_extract',sourceBody(source));const ready=await candidate(h,'historical-source','promoted');assert.equal(ready.source.reportId,source.teamReview.current.id);
  await h.until(async()=>{const view=await h.api('/skills',{botId:employee.id});return !view.sync.pending&&view.assignment.names.includes(DRAFT.name);});
  const chief=(await h.api('/team')).chiefBotId;assert.ok((await h.api('/skills',{botId:chief})).assignment.names.includes(DRAFT.name),'automatic promotion uses the same durable default binding path');
  await h.foreground('manual-history-voice','skill_extract',sourceBody(source));
  await h.api('/skill-candidate',{...sourceBody(source),actionId:'manual-history'});
  const replay=await h.api('/skill-candidate',{...sourceBody(source),actionId:'manual-history'});assert.equal(replay.replayed,true);
  assert.equal(rows(h,'background_task').filter(item=>item.managementReview?.kind==='skill-extraction').length,1);
});

test('failed extraction requires an explicit new request and old request replay cannot create another learning run',{timeout:90000},async t=>{
  const h=await lifecycleHost(t,{provider:'skills-learning-provider.mjs'});await h.start();const employee=await h.employee();await policy(h,{autoCandidate:false});
  const flag=join(h.home,'fail-first-learning');writeFileSync(flag,'fail once');writeFileSync(join(h.workspace,'ledger.csv'),'item,amount\nA,1.00\nB,2.00\n');
  await startSource(h,employee,'failed-draft',' LEARNING_FAIL_ONCE='+Buffer.from(flag).toString('base64'));const source=await accepted(h,'failed-draft'),body={...sourceBody(source),actionId:'learn-first-attempt'};
  await h.api('/skill-candidate',body);await candidate(h,'failed-draft','failed');const failed=learning(h,'failed-draft');
  await delay(1200);assert.equal(learning(h,'failed-draft').internalId,failed.internalId);
  await h.api('/skill-candidate',body);assert.equal(learning(h,'failed-draft').internalId,failed.internalId);
  await h.api('/skill-candidate',{...body,actionId:'learn-second-attempt'});await candidate(h,'failed-draft','ready');
  const completed=learning(h,'failed-draft');assert.notEqual(completed.internalId,failed.internalId);
  await h.api('/skill-candidate',body);assert.equal(learning(h,'failed-draft').internalId,completed.internalId);
  assert.equal(rows(h,'background_task').filter(item=>item.managementReview?.kind==='skill-extraction').length,2);
  assert.equal((await h.api('/background-task',{id:source.task.id})).runs.length,1,'retrying extraction never replays business work');
});

test('changing an accepted source invalidates an unfinished draft and closing its task never resurrects work',{timeout:90000},async t=>{
  const h=await lifecycleHost(t,{provider:'skills-learning-provider.mjs'});await h.start();const employee=await h.employee();await policy(h,{autoCandidate:false});
  writeFileSync(join(h.workspace,'ledger.csv'),'item,amount\nA,1.00\nB,2.00\n');await startSource(h,employee,'changed-source',' LEARNING_SLOW');const source=await accepted(h,'changed-source');
  await h.api('/skill-candidate',{...sourceBody(source),actionId:'learn-changing-source'});
  await h.until(async()=>{const entry=learning(h,'changed-source');if(!entry?.internalId)return false;const detail=await h.api('/background-task',{id:entry.internalId});return detail.runs[0]?.jobs.some(job=>job.tool==='read'&&job.status==='completed');});
  writeFileSync(join(source.workspace.path,'summary.md'),'changed after acceptance\n');await candidate(h,'changed-source','failed');
  const failed=learning(h,'changed-source'),internal=await h.until(async()=>{const value=await h.api('/background-task',{id:failed.internalId});return value.task.cleanupConfirmed&&['cancelled','failed','completed'].includes(value.task.status)&&value;});
  assert.ok(internal.task.cleanupConfirmed);assert.equal((await h.api('/skills')).skills.some(skill=>skill.name===DRAFT.name),false);
  await h.api('/background-task-close',{id:source.task.id,runId:source.task.runId,assignmentVersion:source.task.assignmentVersion,actionId:'close-changed-source'});
  await h.until(async()=>(await h.api('/background-task',{id:source.task.id})).task.closure?.status==='closed');
  const count=rows(h,'background_task').length;await h.stop();await h.start();await delay(1100);
  assert.equal(rows(h,'background_task').length,count);assert.equal((await h.api('/background-task',{id:source.task.id})).runs.length,1);
  const result=await h.api('/skill-candidate',{...sourceBody(source),actionId:'closed-source-request'},400);assert.match(result.error,/skill_source_not_accepted/);
});

test('closing a source during readonly extraction cleans the internal worker and does not enable a skill',{timeout:90000},async t=>{
  const h=await lifecycleHost(t,{provider:'skills-learning-provider.mjs'});await h.start();const employee=await h.employee();await policy(h,{autoCandidate:false});
  writeFileSync(join(h.workspace,'ledger.csv'),'item,amount\nA,1.00\nB,2.00\n');await startSource(h,employee,'closed-while-refining',' LEARNING_SLOW');const source=await accepted(h,'closed-while-refining');
  await h.api('/skill-candidate',{...sourceBody(source),actionId:'learn-before-close'});
  const internalId=await h.until(async()=>{const entry=learning(h,source.task.id);if(!entry?.internalId)return false;const detail=await h.api('/background-task',{id:entry.internalId});return detail.runs[0]?.jobs.some(job=>job.tool==='read'&&job.status==='completed')&&entry.internalId;});
  await h.api('/background-task-close',{id:source.task.id,runId:source.task.runId,assignmentVersion:source.task.assignmentVersion,actionId:'close-active-extraction'});
  await h.until(async()=>(await h.api('/background-task',{id:source.task.id})).task.closure?.status==='closed');
  await h.until(()=>learning(h,source.task.id).status==='failed');
  const internal=await h.api('/background-task',{id:internalId});assert.equal(internal.task.cleanupConfirmed,true);assert.equal(internal.task.status,'cancelled');
  assert.equal((await h.api('/skills')).skills.some(item=>item.name===DRAFT.name),false);
  await h.stop();await h.start();await delay(1100);
  assert.equal((await h.api('/background-task',{id:source.task.id})).task.closure.status,'closed');
  assert.equal(rows(h,'background_task').filter(item=>item.managementReview?.kind==='skill-extraction').length,1);
});
