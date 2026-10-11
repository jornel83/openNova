import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectRequest, responseChunks } from '../provider-core.mjs';
import { completedReply } from '../result.mjs';

test('preserves complete conversation, maps system messages without dropping history', () => {
  const request = projectRequest({ model: 'gpt-6.1-sol', messages: [
    { role: 'system', content: [{type: 'text', text: 'Speak Chinese.'}] },
    { role: 'user', content: [{type: 'text', text: 'My name is Nova.'}] },
    { role: 'assistant', content: [{type: 'text', text: 'Hello Nova.'}] },
    { role: 'user', content: [{type: 'text', text: 'What is my name?'}] },
  ] });
  assert.deepEqual(request.input.map(x => x.role), ['developer', 'user', 'assistant', 'user']);
  assert.equal(request.input[1].content, 'My name is Nova.');
});

test('rejects unsupported tools, images and model substitution', () => {
  assert.throws(() => projectRequest({model: 'other', messages: []}), /model/);
  assert.throws(() => projectRequest({model: 'gpt-6.1-sol', messages: [], tools: [{name: 'bash'}]}), /tools/);
  assert.throws(() => projectRequest({model: 'gpt-6.1-sol', messages: [{role:'user', content:[{type:'image'}]}]}), /content/);
});

test('emits streamed text then a successful settlement only after completion', async () => {
  const client = { async streamResponse({onDelta}) { onDelta('你好'); onDelta('。'); return {text:'你好。'}; } };
  const chunks = await Array.fromAsync(responseChunks(client, {model:'gpt-6.1-sol', messages:[]}));
  assert.equal(chunks.filter(x => x.type === 'text-delta').map(x=>x.text).join(''), '你好。');
  assert.deepEqual(chunks.at(-1), {type:'finish', reason:{kind:'stop'}});
});

test('a failed stream cannot commit its partial response', async () => {
  const client = { async streamResponse({onDelta}) { onDelta('partial'); throw Object.assign(new Error('private detail'), {code:'stream_interrupted'}); } };
  const chunks = [];
  await assert.rejects(async () => { for await (const c of responseChunks(client, {model:'gpt-6.1-sol', messages:[]})) chunks.push(c); }, /stream_interrupted/);
  assert.equal(chunks.some(x=>x.type === 'finish'), false);
  assert.equal(chunks.some(x=>x.type === 'block-end'), false);
});

test('failed Harness turns cannot publish nonempty partial answers', () => {
  for (const reason of ['error', 'aborted', 'max-tokens']) {
    assert.throws(() => completedReply({finalResponse:'partial', events:[
      {type:'assistant/message', data:{turn:1, message:{content:[{type:'text', text:'partial'}]}}},
      {type:'turn/end', data:{turn:1, reason:{kind:reason}}},
    ]}), /incomplete_agent_turn/);
  }
  assert.throws(() => completedReply({finalResponse:'partial', events:[]}), /incomplete_agent_turn/);
});

test('only an uninterrupted assistant message from the completed turn is spoken', () => {
  const message = {type:'assistant/message', data:{turn:1, message:{content:[{type:'text', text:'你好'}]}}};
  const end = {type:'turn/end', data:{turn:1, reason:{kind:'completed'}}};
  const result = {finalResponse:'你好', events:[message,end]};
  assert.equal(completedReply(result), '你好');
  message.data.interrupted = true;
  assert.throws(() => completedReply(result), /incomplete_agent_turn/);
  delete message.data.interrupted;
  end.data.turn = 2;
  assert.throws(() => completedReply(result), /incomplete_agent_turn/);
});
