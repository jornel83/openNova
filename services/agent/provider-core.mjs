/** Text-only first-demo adapter. Unsupported capabilities fail rather than disappear. */
export function projectRequest(options) {
  if (options.model !== 'gpt-6.1-sol') throw new Error('unsupported_model');
  if (options.tools?.length) throw new Error('voice_demo_tools_disabled');
  const input = options.messages.map(message => {
    if (!['system', 'user', 'assistant'].includes(message.role)) throw new Error('unsupported_role');
    if (message.content.some(block => block.type !== 'text')) throw new Error('unsupported_content');
    return {role: message.role === 'system' ? 'developer' : message.role,
      content: message.content.map(block => block.text).join('')};
  });
  return {model: options.model, input, ...(options.system ? {instructions: options.system} : {})};
}

/** Bridge callback deltas into a bounded stream; only a completed response commits. */
export async function* responseChunks(client, options) {
  const request = projectRequest(options);
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  const queue = [];
  let wake, done = false, failure, result, characters = 0;
  const completion = client.streamResponse({...request, signal, onDelta(text) {
    characters += text.length;
    if (characters > 16000) { abort.abort(); throw new Error('response_too_large'); }
    queue.push(text); wake?.();
  }}).then(value => { result = value; }, error => {
    failure = new Error(/^[a-z_]{1,80}$/.test(error.code ?? '') ? error.code : 'model_request_failed');
  }).finally(() => { done = true; wake?.(); });
  try {
    yield {type: 'block-start', index: 0, blockType: 'text'};
    let text = '';
    while (!done || queue.length) {
      if (!queue.length) { await new Promise(resolve => { wake = resolve; }); wake = undefined; continue; }
      const delta = queue.shift(); text += delta;
      yield {type: 'text-delta', index: 0, text: delta};
    }
    if (failure) throw failure;
    signal.throwIfAborted();
    if (!text.trim() || result?.text !== text) throw new Error('incomplete_model_response');
    yield {type: 'block-end', index: 0, block: {type: 'text', text}};
    yield {type: 'finish', reason: {kind: 'stop'}};
  } finally {
    abort.abort();
    await completion;
  }
}
