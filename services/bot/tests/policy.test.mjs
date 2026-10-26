import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeOptions,ALLOWED_TOOLS,MODEL_BUDGET} from '../policy.mjs';
test('obsolete memory is removed from history, system text and replay metadata',()=>{
  const before={system:'旧偏好：简短',messages:[{role:'user',content:[{type:'text',text:'记住：简短'}],source:{replayState:{blocks:[{items:[{content:'简短'}]}]}}}]};
  const out=sanitizeOptions(before,['简短']);
  assert.equal(JSON.stringify(out).includes('简短'),false);
  assert.equal(before.system,'旧偏好：简短');
});
test('single Bot tool policy exposes project writes within the existing tool scope',()=>{
  for(const n of ['create_bot','write_file','apply_patch','message_bot'])assert.ok(!ALLOWED_TOOLS.includes(n));
  for(const n of ['read','write','edit','glob','grep','bash'])assert.ok(ALLOWED_TOOLS.includes(n));
  assert.ok(MODEL_BUDGET.contextWindow<500000);
});
test('new user statements can reintroduce a previously deleted fact',()=>{
  const out=sanitizeOptions({messages:[{id:'old',role:'user',content:[{type:'text',text:'偏好柠檬水'}]},
    {id:'new',role:'user',content:[{type:'text',text:'现在重新记住：偏好柠檬水'}]}]},[{text:'偏好柠檬水',messageIds:['old']}]);
  assert.ok(!out.messages[0].content[0].text.includes('柠檬水'));
  assert.ok(out.messages[1].content[0].text.includes('柠檬水'));
});
