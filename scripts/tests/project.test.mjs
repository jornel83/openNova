import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,cpSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {ROOT,requireBuiltHarness} from '../../services/runtime/sources.mjs';
import {commandPlan,doctor,requiresBuild} from '../project.mjs';
import {recordBuild,checkBuild,buildArtifacts} from '../build-record.mjs';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'nova-build-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  cpSync(join(ROOT,'upstream.lock.json'),join(root,'upstream.lock.json'));
  for(const [dir,name,version] of [['engine/harness','@deepseek-ai/dsh-root','0.2.1-alpha.2'],['engine/bot/ds-bot','ds-bot','0.1.5']]){
    mkdirSync(join(root,dir),{recursive:true});
    writeFileSync(join(root,dir,'package.json'),JSON.stringify({name,version}));writeFileSync(join(root,dir,'LICENSE'),'fixture');
  }
  mkdirSync(join(root,'services/bot/web'),{recursive:true});writeFileSync(join(root,'services/bot/web/app.jsx'),'original');
  return root;
}

test('setup builds no sources and installs each locked project without modifying Git hooks',()=>{
  const steps=commandPlan('setup',[],ROOT);
  assert.ok(steps.some(s=>s.cwd===join(ROOT,'engine/harness')&&s.args.includes('--frozen-lockfile')));
  assert.ok(steps.some(s=>s.cwd===join(ROOT,'engine/bot/ds-bot')&&s.args.includes('ci')));
  assert.ok(steps.every(s=>s.env.CI==='true'));
  assert.ok(steps.every(s=>!s.args.includes('clone')));
  assert.ok(!steps.some(s=>s.args.some(a=>a.includes('bootstrap.py'))));
  assert.ok(commandPlan('setup',['--chatgpt'],ROOT).some(s=>s.args.some(a=>a.includes('bootstrap.py'))));
  assert.throws(()=>commandPlan('unknown',[],ROOT),/unknown_command/);
  assert.throws(()=>commandPlan('build',['--typo'],ROOT),/unknown_option/);
});

test('missing builds fail with an actionable command instead of inspecting Git HEAD',t=>{
  const root=fixture(t);
  assert.throws(()=>requireBuiltHarness(root),/harness_build_missing.*pnpm run setup/);
  for(const file of ['apps/cli/lib/bin.js','packages/sdk/client/lib/index.js','packages/llm/llm/lib/index.js']){
    mkdirSync(join(root,'engine/harness',file,'..'),{recursive:true});writeFileSync(join(root,'engine/harness',file),'export {};');
  }
  assert.equal(requireBuiltHarness(root).harnessRoot,join(root,'engine/harness'));
});

test('build records work without Git and detect edits, new sources and missing artifacts',t=>{
  const root=fixture(t),asset='output/bot/web/index.html';
  mkdirSync(join(root,'output/bot/web'),{recursive:true});writeFileSync(join(root,asset),'built');
  recordBuild(root,[asset]);assert.equal(checkBuild(root).ready,true);
  writeFileSync(join(root,'services/bot/web/app.jsx'),'edited');assert.equal(checkBuild(root).ready,false);
  recordBuild(root,[asset]);assert.equal(checkBuild(root).ready,true);
  writeFileSync(join(root,'services/bot/web/new.mjs'),'export {};');assert.equal(checkBuild(root).ready,false);
  recordBuild(root,[asset]);rmSync(join(root,asset));assert.equal(checkBuild(root).ready,false);
});

test('help and doctor need no user configuration, authorization or running services',t=>{
  const root=fixture(t);
  const info=doctor(root);
  assert.equal(info.sources,true);assert.equal(info.build.ready,false);
  const result=spawnSync(process.execPath,[join(ROOT,'scripts/project.mjs'),'help'],{cwd:root,encoding:'utf8',env:{...process.env,OPENNOVA_CONFIG:'/unreadable/config'}});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/setup/);assert.match(result.stdout,/doctor/);
});

// The CLI entry imports sibling packages and browser chunks at runtime.
test('build manifest covers secondary runtime modules and web chunks',t=>{
  const root=fixture(t),chunk='engine/harness/packages/core/core/lib/chunks/agent.js';
  mkdirSync(join(root,chunk,'..'),{recursive:true});writeFileSync(join(root,chunk),'runtime');
  assert.ok(buildArtifacts(root).includes(chunk));
  recordBuild(root,[chunk]);rmSync(join(root,chunk));
  assert.equal(checkBuild(root).ready,false);
});

test('stop, status and help remain available when a build is stale',()=>{
  assert.equal(requiresBuild('start',[]),true);
  assert.equal(requiresBuild('start',['--stop']),false);
  assert.equal(requiresBuild('start',['--check']),false);
  assert.equal(requiresBuild('start',['--help']),false);
  assert.equal(requiresBuild('start:voice',['-h']),false);
  assert.equal(requiresBuild('start:voice',['--list-devices']),false);
  assert.equal(requiresBuild('start:voice',['--check']),true);
});
