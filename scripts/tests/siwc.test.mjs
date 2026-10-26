import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {ROOT,runtimeSources} from '../../services/runtime/sources.mjs';
import {loadSettings} from '../../services/agent/settings.mjs';
import {siwcModule} from '../../services/agent/siwc.mjs';
import {commandPlan} from '../project.mjs';
import {buildArtifacts} from '../build-record.mjs';

test('SDK code stays in repository while authorization and helper paths remain configurable',t=>{
  const root=mkdtempSync(join(tmpdir(),'nova-siwc '));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const config=join(root,'voice.local.json');
  writeFileSync(config,JSON.stringify({agent:{siwc_root:'/missing/old-sdk',siwc_storage:'/outside/credentials',keychain_helper:'/outside/helper'}}));
  const settings=loadSettings({OPENNOVA_SIWC_ROOT:'/another/old-sdk'},config);
  assert.equal(settings.siwcRoot,join(ROOT,'engine/siwc'));
  assert.equal(settings.storageDir,'/outside/credentials');assert.equal(settings.keychainPath,'/outside/helper');
  assert.equal(loadSettings({OPENNOVA_SIWC_STORAGE:'/override/credentials'},config).storageDir,'/override/credentials');
  assert.equal(runtimeSources().siwcRoot,settings.siwcRoot);
});

test('SDK module requires both bundled build entries and ignores old overlays without Git',t=>{
  const root=mkdtempSync(join(tmpdir(),'nova-sdk export '));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const entry=join(root,'engine/siwc/packages/local/dist/index.js');mkdirSync(dirname(entry),{recursive:true});
  assert.throws(()=>siwcModule(root),e=>e.code==='siwc_build_missing'&&/pnpm run build/.test(e.message));
  writeFileSync(entry,'export {};');assert.throws(()=>siwcModule(root),/siwc_build_missing/);
  writeFileSync(join(dirname(entry),'items.js'),'export {};');assert.equal(siwcModule(root),entry);
  rmSync(entry);assert.throws(()=>siwcModule(root),/siwc_build_missing/);
});

test('root setup/build includes locked local SDK and freshness covers its runtime modules',()=>{
  assert.ok(commandPlan('setup').some(s=>s.cwd===join(ROOT,'engine/siwc')&&s.command==='npm'&&s.args[0]==='ci'));
  assert.ok(commandPlan('build').some(s=>s.cwd===join(ROOT,'engine/siwc')&&s.args.includes('@siwc/local')));
  assert.ok(buildArtifacts().includes('engine/siwc/packages/local/dist/index.js'));
  assert.ok(buildArtifacts().includes('engine/siwc/packages/local/dist/items.js'));
});
