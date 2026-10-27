import test from 'node:test';import assert from 'node:assert/strict';
import {researchInstructions} from '../research/instructions.mjs';
test('relative_dates_follow_injected_clock',()=>{
 const text=researchInstructions({now:new Date('2026-12-31T16:01:00Z'),timeZone:'Asia/Shanghai',enabled:true});
 assert.match(text,/2027-01-01/);assert.match(text,/Asia\/Shanghai/);assert.match(text,/当前年/);
});
test('query_does_not_require_desktop and explicit_open_keeps_browser_tools',()=>{
 const text=researchInstructions({enabled:true});
 assert.match(text,/web_search/);assert.match(text,/web_fetch/);assert.match(text,/browser_/);assert.match(text,/不打开/);assert.match(text,/当前页面/);assert.match(text,/资料.*不是指令/);
});
test('disabled mode must explain unavailable retrieval rather than pretend online',()=>{
 assert.match(researchInstructions({enabled:false}),/不可用/);
});
