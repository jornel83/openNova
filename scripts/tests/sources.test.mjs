import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {ROOT,runtimeSources,checkEngineSources} from '../../services/runtime/sources.mjs';
import {loadSettings} from '../../services/agent/settings.mjs';
import {botSettings} from '../../services/bot/settings.mjs';

test('default runtime sources are inside this checkout despite legacy external configuration',t=>{
  const dir=mkdtempSync(join(tmpdir(),'nova-sources-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,'voice.local.json');
  writeFileSync(file,JSON.stringify({agent:{harness_root:'/missing/sibling-harness',siwc_root:'/optional/siwc'}}));
  const s=loadSettings({OPENNOVA_HARNESS_ROOT:'/another/missing-harness'},file);
  assert.equal(s.harnessRoot,join(ROOT,'engine/harness'));
  assert.equal(s.siwcRoot,'/optional/siwc');
  assert.equal(botSettings({}).plugin,join(ROOT,'engine/bot/ds-bot'));
  assert.equal(runtimeSources().harnessRoot,s.harnessRoot);
});

test('source contracts work in a moved export without Git metadata or build outputs',t=>{
  const root=mkdtempSync(join(tmpdir(),'nova-export-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,'upstream.lock.json'),readFileSync(join(ROOT,'upstream.lock.json')));
  for(const [path,name,version] of [['engine/harness','@deepseek-ai/dsh-root','0.2.1-alpha.2'],['engine/bot/ds-bot','ds-bot','0.1.5']]){
    mkdirSync(join(root,path),{recursive:true});
    writeFileSync(join(root,path,'package.json'),JSON.stringify({name,version}));
    writeFileSync(join(root,path,'LICENSE'),'fixture');
  }
  const result=checkEngineSources(root);
  assert.equal(result.harnessRoot,resolve(root,'engine/harness'));
  assert.equal(result.botRoot,resolve(root,'engine/bot/ds-bot'));
  rmSync(join(root,'engine/bot/ds-bot/package.json'));
  assert.throws(()=>checkEngineSources(root),/bundled_bot_source_missing/);
});

test('a source manifest cannot redirect imports outside the checkout',t=>{
  const root=mkdtempSync(join(tmpdir(),'nova-source-path-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const manifest=JSON.parse(readFileSync(join(ROOT,'upstream.lock.json')));
  manifest.components.harness.path='../external';
  writeFileSync(join(root,'upstream.lock.json'),JSON.stringify(manifest));
  assert.throws(()=>runtimeSources(root),/invalid_engine_manifest/);
});
