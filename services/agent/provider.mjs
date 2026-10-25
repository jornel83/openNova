/** External Cordis provider; the Harness continues to own history and turn settlement. */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createClient } from './chatgpt.mjs';
import { responseChunks } from './provider-core.mjs';
import { responseToolChunks } from './responses-protocol.mjs';
import {errorEvent} from './errors.mjs';
import {MODEL_RETRY_POLICY} from './model-retry.mjs';

export const name = 'opennova-chatgpt';
export const inject = ['llm'];

export async function apply(ctx, config) {
  if (!config?.harnessRoot) throw new Error('harnessRoot_required');
  const llm = await import(pathToFileURL(join(config.harnessRoot, 'packages/llm/llm/lib/index.js')).href);
  const client = await createClient({capabilities:config.enableTools?'tools':'text'});
  const filter=config.requestFilter?(await import(pathToFileURL(config.requestFilter).href)).filterRequest:options=>options;
  ctx.effect(() => ctx.llm.registerAdapter(['opennova-chatgpt'], createSubscriptionAdapter(llm,client,config,filter)));
}

export function createSubscriptionAdapter({LlmAdapter,LlmError},client,config,filter=options=>options){
  return new class SubscriptionAdapter extends LlmAdapter {
    providerRetryPolicy(provider){
      return provider==='opennova-chatgpt'?MODEL_RETRY_POLICY:undefined;
    }
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
    async *stream(options) {
      try{
        const request=filter(options,config);
        yield* config.enableTools?responseToolChunks(client,request,config.allowedTools):responseChunks(client,request);
      }catch(error){
        // Native LlmError preserves safe provider facts through finish and turn/end.
        const {code,status,requestId}=errorEvent(error,'conversation');
        const failureCode=status===503?'model_service_unavailable':code==='model_service_unavailable'?'agent_runtime_failed':code;
        throw new LlmError(failureCode,failureCode,{status,requestId});
      }
    }
  }();
}
