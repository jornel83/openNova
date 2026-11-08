import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {SkillStore} from '../skills/store.mjs';
import {verifySkillSnapshot} from '../skills/bundle.mjs';

function fixture(t,{video=false}={}){
  const folder=mkdtempSync(join(tmpdir(),'nova-skills-')),root=join(folder,'project'),home=join(folder,'private'),events=[],bots={chief:{id:'chief',capabilities:[]},employee:{id:'employee',capabilities:[]}};
  mkdirSync(home,{recursive:true});mkdirSync(join(root,'skills','sample'),{recursive:true});
  writeFileSync(join(root,'skills','sample','SKILL.md'),'---\nname: sample\ndescription: Read inputs and produce a verified document\n---\n# Workflow\nRead the input and validate the output.\n');
  mkdirSync(join(root,'skills','sample','references'));writeFileSync(join(root,'skills','sample','references','guide.md'),'initial guide');
  if(video){
    mkdirSync(join(root,'skills','video-production','scripts'),{recursive:true});mkdirSync(join(root,'tools','video'),{recursive:true});
    writeFileSync(join(root,'skills','video-production','SKILL.md'),'---\nname: video-production\ndescription: Make video\n---\nUse the tools.\n');
    writeFileSync(join(root,'skills','video-production','scripts','video_tool.py'),readFileSync(new URL('../../../skills/video-production/scripts/video_tool.py',import.meta.url)));
    writeFileSync(join(root,'tools','video','tool.py'),"def main():\n print('original bundled video')\n return 0\n");
    writeFileSync(join(root,'tools','video','tool-definitions.json'),'[]');
  }
  let db=new DatabaseSync(join(home,'state.sqlite')),store;
  const team={chiefId:'chief',rt:{state:{bots}},bot:id=>{if(!bots[id])throw Error('unknown_team_member');return bots[id];}};
  const taskRows=new Map(),reports=new Map(),reviews=new Map();
  const tasks={row:(kind,id)=>{if(kind!=='task'||!taskRows.has(id))throw Error('unknown_task');return taskRows.get(id);},
    reports:{get:id=>reports.get(id),assertCurrent(task,id){const report=reports.get(id);if(report?.runId!==task.runId||task.reportId!==id||report.changed)throw Error('team_report_stale');return report;}},
    supervisor:{get:id=>reviews.get(id),summary(task){return {reportId:task.reportId,reviewStatus:reviews.get(task.reviewId)?.status,reviewVersion:task.reviewId};}}};
  const open=()=>new SkillStore({db,home,root,team,tasks,events:{publish:(...args)=>events.push(args)}});store=open();
  const seed=patch=>{
    const task={id:'task-1',kind:'agent',runId:'run-1',status:'completed',assignmentVersion:1,assignedBotId:'employee',reportId:'report-1',reviewId:'review-1',goal:'SECRET ORIGINAL GOAL',...patch};
    const report={id:task.reportId,taskId:task.id,runId:task.runId,assignmentVersion:task.assignmentVersion,status:'completed',summary:'SECRET ORIGINAL REPORT',
      artifacts:[{id:'file-1',name:'private-customer.md',status:'available',sourceStatus:'available'}],
      evidence:{execution:{cleanupConfirmed:true,exitCode:0},steps:[{id:'s1',tool:'read',status:'completed'},{id:'s2',tool:'write',status:'completed'},{id:'s3',tool:'task_command',status:'completed'}],commands:[{status:'completed',exitCode:0,command:'SECRET COMMAND TOKEN',log:'SECRET LOG'}]}};
    const review={id:task.reviewId,taskId:task.id,runId:task.runId,reportId:report.id,assignmentVersion:task.assignmentVersion,status:'accepted'};
    taskRows.set(task.id,task);reports.set(report.id,report);reviews.set(review.id,review);return {task,report,review};
  };
  t.after(()=>{db.close();rmSync(folder,{recursive:true,force:true});});
  return {root,home,bots,team,tasks,seed,events,taskRows,reports,reviews,get store(){return store;},
    reopen(){db.close();db=new DatabaseSync(join(home,'state.sqlite'));store=open();return store;},
    assign(names,botId='employee',actionId='assign-'+Math.random().toString(36).slice(2)){
      const body={action:'assign',actionId,botId,names,revision:store.assignment(botId).revision};store.prepareAssignment(body);bots[botId].capabilities=[...names];return store.mutate(body);
    },refine(candidate,patch={}){return store.refineCandidate({candidateId:candidate.id,revision:candidate.revision,source:candidate.source,name:candidate.name,description:candidate.description,
      content:'# Reusable document workflow\nRead {{input_path}}, calculate the requested fields, write {{output_path}}, and validate each required row.',actionId:'refine-'+candidate.id.slice(-12),...patch});}};
}

