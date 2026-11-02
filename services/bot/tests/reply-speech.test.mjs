import test from 'node:test';import assert from 'node:assert/strict';
import {replySpeechText,replySpeechPrefix} from '../reply-speech.mjs';

const examples=[
  '第一句。第二句很长，数字 12.5% 不拆散。最后一句。',
  '**说明**：[官网](https://example.com/a_(b)) 提供资料。[1] 完成。',
  '先看结果。\n```js\nconst secret=42;\n```\n接下来解释。',
  '请使用 `--help`。\n- 第一项\n- 第二项。',
  '打开[本地文件](/tmp/result.txt)。访问 https://example.com/abc?q=hello 世界。',
  '句子。'.repeat(210),
];
for(const [i,text] of examples.entries())test(`speech projection ${i} stays an append-only prefix under every character split`,()=>{
  const final=replySpeechText(text);let previous='';
  for(let n=1;n<=text.length;n++){
    const prefix=replySpeechPrefix(text.slice(0,n));
    assert.ok(prefix.startsWith(previous),JSON.stringify({n,previous,prefix}));
    assert.ok(final.startsWith(prefix),JSON.stringify({n,prefix,final}));
    assert.ok(prefix.length<=560);previous=prefix;
  }
  assert.ok(previous.length>0);
});
test('unfinished links, citations, code fences and URLs never leak into early speech',()=>{
  for(const tail of ['[label','[label]','[label](https://exam','```js\nsecret=1','https://example.com/a','`hidden'])
    assert.equal(replySpeechPrefix('你好。'+tail),'你好。');
});
test('long research answers preserve the existing short voice summary policy',()=>{
  const text='长句子。'.repeat(200),speech=replySpeechText(text);
  assert.equal(speech,'长句子。'.repeat(140)+'。完整结果已保留在文字界面。');
});
