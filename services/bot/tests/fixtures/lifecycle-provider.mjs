import {legacyProjectRoute,routeChunks} from './routing-fixture.mjs';
/** Deterministic foreground requests routed through the real Bot tool gate. */
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {responseToolChunks} from '../../../agent/responses-protocol.mjs';
export const name='lifecycle-foreground-fixture';export const inject=['llm'];
export async function apply(ctx,config){
  const {LlmAdapter}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  class Mock extends LlmAdapter{
    info(){return {provider:'opennova-chatgpt',id:'gpt-6.1-sol',name:'Lifecycle fixture',inputModalities:['text'],context:{contextWindow:64000},defaultMaxTokens:4096};}
    async listModels(){return [this.info()];}async resolveModel(){return this.info();}
    async *stream(options){
      const route=legacyProjectRoute(options);if(route){yield* routeChunks(route);return;}
      const matches=text=>text==='hello'||text==='slow'||text.startsWith('lifecycle:');
      const index=options.messages.findLastIndex(message=>message.role==='user'&&message.content.some(block=>block.type==='text'&&matches(block.text)));
      const input=options.messages[index]?.content.find(block=>block.type==='text'&&matches(block.text))?.text??'';
      if(input==='slow')await delay(30000,undefined,{signal:options.signal});
      const action=input.startsWith('lifecycle:')&&!options.messages.slice(index+1).some(message=>message.role==='tool')?JSON.parse(input.slice(10)):null;
      const output=action?[{type:'function_call',id:'fc_'+randomUUID(),call_id:'call_'+randomUUID(),namespace:'opennova',name:action.name,arguments:JSON.stringify(action.arguments),status:'completed'}]
        :[{type:'message',id:'msg_'+randomUUID(),role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:action?'操作已登记':'offline foreground completed',annotations:[]}]}];
      yield* responseToolChunks({streamItems:async()=>({output})},options,config.allowedTools);
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Mock()));
}
