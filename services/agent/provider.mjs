/** External Cordis provider; the Harness continues to own history and turn settlement. */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createClient } from './chatgpt.mjs';
import { responseChunks } from './provider-core.mjs';

export const name = 'opennova-chatgpt';
export const inject = ['llm'];

export async function apply(ctx, config) {
  if (!config?.harnessRoot) throw new Error('harnessRoot_required');
  const {LlmAdapter} = await import(pathToFileURL(join(config.harnessRoot, 'packages/llm/llm/lib/index.js')).href);
  const client = await createClient();
  class SubscriptionAdapter extends LlmAdapter {
    async listModels(provider) {
      return [{provider, id:'gpt-6.1-sol', name:'GPT-6.1 Sol', inputModalities:['text']}];
    }
    async resolveModel(provider, model) {
      if (model !== 'gpt-6.1-sol') throw new Error('unsupported_model');
      return {provider, id:model, name:'GPT-6.1 Sol', inputModalities:['text']};
    }
    stream(options) { return responseChunks(client, options); }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['opennova-chatgpt'], new SubscriptionAdapter()));
}
