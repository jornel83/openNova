import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recoverPackagedSessions} from '../session-recovery.mjs';

async function fixture(t) {
  const home=await mkdtemp(join(tmpdir(),'nova-session-recovery-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const root=join(home,'harness','sessions'),workspace=join(home,'workspace');
  await mkdir(workspace,{recursive:true});await mkdir(root,{recursive:true});
  const native='session-native',project='opennova-project',daily='opennova-daily';
  const state={mainBotIds:[native],bots:{[native]:{id:native,sessionId:daily,workDir:join(home,'daily'),segments:[]}},opennovaProjectSessions:{[native]:{version:1,activeKey:'daily',legacy:{sessionId:native,cwd:workspace,segments:[]},scopes:{'project:default':{sessionId:project,cwd:workspace,segments:[]},daily:{sessionId:daily,cwd:join(home,'daily'),segments:[]}}}}};
  await mkdir(join(home,'daily'));
  // All fixture cwd/id characters are ASCII and use the released layout.
  const directory=(id,cwd)=>join(root,'--'+cwd.replaceAll('/','-').replace(/^-+/,'')+'--',id);
  const agents=new Map(),stored=new Map(),created=[],warnings=[];
  const persistence={name:'session-persistence-jsonl',config:{root},stat:async id=>stored.get(id)};
  const missing=id=>({error:Object.assign(Error('session not found'),{code:'session/not-found',sessionId:id})});
  const ctx={get:name=>name==='sessionPersistence'?persistence:undefined,sessionController:{
    resolveAgent:async id=>agents.has(id)?{agent:agents.get(id)}:missing(id),
    create:async ({sessionId,cwd})=>{created.push({sessionId,cwd});agents.set(sessionId,{session:{header:{id:sessionId,cwd}}});return {sessionId};},
  },sessions:{flush:async session=>{const {id,cwd}=session.header;await writeFile(join(directory(id,cwd),'session.v4.jsonl.zstd'),'fixture-log');stored.set(id,{header:{id,cwd}});return true;}}};
  const rt={state,readOnly:()=>undefined,warn:(...args)=>warnings.push(args)};
  const run=env=>recoverPackagedSessions({ctx,rt,home,workspace,env:env??{OPENNOVA_PACKAGED:'1'}});
  const remnant=async (id,cwd=workspace)=>{const dir=directory(id,cwd);await mkdir(dir,{recursive:true});await writeFile(join(dir,'session.lock'),'');return dir;};
  return {home,workspace,root,native,project,daily,state,directory,agents,stored,created,warnings,persistence,ctx,rt,run,remnant};
}

test('recovers native identity plus every saved project/daily scope with the same cwd and no state rewrite',async t=>{
  const f=await fixture(t),before=structuredClone(f.state);
  for(const [id,cwd] of [[f.native,f.workspace],[f.project,f.workspace],[f.daily,join(f.home,'daily')]])await f.remnant(id,cwd);
  assert.deepEqual(await f.run(),{recovered:3});
  assert.deepEqual(f.state,before);assert.equal(f.created.length,3);assert.equal(f.warnings.length,1);
  assert.ok(f.created.some(row=>row.sessionId===f.native&&row.cwd===f.workspace));
  assert.deepEqual(await f.run(),{recovered:0});assert.equal(f.created.length,3);
});

test('development, another store, and a live newly-created session never enter recovery',async t=>{
  const f=await fixture(t);await f.remnant(f.native);
  assert.deepEqual(await f.run({}),{recovered:0});
  f.persistence.config.root=join(f.home,'other');assert.deepEqual(await f.run(),{recovered:0});f.persistence.config.root=f.root;
  f.agents.set(f.native,{session:{header:{id:f.native,cwd:f.workspace}}});assert.deepEqual(await f.run(),{recovered:0});
  assert.equal(f.created.length,0);
});

for(const kind of ['log','empty-log','temporary','nonempty-lock','symlink-lock','symlink-directory'])test('does not repair '+kind,async t=>{
  const f=await fixture(t),directory=await f.remnant(f.native);
  if(kind==='log'||kind==='empty-log')await writeFile(join(directory,'session.v4.jsonl.zstd'),kind==='log'?'broken content':'');
  if(kind==='temporary')await writeFile(join(directory,'.partial'),'');
  if(kind==='nonempty-lock')await writeFile(join(directory,'session.lock'),'owner');
  if(kind==='symlink-lock'){await rm(join(directory,'session.lock'));const target=join(f.home,'lock');await writeFile(target,'');await symlink(target,join(directory,'session.lock'));}
  if(kind==='symlink-directory'){const target=join(f.home,'external');await mkdir(target);await writeFile(join(target,'session.lock'),'');await rm(directory,{recursive:true});await symlink(target,directory);}
  const names=await readdir(directory);
  assert.deepEqual(await f.run(),{recovered:0});assert.equal(f.created.length,0);assert.deepEqual(await readdir(directory),names);
  if(kind==='log')assert.equal(await readFile(join(directory,'session.v4.jsonl.zstd'),'utf8'),'broken content');
});

test('unrelated archived/moved history is skipped while an exact active remnant can recover',async t=>{
  const f=await fixture(t);await f.remnant(f.daily,join(f.home,'daily'));
  f.state.opennovaProjectSessions[f.native].scopes.archived={sessionId:'opennova-gone',cwd:join(f.home,'gone'),segments:[]};
  await f.remnant('opennova-gone',join(f.home,'gone'));
  assert.deepEqual(await f.run(),{recovered:1});assert.deepEqual(f.created.map(row=>row.sessionId),[f.daily]);
});

test('conflicting saved cwd is not guessed and no state is changed',async t=>{
  const f=await fixture(t);await f.remnant(f.project);
  f.state.opennovaProjectSessions[f.native].scopes.other={sessionId:f.project,cwd:join(f.home,'daily'),segments:[]};
  const before=structuredClone(f.state);assert.deepEqual(await f.run(),{recovered:0});assert.deepEqual(f.state,before);
});

test('writer/native/corruption errors cannot become session creation',async t=>{
  const f=await fixture(t);await f.remnant(f.native);
  const error=Object.assign(Error('native failure'),{code:'gateway/internal'});
  f.ctx.sessionController.resolveAgent=async()=>({error});
  await assert.rejects(f.run(),value=>value===error);assert.equal(f.created.length,0);
});

test('flush failure propagates and recovery is never announced as durable',async t=>{
  const f=await fixture(t);await f.remnant(f.native);
  f.ctx.sessions.flush=async()=>{throw Error('disk full');};
  await assert.rejects(f.run(),/disk full/);assert.equal(f.warnings.length,0);assert.equal(f.stored.size,0);
});

test('missing flush listener or physical log fails closed',async t=>{
  for(const result of [false,true]){
    const f=await fixture(t);await f.remnant(f.native);
    f.ctx.sessions.flush=async session=>{f.stored.set(session.header.id,{header:session.header});return result;};
    await assert.rejects(f.run(),/session_recovery_not_durable/);assert.equal(f.warnings.length,0);
  }
});

test('a log appearing during admission is never overwritten',async t=>{
  const f=await fixture(t),directory=await f.remnant(f.native),resolve=f.ctx.sessionController.resolveAgent;
  f.ctx.sessionController.resolveAgent=async id=>{await writeFile(join(directory,'session.v4.jsonl.zstd'),'other writer');return resolve(id);};
  await assert.rejects(f.run(),/session_recovery_evidence_changed/);assert.equal(f.created.length,0);
  assert.equal(await readFile(join(directory,'session.v4.jsonl.zstd'),'utf8'),'other writer');
});
