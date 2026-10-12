import test from 'node:test';import assert from 'node:assert/strict';import {toSpeechText} from '../speech-text.mjs';
test('speech keeps anchor words, Chinese punctuation and ordinary numbers, drops citations/code/URLs',()=>{
 assert.equal(toSpeechText('**今天**（2026年）增长 12.5%，见[官网](https://example.com/a) [1]。\n```py\nsecret=1\n```\nhttps://example.com/abc'),'今天（2026年）增长 12.5%，见官网 。');
 assert.equal(toSpeechText('使用 `--web`。\n- 第一项\n- 第二项'),'使用 --web。 第一项 第二项');
});
