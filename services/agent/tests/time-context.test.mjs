import test from 'node:test';
import assert from 'node:assert/strict';
import {apply} from '../time-context.mjs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {loadSettings} from '../settings.mjs';
const require=createRequire(join(loadSettings().harnessRoot,'packages/core/system-prompt/package.json'));
const {Context}=require('@deepseek-ai/cordis');
const {default:SystemPrompt,renderContextSnapshot}=require('@deepseek-ai/dsh-system-prompt');

test('required time context survives suppression and refreshes across local midnight',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-12T15:59:00Z').valueOf()});
 const ctx=new Context();
 try {
  await ctx.plugin(SystemPrompt,{includeRuntimeContext:false});
  apply(ctx,{timeZone:'Asia/Shanghai'});
  const assembly=await ctx.systemPrompt.assemble();
  const before=renderContextSnapshot(assembly);
  assert.match(before,/Asia\/Shanghai.*2026-10-12.*23:59/);
  assert.match(before,/America\/New_York.*2026-10-12.*11:59/);
  t.mock.timers.tick(120000);
  const after=renderContextSnapshot(ctx.systemPrompt.refreshContext(assembly));
  assert.match(after,/Asia\/Shanghai.*2026-10-13.*00:01/);
  assert.match(after,/America\/New_York.*2026-10-12.*12:01/);
 }finally{await ctx.fiber.dispose();}
});
