import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SkillService} from '../skills/service.mjs';

async function fixture(t){
  const folder=mkdtempSync(join(tmpdir(),'nova-skill-sync-')),root=join(folder,'project'),home=join(folder,'private');mkdirSync(join(root,'skills','sample'),{recursive:true});mkdirSync(home);
  writeFileSync(join(root,'skills','sample','SKILL.md'),'---\nname: sample\ndescription: Sample skill\n---\nRead the input.');
  const db=new DatabaseSync(join(home,'bridge.sqlite')),bots={chief:{id:'chief',capabilities:[]},employee:{id:'employee',capabilities:[]}},state={bots,capabilities:{items:{}}};let fail=false;
  const bindings=[];
  const rt={state,async capabilitySave(body){if(fail)throw Error('fixture_mirror_unavailable');state.capabilities.items[body.name]={...body};},async capabilityEndpoint(route,{botId,name,attached}){assert.equal(route,'bot-capability');bindings.push({botId,name,attached});const names=new Set(bots[botId].capabilities);attached?names.add(name):names.delete(name);bots[botId].capabilities=[...names];}};
  const team={chiefId:'chief',rt,bot:id=>{if(!bots[id])throw Error('unknown_team_member');return bots[id];}},tasks={closed:false},options={db,root,home,team,tasks};let service=new SkillService(options);await service.initialize();
  t.after(async()=>{tasks.closed=true;if(service.syncing)await service.syncing;db.close();rmSync(folder,{recursive:true,force:true});});
  return {bots,db,team,tasks,bindings,get service(){return service;},fail(value){fail=value;},async restart(){service=new SkillService(options);await service.initialize();return service;}};
}
const save=(actionId,name)=>({action:'save',actionId,name,description:'Reusable task method',content:'Read {{input}}, validate the requested output, and report evidence.'});

test('saving makes a skill available to the chief once, and restart or old request replay preserves later removal',async t=>{
  const f=await fixture(t),body=save('save-new','document-method');await f.service.mutate(body);assert.ok(f.bots.chief.capabilities.includes('document-method'));
  let binding=f.service.store.assignment('chief');await f.service.mutate({action:'assign',actionId:'remove-saved',botId:'chief',names:[],revision:binding.revision});
  await f.service.mutate(body);assert.deepEqual(f.bots.chief.capabilities,[]);await f.restart();assert.deepEqual(f.bots.chief.capabilities,[]);
  assert.equal(f.service.catalog({}).sync.pending,0);
});

test('a mirror failure stays visibly pending and restarts finish the original default binding intent',async t=>{
  const f=await fixture(t);f.fail(true);const result=await f.service.mutate(save('save-offline','offline-method'));
  assert.ok(result.sync.pending>0);assert.ok(result.problems.some(problem=>problem.error==='fixture_mirror_unavailable'));
  assert.ok(!f.bots.chief.capabilities.includes('offline-method'));assert.equal(f.service.store.pendingAssignments().length,1);
  f.fail(false);await f.restart();assert.ok(f.bots.chief.capabilities.includes('offline-method'));assert.equal(f.service.catalog({}).sync.pending,0);assert.equal(f.service.store.pendingAssignments().length,0);
});

test('new explicit binding intent supersedes an unsynchronized default instead of resurrecting removed skills',async t=>{
  const f=await fixture(t);f.fail(true);await f.service.mutate(save('save-pending','pending-method'));
  const current=f.service.store.assignment('chief');await f.service.mutate({action:'assign',actionId:'remove-before-sync',botId:'chief',names:[],revision:current.revision});
  f.fail(false);await f.service.synchronize(true);assert.deepEqual(f.bots.chief.capabilities,[]);
  await f.service.mutate(save('save-pending','pending-method'));await f.restart();assert.deepEqual(f.bots.chief.capabilities,[]);
});

test('multiple saved skills during a mirror outage merge pending additions without losing earlier skills',async t=>{
  const f=await fixture(t);f.fail(true);await f.service.mutate(save('save-a','method-a'));await f.service.mutate(save('save-b','method-b'));
  f.fail(false);await f.service.synchronize(true);assert.deepEqual([...f.bots.chief.capabilities].sort(),['method-a','method-b','sample']);
  assert.equal(f.service.catalog({}).sync.pending,0);assert.equal(f.service.catalog({}).sync.blocked,0);
});