test('bundles archive instructions and references outside the source and old snapshots survive source updates',t=>{
  const f=fixture(t);f.assign(['sample']);const old=f.store.snapshot({assignedBotId:'employee'})[0];
  assert.ok(old.resourceBase.path.startsWith(f.home));assert.equal(old.resourceBase.kind,'directory');
  assert.equal(readFileSync(join(old.resourceBase.path,'references','guide.md'),'utf8'),'initial guide');
  writeFileSync(join(f.root,'skills','sample','references','guide.md'),'changed guide');
  f.reopen();const next=f.store.snapshot({assignedBotId:'employee'})[0];assert.notEqual(old.version,next.version);
  assert.equal(readFileSync(join(old.resourceBase.path,'references','guide.md'),'utf8'),'initial guide');verifySkillSnapshot(old);
  assert.equal(f.store.history('sample').versions.length,2);
});

test('video launcher remains functional in a frozen repository-shaped bundle without reading later tool changes',t=>{
  const f=fixture(t,{video:true});f.assign(['video-production']);const saved=f.store.snapshot({assignedBotId:'employee'})[0];
  writeFileSync(join(f.root,'tools','video','tool.py'),"raise RuntimeError('CHANGED_TOOL_MUST_NOT_RUN')\n");
  const result=spawnSync('python3.11',[join(saved.resourceBase.path,'scripts','video_tool.py')],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/original bundled video/);verifySkillSnapshot(saved);
});

test('Bot capability state is authoritative, explicit empty selection disables skills, unknown and unbound names fail',t=>{
  const f=fixture(t);assert.deepEqual(f.store.snapshot({assignedBotId:'employee'}),[]);
  const catalog=f.store.catalog({botId:'employee'});assert.equal(catalog.skills.length,1);assert.equal(catalog.skills[0].selected,false);assert.equal(catalog.skills[0].available,false);
  assert.throws(()=>f.store.snapshot({assignedBotId:'employee',skillNames:['sample']}),/skill_not_available/);
  f.assign(['sample']);assert.equal(f.store.snapshot({assignedBotId:'employee'}).length,1);assert.deepEqual(f.store.snapshot({assignedBotId:'employee',skillNames:[]}),[]);
  assert.deepEqual(f.store.snapshot({assignedBotId:'employee',managementReview:{}}),[]);
  f.bots.employee.capabilities=[];assert.deepEqual(f.store.snapshot({assignedBotId:'employee'}),[]);
  assert.throws(()=>f.store.snapshot({assignedBotId:'employee',skillNames:['../bad']}),/invalid_skill_selection/);
});

test('assignment intent survives restart, verifies Bot write, and completed replays never reapply old bindings',t=>{
  const f=fixture(t),body={action:'assign',actionId:'attach-once',botId:'employee',names:['sample'],revision:1};
  f.store.prepareAssignment(body);assert.throws(()=>f.store.mutate(body),/skill_assignment_not_applied/);assert.equal(f.reopen().pendingAssignments().length,1);
  f.bots.employee.capabilities=['sample'];f.store.mutate(body);assert.equal(f.store.pendingAssignments().length,0);
  f.bots.employee.capabilities=[];const replay=f.store.mutate(body);assert.equal(replay.replayed,true);assert.deepEqual(f.bots.employee.capabilities,[]);
  assert.throws(()=>f.store.prepareAssignment({...body,names:[]}),/skill_action_conflict/);
});

test('source edits retain immutable versions; rollback and disabled settings persist through refresh',t=>{
  const f=fixture(t),first=f.store.get('sample');
  f.store.mutate({action:'save',actionId:'edit',name:'sample',revision:first.revision,description:first.description,content:'# New workflow\nUse a different validated method.'});
  const next=f.store.get('sample');assert.notEqual(next.version,first.version);
  assert.equal(readFileSync(join(next.resourceBase.path,'references','guide.md'),'utf8'),'initial guide');
  f.store.mutate({action:'rollback',actionId:'back',name:'sample',version:first.version,revision:next.revision});
  const rolled=f.store.get('sample');assert.equal(rolled.version,first.version);
  f.store.mutate({action:'disable',actionId:'off',name:'sample',revision:rolled.revision});
  f.reopen();assert.equal(f.store.catalog().skills.length,0);assert.equal(f.store.get('sample').version,first.version);
  assert.throws(()=>f.store.mutate({action:'enable',actionId:'stale',name:'sample',revision:1}),/skill_changed/);
});

