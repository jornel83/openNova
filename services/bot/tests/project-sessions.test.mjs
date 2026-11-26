import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,realpathSync,renameSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProjectSessions} from '../projects/sessions.mjs';

function fixture(t) {
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-project-sessions-')));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const projects=['a','b'].map(id=>({id,name:id,workspace:join(home,id),status:'active'}));
  for(const project of projects)mkdirSync(project.workspace);
  const bot={id:'legacy-id',workDir:projects[0].workspace,segments:[{sessionId:'legacy-earlier'}],permission:'danger-full-access'};
  const agents=new Map(),created=[],models=[],permissions=[],saved=[],workspaces=new Map();
  const add=(id,cwd)=>{const agent={id,session:{id,header:{cwd}},whenIdle:async()=>{}};agents.set(id,agent);return agent;};
  add(bot.id,bot.workDir);
  const ctx={workspaceRegistry:{resolveByPath:async cwd=>workspaces.get(cwd),create:async(cwd)=>{const value={id:`ws-${workspaces.size}`,path:cwd};workspaces.set(cwd,value);return value;}},
    sessionController:{create:async({sessionId,cwd})=>{created.push({sessionId,cwd});add(sessionId,cwd);return {sessionId};}}};
  const rt={home,state:{bots:{[bot.id]:bot}},chatOf:()=>bot.sessionId??bot.id,switchJobs:()=>[],
    resolveAgent:async id=>{if(!agents.has(id))throw Error('missing_session');return agents.get(id);},
    selectSessionModel:async(...value)=>models.push(value),applyPermission:async(...value)=>permissions.push(value),ensureCapabilities:async()=>{},
    save:async()=>saved.push(structuredClone(rt.state)),followFolder:()=>{throw Error('project_handoff_forbidden');}};
  const sessions=new ProjectSessions({ctx,rt,bot,workspace:bot.workDir});
  return {home,projects,bot,ctx,rt,sessions,agents,created,models,permissions,saved,workspaces,add};
}

test('project and daily conversations preserve one bot identity without carrying legacy or another project history',async t=>{
  const f=fixture(t),[a,b]=f.projects;
  assert.equal(f.sessions.capture(),null);
  const first=await f.sessions.activate({focus:'work',project:a});
  assert.notEqual(first.sessionId,f.bot.id);assert.equal(f.bot.id,'legacy-id');assert.deepEqual(f.bot.segments,[]);
  const daily=await f.sessions.activate({focus:'daily',project:a});
  const second=await f.sessions.activate({focus:'work',project:b});
  assert.equal(daily.projectId,null);assert.equal(daily.cwd,join(f.home,'daily-workspace'));
  assert.equal(new Set([first.sessionId,daily.sessionId,second.sessionId]).size,3);
  assert.deepEqual(await f.sessions.activate({focus:'daily',project:b}),daily);
  assert.deepEqual(await f.sessions.activate({focus:'work',project:a}),first);
  assert.equal(f.created.length,3);assert.ok(f.models.every(([,model])=>model.model==='gpt-6.1-sol'));
  assert.ok(f.permissions.every(([bot])=>bot.permission==='danger-full-access'));
  assert.equal(f.sessions.owns('legacy-id'),false);assert.equal(f.sessions.owns(second.sessionId),true);
  assert.equal(f.sessions.owns(second.sessionId,{activeOnly:true}),false);
});

test('native parts stay with their originating project across switching and restart',async t=>{
  const f=fixture(t),[a,b]=f.projects;
  const first=await f.sessions.activate({focus:'work',project:a});
  f.bot.segments.push({sessionId:first.sessionId,note:'A only'});
  f.bot.sessionId='native-part-a';f.add('native-part-a',a.workspace);
  await f.sessions.save();
  const second=await f.sessions.activate({focus:'work',project:b});
  assert.deepEqual(f.bot.segments,[]);assert.equal(f.sessions.owns('native-part-a',{activeOnly:true}),false);
  const state=structuredClone(f.rt.state);f.rt.state=state;Object.assign(f.bot,state.bots[f.bot.id]);f.rt.state.bots[f.bot.id]=f.bot;
  const restored=new ProjectSessions({ctx:f.ctx,rt:f.rt,bot:f.bot,workspace:a.workspace});
  assert.equal(restored.capture().sessionId,second.sessionId);
  assert.equal((await restored.activate({focus:'work',project:a})).sessionId,'native-part-a');
  assert.deepEqual(f.bot.segments,[{sessionId:first.sessionId,note:'A only'}]);
  assert.equal(f.created.length,2);
});

test('archived projects and changed persisted cwd never replace the active conversation',async t=>{
  const f=fixture(t),[a,b]=f.projects;
  const active=await f.sessions.activate({focus:'work',project:a});
  await assert.rejects(f.sessions.activate({focus:'work',project:{...b,status:'archived'}}),/project_archived/);
  await f.sessions.activate({focus:'work',project:b});
  f.agents.get(active.sessionId).session.header.cwd=b.workspace;
  await assert.rejects(f.sessions.activate({focus:'work',project:a}),/workspace_changed/);
  assert.equal(f.sessions.capture().projectId,b.id);
});

