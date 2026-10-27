import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {ROOT} from '../../services/runtime/sources.mjs';
import {commandPlan} from '../project.mjs';
import {parseArgs} from '../../tools/voice/start.mjs';
import {runtimePatch} from '../../services/bot/configuration.mjs';

test('normal voice startup opens UI by default while headless and checks remain explicit',()=>{
  assert.equal(parseArgs([]).ui,true);
  assert.equal(parseArgs(['--no-ui']).ui,false);
  assert.equal(parseArgs(['--check']).ui,false);
  assert.equal(parseArgs(['--list-devices']).ui,false);
  assert.equal(parseArgs(['--ui']).ui,true);
});
test('root setup includes the locked desktop bridge dependency',()=>{
  assert.ok(commandPlan('setup').some(s=>s.cwd===join(ROOT,'services/bot/desktop')&&s.args.includes('ci')));
});
test('desktop composition uses bundled source and explicit native research settings',()=>{
  const research={enabled:false,mode:'native',provider:'deepseek',version:3};
  const patch=runtimePatch({bot:{home:'/outside/state',plugin:join(ROOT,'engine/bot/ds-bot')},agent:{harnessRoot:join(ROOT,'engine/harness')},desktop:true,research});
  const bot=patch.flatMap(p=>p.insert??[]).find(p=>p.id==='opennova-bot');
  assert.equal(bot.name,join(ROOT,'services/bot/host.mjs'));
  assert.equal(bot.config.desktop,true);assert.equal(bot.config.research.mode,'native');
});
