import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {runtimePatch} from '../configuration.mjs';
import {botSettings,ROOT} from '../settings.mjs';
import {loadSettings} from '../../agent/settings.mjs';
test('the runtime profile mounts versioned OpenNova plugins and the included Bot directly',()=>{
  const b=botSettings({}),s=loadSettings({},'/missing/config');
  const patch=runtimePatch({bot:b,agent:s,webAssets:join(ROOT,'output/bot/web')});
  const plugins=patch.find(row=>row.insert).insert;
  assert.equal(plugins.find(p=>p.id==='opennova-bot').name,join(ROOT,'services/bot/host.mjs'));
  assert.equal(plugins.find(p=>p.id==='opennova-bot').config.plugin,join(ROOT,'engine/bot/ds-bot'));
  assert.equal(plugins.find(p=>p.id==='opennova-chatgpt').config.harnessRoot,join(ROOT,'engine/harness'));
  assert.equal(patch.find(p=>p.id==='agent-default-model').config.provider,'opennova-chatgpt');
});
