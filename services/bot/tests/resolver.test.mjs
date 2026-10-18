import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {join} from 'node:path';
import {botSettings} from '../settings.mjs';import {loadSettings} from '../../agent/settings.mjs';
test('isolated worktree resolves upstream peers through a symlinked dependency directory',()=>{
 const b=botSettings(),s=loadSettings();
 const r=spawnSync(process.execPath,['--import',new URL('../resolve.mjs',import.meta.url).pathname,'--input-type=module','-e',`await import(${JSON.stringify(join(b.plugin,'index.js'))})`],{encoding:'utf8',env:{...process.env,OPENNOVA_BOT_PLUGIN:b.plugin,OPENNOVA_HARNESS_ROOT:s.harnessRoot}});
 assert.equal(r.status,0,r.stderr);
});
