/** Local fixture that deliberately exceeds the former default step and Token caps. */
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {responseToolChunks} from '../../../agent/responses-protocol.mjs';
export const name='opennova-unlimited-fixture';
export const inject=['llm'];
export async function apply(ctx,config){
  const {LlmAdapter}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  class Mock extends LlmAdapter{
    info(){return {provider:'opennova-chatgpt',id:'gpt-6.1-sol',name:'Unlimited budget fixture',inputModalities:['text'],context:{contextWindow:64000},defaultMaxTokens:4096};}
    async listModels(){return [this.info()];}async resolveModel(){return this.info();}
    async *stream(options){
      const calls=options.messages.filter(message=>message.role==='tool').length;
      const output=calls<40?[{type:'function_call',id:'fc_'+randomUUID(),call_id:'call_'+randomUUID(),name:'read',arguments:JSON.stringify({file_path:'sample.txt'}),status:'completed'}]
        :[{type:'message',id:'msg_'+randomUUID(),role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'Completed forty tool calls with usage recorded.',annotations:[]}]}];
      yield {type:'usage',usage:{inputTokens:6000,outputTokens:10,totalTokens:6010}};
      yield* responseToolChunks({streamItems:async()=>({output})},options,config.allowedTools);
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Mock()));
}
