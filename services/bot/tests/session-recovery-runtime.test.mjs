import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,stat,rename,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {lifecycleHost} from './fixtures/lifecycle-host.mjs';

test('real Harness repairs old packaged empty locks and preserves all identities through another cold start',{timeout:120000},async t=>{
  const host=await lifecycleHost(t,{hostEnv:{OPENNOVA_PACKAGED:'1'},canonicalHome:true});
  const first=await host.start();
  const initial=(await host.api('/projects')).state;
  await host.api('/project-action',{action:'select',focus:'daily',projectId:initial.projectId,revision:initial.revision,actionId:'fixture-daily'});
  await host.stop();
  const statePath=join(host.home,'bot','state.json');
  const before=JSON.parse(await readFile(statePath,'utf8'));
  const projects=before.opennovaProjectSessions[first.botId];
  const identities=[projects.legacy,...Object.values(projects.scopes)];
  assert.equal(new Set(identities.map(row=>row.sessionId)).size,3);
  assert.equal(projects.legacy.sessionId,first.botId);
  const root=join(host.home,'harness','sessions'),directories=[];
  for(const project of await readdir(root,{withFileTypes:true})){
    if(!project.isDirectory())continue;
    for(const entry of await readdir(join(root,project.name),{withFileTypes:true})){
      if(entry.isDirectory()&&identities.some(row=>row.sessionId===entry.name))directories.push(join(root,project.name,entry.name));
    }
  }
  assert.equal(directories.length,3);
  // Deliberately recreate the old packaging failure only inside this test's
  // disposable data. Retain logs in a temporary backup, never forge event rows.
  const backup=join(host.home,'fixture-old-logs');await mkdir(backup);
  for(const [index,directory] of directories.entries()){
    const logs=(await readdir(directory)).filter(name=>name!=='session.lock');
    assert.ok(logs.length>0);
    for(const name of logs)await rename(join(directory,name),join(backup,index+'-'+name));
    assert.deepEqual(await readdir(directory),['session.lock']);
    assert.equal((await stat(join(directory,'session.lock'))).size,0);
  }
  const recovered=await host.start();assert.equal(recovered.botId,first.botId);
  for(const directory of directories){
    const logs=(await readdir(directory)).filter(name=>/^session.*\.jsonl(?:\.zstd)?$/.test(name));
    assert.ok(logs.length>0,JSON.stringify({directory,identities}));for(const name of logs)assert.ok((await stat(join(directory,name))).size>0);
  }
  await host.stop();
  const after=JSON.parse(await readFile(statePath,'utf8'));
  assert.deepEqual(after.mainBotIds,before.mainBotIds);
  assert.deepEqual(after.opennovaProjectSessions,before.opennovaProjectSessions);
  assert.equal(after.bots[first.botId].sessionId,before.bots[first.botId].sessionId);
  const cold=await host.start();assert.equal(cold.botId,first.botId);
  const current=(await host.api('/projects')).state;
  await host.api('/project-action',{action:'select',focus:'work',projectId:initial.projectId,revision:current.revision,actionId:'fixture-return-work'});
  await host.api('/ask',{id:'recovered-text',source:'text',text:'hello'});
  const reply=await host.until(async()=>{const value=await host.api('/result',{id:'recovered-text'});return ['completed','failed','cancelled'].includes(value.status)&&value;});
  assert.equal(reply.status,'completed');assert.equal(reply.text,'offline foreground completed');
  assert.equal(reply.sessionId,projects.scopes['project:'+initial.projectId].sessionId);
  t.diagnostic('three original session IDs recovered via Harness create/flush; another cold start and offline text reply passed');
});