test('an externally altered archive is rejected without silently using current source',t=>{
  const f=fixture(t);f.assign(['sample']);const snapshot=f.store.snapshot({assignedBotId:'employee'})[0],file=join(snapshot.resourceBase.path,'references','guide.md');
  chmodSync(file,0o600);writeFileSync(file,'tampered archive');
  assert.throws(()=>f.store.snapshot({assignedBotId:'employee'}),/skill_snapshot_changed/);
});

test('symlinked resources cannot enter captured bundles',t=>{
  const f=fixture(t);writeFileSync(join(f.home,'private-key'),'SECRET');symlinkSync(join(f.home,'private-key'),join(f.root,'skills','sample','references','secret'));
  const refreshed=f.store.refresh();assert.equal(refreshed.problems[0].error,'skill_resource_symlink');
  assert.equal(f.store.history('sample').versions.length,1);
});

test('accepted evidence produces one private candidate and never copies original goals, documents, commands or logs',t=>{
  const f=fixture(t),source=f.seed(),candidate=f.store.observeAccepted(source.task,source.report,source.review);
  assert.equal(candidate.status,'candidate');assert.equal(f.store.catalog().skills.length,1);assert.equal(f.store.policy().autoEnable,false);
  assert.ok(!JSON.stringify(candidate).includes('SECRET'));assert.ok(!candidate.content.includes('private-customer'));
  assert.deepEqual(candidate.observedTools,['read','write','task_command']);assert.equal(candidate.successfulChecks,1);assert.match(candidate.content,/input_paths/);
  const count=f.events.length;assert.equal(f.store.observeAccepted(source.task,source.report,source.review).id,candidate.id);assert.equal(f.events.length,count);
  f.reopen();assert.equal(f.store.candidates().length,1);assert.equal(f.store.hasObservation(source.report.id,source.review.id),true);
  assert.equal(JSON.parse(readFileSync(join(f.home,'skills','candidates',candidate.id+'.json'))).source.reportId,source.report.id);
});

test('failed, pending, stale, closed and management tasks cannot create experience candidates',t=>{
  const f=fixture(t);
  for(const patch of [{status:'failed'},{kind:'command'},{managementReview:{}},{closure:{status:'closed'}}]){
    const source=f.seed(patch);assert.throws(()=>f.store.observeAccepted(source.task,source.report,source.review),/skill_source_not_accepted/);
  }
  const source=f.seed();source.review.status='pending';assert.throws(()=>f.store.observeAccepted(source.task,source.report,source.review),/skill_source_not_accepted/);
  source.review.status='accepted';source.report.artifacts[0].sourceStatus='changed';assert.throws(()=>f.store.observeAccepted(source.task,source.report,source.review),/skill_source_changed/);
  assert.equal(f.store.candidates().length,0);
});

test('candidate promotion checks current report and review, then records provenance in an immutable version',t=>{
  const f=fixture(t),source=f.seed(),candidate=f.store.observeAccepted(source.task,source.report,source.review);
  assert.throws(()=>f.store.mutate({action:'promote',actionId:'not-ready',candidateId:candidate.id}),/skill_candidate_not_ready/);
  f.refine(candidate);
  source.task.runId='new-run';assert.throws(()=>f.store.mutate({action:'promote',actionId:'stale-source',candidateId:candidate.id}),/skill_source_not_accepted/);
  source.task.runId='run-1';source.report.changed=true;assert.throws(()=>f.store.mutate({action:'promote',actionId:'changed-source',candidateId:candidate.id}),/team_report_stale/);
  source.report.changed=false;
  const saved=f.store.mutate({action:'promote',actionId:'promote',candidateId:candidate.id,name:'document-delivery'});
  assert.equal(saved.result.name,'document-delivery');assert.equal(f.store.candidates()[0].status,'promoted');
  assert.deepEqual(f.store.get('document-delivery').provenance,candidate.source);
  assert.equal(f.store.mutate({action:'promote',actionId:'promote',candidateId:candidate.id,name:'document-delivery'}).replayed,true);
  assert.throws(()=>f.store.mutate({action:'promote',actionId:'second',candidateId:candidate.id}),/skill_candidate_already_promoted/);
});

test('automatic enable is explicitly configured and respects candidate evidence checks',t=>{
  const f=fixture(t),source=f.seed();f.store.mutate({action:'policy',actionId:'auto',revision:1,autoEnable:true});
  const initial=f.store.observeAccepted(source.task,source.report,source.review);assert.equal(initial.status,'candidate');
  const candidate=f.refine(initial);assert.equal(candidate.status,'promoted');assert.equal(f.store.get(candidate.skillName).enabled,true);
  assert.deepEqual(f.store.snapshot({assignedBotId:'employee'}),[],'enabling a skill does not silently assign Bot capabilities');
  assert.throws(()=>f.store.mutate({action:'policy',actionId:'bad-policy',revision:1,autoCandidate:false}),/skill_policy_changed/);
});