test('the ordinary tick retries a persisted mirror failure without another user action',async t=>{
  const f=await fixture(t);f.fail(true);await f.service.mutate(save('tick-save','tick-method'));f.fail(false);
  f.service.tick(true);await f.service.syncing;assert.ok(f.bots.chief.capabilities.includes('tick-method'));assert.equal(f.service.catalog({}).sync.pending,0);
});

test('saving after disabling an existing skill retains its binding without reattaching or granting it elsewhere',async t=>{
  const f=await fixture(t);await f.service.mutate({action:'disable',actionId:'disable-original',name:'sample',revision:1});f.bindings.length=0;
  const body=save('save-after-disable','enabled-method');await f.service.mutate(body);
  assert.deepEqual([...f.bots.chief.capabilities].sort(),['enabled-method','sample']);
  assert.deepEqual(f.service.store.snapshot({assignedBotId:'chief'}).map(skill=>skill.name),['enabled-method']);
  assert.deepEqual(f.bindings,[{botId:'chief',name:'enabled-method',attached:true}]);
  await assert.rejects(f.service.mutate({action:'assign',actionId:'new-disabled-binding',botId:'employee',names:['sample'],revision:1}),/skill_not_available/);
  await f.restart();await f.service.mutate(body);
  assert.deepEqual([...f.bots.chief.capabilities].sort(),['enabled-method','sample']);assert.equal(f.service.store.get('sample').enabled,false);
  assert.deepEqual(f.bindings,[{botId:'chief',name:'enabled-method',attached:true}]);assert.equal(f.service.catalog({}).sync.pending,0);
});

test('promoting a learned skill preserves disabled chief and source-employee bindings across restart and replay',async t=>{
  const f=await fixture(t);await f.service.mutate({action:'assign',actionId:'employee-original',botId:'employee',names:['sample'],revision:1});
  const task={id:'source-task',kind:'agent',runId:'source-run',status:'completed',assignmentVersion:1,assignedBotId:'employee',reportId:'source-report'};
  const report={id:'source-report',taskId:task.id,runId:task.runId,assignmentVersion:1,status:'completed',assignedBotId:'employee',artifacts:[],evidence:{execution:{cleanupConfirmed:true},steps:[]}};
  const review={id:'source-review',taskId:task.id,runId:task.runId,reportId:report.id,assignmentVersion:1,status:'accepted'};
  Object.assign(f.tasks,{row:()=>task,reports:{get:()=>report,assertCurrent:()=>report},supervisor:{get:()=>review,summary:()=>({reportId:report.id,reviewStatus:'accepted',reviewVersion:review.id})}});
  const candidate=f.service.store.observeAccepted(task,report,review);
  f.service.store.refineCandidate({actionId:'refine-source',candidateId:candidate.id,revision:candidate.revision,source:candidate.source,name:'learned-method',description:'Reusable reviewed method',content:'Read {{input}}, calculate numeric values, write {{output}}, and compare the result with the inputs.'});
  await f.service.mutate({action:'disable',actionId:'disable-before-promote',name:'sample',revision:1});f.bindings.length=0;
  const body={action:'promote',actionId:'promote-after-disable',candidateId:candidate.id};await f.service.mutate(body);
  for(const bot of Object.values(f.bots))assert.deepEqual([...bot.capabilities].sort(),['learned-method','sample']);
  assert.deepEqual(f.bindings.map(item=>item.name),['learned-method','learned-method']);
  await f.restart();await f.service.mutate(body);assert.equal(f.bindings.length,2);
  const assignment=f.service.store.assignment('employee');await f.service.mutate({action:'assign',actionId:'remove-learned-only',botId:'employee',names:['sample'],revision:assignment.revision});
  await f.service.mutate(body);await f.restart();assert.deepEqual(f.bots.employee.capabilities,['sample']);assert.deepEqual(f.service.store.snapshot({assignedBotId:'employee'}),[]);
});