test('daily and managed workspaces reopen their native sessions after a home rename',async t=>{
  const f=fixture(t),oldHome=join(f.home,'old-home'),newHome=join(f.home,'main');
  const project={...f.projects[0],workspace:join(oldHome,'projects','a')};
  mkdirSync(project.workspace,{recursive:true});
  const open=home=>new ProjectSessions({ctx:f.ctx,rt:f.rt,bot:f.bot,workspace:f.bot.workDir,dailyWorkspace:join(home,'daily-workspace')});
  const before=open(oldHome);
  const work=await before.activate({focus:'work',project});
  const workWorkspaceId=f.rt.state.workspaceId;
  const daily=await before.activate({focus:'daily'});
  const dailyWorkspaceId=f.rt.state.workspaceId;

  renameSync(oldHome,newHome);symlinkSync(newHome,oldHome,'dir');
  for(const [oldPath,workspace] of [...f.workspaces]) {
    const path=realpathSync(oldPath);
    f.workspaces.delete(oldPath);f.workspaces.set(path,{...workspace,path});
  }
  const after=open(newHome),workPath=join(newHome,'projects','a');
  assert.deepEqual(await after.activate({focus:'daily'}),{...daily,cwd:join(newHome,'daily-workspace')});
  assert.equal(f.rt.state.workspaceId,dailyWorkspaceId);
  const checkpoint=after.checkpoint();
  assert.deepEqual(await after.activate({focus:'work',project:{...project,workspace:workPath}}),{...work,cwd:workPath});
  assert.equal(f.rt.state.workspaceId,workWorkspaceId);
  assert.equal(f.bot.workDir,work.cwd);
  assert.equal(f.agents.get(work.sessionId).session.header.cwd,work.cwd);
  assert.equal((await after.restore(checkpoint)).sessionId,daily.sessionId);
  assert.equal(f.created.length,2);
});

test('cancellation during session preparation leaves the prior project selected',async t=>{
  const f=fixture(t),[a,b]=f.projects;
  const prior=await f.sessions.activate({focus:'work',project:a}),controller=new AbortController();
  f.rt.selectSessionModel=async()=>controller.abort();
  await assert.rejects(f.sessions.activate({focus:'work',project:b,signal:controller.signal}),/abort/i);
  assert.deepEqual(f.sessions.capture(),prior);
});

test('an explicit project directory edit creates a fresh same-project conversation and keeps old history readable',async t=>{
  const f=fixture(t),[a,b]=f.projects;
  const prior=await f.sessions.activate({focus:'work',project:a});
  const moved=await f.sessions.activate({focus:'work',project:{...a,workspace:b.workspace}});
  assert.equal(moved.projectId,a.id);assert.equal(moved.cwd,b.workspace);assert.notEqual(moved.sessionId,prior.sessionId);
  assert.equal(f.bot.segments.at(-1).sessionId,prior.sessionId);
  assert.equal(f.agents.get(prior.sessionId).session.header.cwd,a.workspace);
  assert.equal(f.sessions.owns(prior.sessionId,{activeOnly:true}),true);
  await f.sessions.activate({focus:'work',project:b});
  assert.deepEqual(f.bot.segments,[]);
  assert.equal((await f.sessions.activate({focus:'work',project:{...a,workspace:b.workspace}})).sessionId,moved.sessionId);
});

test('a failed state save rolls back the projection and ownership before another request',async t=>{
  const f=fixture(t),[a,b]=f.projects;
  const prior=await f.sessions.activate({focus:'work',project:a});
  let fail=true;const save=f.rt.save;
  f.rt.save=async()=>{if(fail){fail=false;throw Error('disk_failure');}return save();};
  await assert.rejects(f.sessions.activate({focus:'work',project:b}),/disk_failure/);
  assert.deepEqual(f.sessions.capture(),prior);
  assert.equal(f.sessions.owns(f.created.at(-1).sessionId),false);
});

test('a directory-edit rollback restores the exact prior session and segment projection',async t=>{
  const f=fixture(t),[a,b]=f.projects;
  const prior=await f.sessions.activate({focus:'work',project:a}),checkpoint=f.sessions.checkpoint();
  const oldSegments=structuredClone(f.bot.segments);
  const prepared=await f.sessions.activate({focus:'work',project:{...a,workspace:b.workspace}});
  assert.notEqual(prepared.sessionId,prior.sessionId);
  assert.deepEqual(await f.sessions.restore(checkpoint),prior);
  assert.deepEqual(f.bot.segments,oldSegments);assert.equal(f.created.length,2);
  assert.equal(f.sessions.owns(prepared.sessionId),false);
  await assert.rejects(f.sessions.restore(checkpoint),/checkpoint_invalid/);
  await assert.rejects(f.sessions.restore({}),/checkpoint_invalid/);
});

test('selection rollback preserves pre-existing destination sessions and restart state',async t=>{
  const f=fixture(t),[a,b]=f.projects;
  const target=await f.sessions.activate({focus:'work',project:b});
  const prior=await f.sessions.activate({focus:'work',project:a}),checkpoint=f.sessions.checkpoint();
  await f.sessions.activate({focus:'work',project:b});
  assert.deepEqual(await f.sessions.restore(checkpoint),prior);
  assert.equal(f.sessions.owns(target.sessionId),true);
  const last=f.saved.at(-1).opennovaProjectSessions[f.bot.id];
  assert.equal(last.scopes[last.activeKey].sessionId,prior.sessionId);
  assert.equal((await f.sessions.activate({focus:'work',project:b})).sessionId,target.sessionId);
  assert.equal(f.created.length,2);
});

test('archive management has a separate neutral conversation without project working history',async t=>{
  const f=fixture(t),[a]=f.projects;
  const work=await f.sessions.activate({focus:'work',project:a});
  const management=await f.sessions.activate({focus:'manage',project:{...a,status:'archived'}});
  assert.equal(management.projectId,a.id);assert.equal(management.focus,'manage');assert.equal(management.cwd,join(f.home,'management-workspace'));
  assert.notEqual(management.sessionId,work.sessionId);assert.deepEqual(f.bot.segments,[]);
  assert.equal(f.sessions.owns(work.sessionId,{activeOnly:true}),false);
  assert.deepEqual(await f.sessions.activate({focus:'work',project:a}),work);
  assert.equal(f.bot.id,'legacy-id');
});