test('automatic activation leaves a same-name refined candidate ready instead of overwriting an existing skill',t=>{
  const f=fixture(t),source=f.seed();f.store.mutate({action:'policy',actionId:'auto-existing',revision:1,autoEnable:true});
  const previous=f.store.get('sample'),initial=f.store.observeAccepted(source.task,source.report,source.review),candidate=f.refine(initial,{name:'sample'});
  assert.equal(candidate.status,'ready');assert.equal(f.store.get('sample').version,previous.version);assert.equal(f.store.get('sample').revision,previous.revision);
});

test('candidate refinement binds the accepted evidence and revision, rejects private literals and is idempotent',t=>{
  const f=fixture(t),source=f.seed(),candidate=f.store.observeAccepted(source.task,source.report,source.review);
  assert.throws(()=>f.refine(candidate,{source:{...candidate.source,reportId:'other'}}),/skill_candidate_source_changed/);
  assert.throws(()=>f.refine(candidate,{content:'Read /Users/private-customer/file.csv'}),/skill_candidate_private_literal/);
  const ready=f.refine(candidate);assert.equal(ready.status,'ready');assert.equal(ready.revision,2);
  assert.equal(f.refine(candidate).revision,2);
  assert.throws(()=>f.refine(candidate,{actionId:'other-refinement'}),/skill_candidate_changed/);
  assert.throws(()=>f.refine(candidate,{content:'different'}),/skill_action_conflict/);
});

test('an explicit experience request can bypass disabled auto capture but still requires accepted evidence',t=>{
  const f=fixture(t),source=f.seed();f.store.mutate({action:'policy',actionId:'manual-only',revision:1,autoCandidate:false});
  assert.equal(f.store.observeAccepted(source.task,source.report,source.review),null);
  assert.equal(f.store.observeAccepted(source.task,source.report,source.review,{force:true}).status,'candidate');
  source.review.status='pending';assert.throws(()=>f.store.observeAccepted(source.task,source.report,source.review,{force:true}),/skill_source_not_accepted/);
});

test('skill invocation flags use compatible strict boolean spellings',t=>{
  const f=fixture(t),path=join(f.root,'skills','sample','SKILL.md');
  writeFileSync(path,'---\nname: sample\ndescription: Test flags\ndisable-model-invocation: "yes"\nuser-invocable: "false"\n---\nRead only when requested.\n');
  f.store.refresh();assert.deepEqual(f.store.get('sample').invocation,{model:false,user:false});
  writeFileSync(path,'---\nname: sample\ndescription: Invalid flag\nuser-invocable: maybe\n---\nNo.\n');
  assert.equal(f.store.refresh().problems[0].error,'invalid_skill_invocation');
  assert.deepEqual(f.store.get('sample').invocation,{model:false,user:false});
});

test('editing an existing skill preserves its invocation restrictions in the immutable document',t=>{
  const f=fixture(t),path=join(f.root,'skills','sample','SKILL.md');
  writeFileSync(path,'---\nname: sample\ndescription: Restricted\ndisable-model-invocation: true\nuser-invocable: false\n---\nOriginal instructions.\n');
  f.store.refresh();const original=f.store.get('sample');
  f.store.mutate({action:'save',actionId:'edit-restricted',name:'sample',revision:original.revision,description:'Updated',content:'Updated instructions.'});
  const edited=f.store.get('sample');assert.deepEqual(edited.invocation,{model:false,user:false});
  assert.match(readFileSync(join(edited.resourceBase.path,'SKILL.md'),'utf8'),/disable-model-invocation: true/);
  assert.match(readFileSync(join(edited.resourceBase.path,'SKILL.md'),'utf8'),/user-invocable: false/);
  verifySkillSnapshot(edited);assert.throws(()=>verifySkillSnapshot({...edited,invocation:{model:true,user:false}}),/skill_snapshot_changed/);
  f.reopen();assert.deepEqual(f.store.get('sample').invocation,{model:false,user:false});verifySkillSnapshot(original);
});

test('usage records bind the exact run and version and do not count repeated completion twice',t=>{
  const f=fixture(t);f.assign(['sample']);const skills=f.store.snapshot({assignedBotId:'employee'}),body={taskId:'task-1',runId:'run-1',skills,status:'completed'};
  const first=f.store.recordUsage(body);assert.deepEqual(f.store.recordUsage(body),first);assert.equal(f.store.rows('usage').length,1);
  f.store.recordUsage({...body,status:'accepted',reviewId:'review-1'});assert.equal(f.store.rows('usage').length,1);assert.equal(f.store.rows('usage')[0].status,'accepted');
  assert.throws(()=>f.store.recordUsage({...body,skills:[]}),/skill_usage_conflict/);
});
