/** External Cordis provider; the Harness continues to own history and turn settlement. */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createClient } from './chatgpt.mjs';
import { responseChunks } from './provider-core.mjs';
import { responseToolChunks } from './responses-protocol.mjs';

export const name = 'opennova-chatgpt';
export const inject = ['llm'];

export async function apply(ctx, config) {
  if (!config?.harnessRoot) throw new Error('harnessRoot_required');
  const {LlmAdapter} = await import(pathToFileURL(join(config.harnessRoot, 'packages/llm/llm/lib/index.js')).href);
  const client = await createClient({capabilities:config.enableTools?'tools':'text'});
  const filter=config.requestFilter?(await import(pathToFileURL(config.requestFilter).href)).filterRequest:options=>options;
  class SubscriptionAdapter extends LlmAdapter {
    info(provider,id='gpt-6.1-sol') {
      const budget=config.modelBudget;
      return {provider,id,name:'GPT-6.1 Sol',inputModalities:['text'],
        ...(budget?{context:{contextWindow:budget.contextWindow},defaultMaxTokens:budget.defaultMaxTokens}:{})};
    }
    async listModels(provider) {
      return [this.info(provider)];
    }
    async resolveModel(provider, model) {
      if (model !== 'gpt-6.1-sol') throw new Error('unsupported_model');
      return this.info(provider,model);
    }
    stream(options) { const request=filter(options,config);return config.enableTools ? responseToolChunks(client,request,config.allowedTools) : responseChunks(client, request); }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['opennova-chatgpt'], new SubscriptionAdapter()));
}
