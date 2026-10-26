/** Deterministic model for the real process integration test; no remote connection. */
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
export const name='opennova-offline-model';
export const inject=['llm'];
export async function apply(ctx,config) {
  const {LlmAdapter}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  class Mock extends LlmAdapter {
    info(){return {provider:'opennova-chatgpt',id:'gpt-6.1-sol',name:'Offline fixture',inputModalities:['text'],context:{contextWindow:64000},defaultMaxTokens:4096};}
    async listModels(){return [this.info()];}
    async resolveModel(){return this.info();}
    async *stream(options){
      // Harness also injects runtime-context messages with the user role.
      const input=options.messages.filter(m=>m.role==='user').flatMap(m=>m.content.filter(b=>b.type==='text').map(b=>b.text)).findLast(text=>['hello','slow'].includes(text))||'';
      if(input==='slow')await setTimeout(30000,undefined,{signal:options.signal});
      const text='offline:'+input;
      yield {type:'block-start',index:0,blockType:'text'};
      yield {type:'text-delta',index:0,text};
      yield {type:'block-end',index:0,block:{type:'text',text}};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Mock()));
}
