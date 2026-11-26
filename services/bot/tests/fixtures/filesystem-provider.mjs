import {legacyProjectRoute,routeChunks} from './routing-fixture.mjs';
/** Deterministic tool plans run through real Harness filesystem tools. */
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {responseToolChunks} from '../../../agent/responses-protocol.mjs';
export const name='filesystem-access-fixture';
export const inject=['llm'];
export async function apply(ctx,config){
  const {LlmAdapter}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  class Mock extends LlmAdapter{
    info(){return {provider:'opennova-chatgpt',id:'gpt-6.1-sol',name:'Filesystem access fixture',inputModalities:['text'],context:{contextWindow:64000},defaultMaxTokens:4096};}
    async listModels(){return [this.info()];}async resolveModel(){return this.info();}
    async *stream(options){
      const route=legacyProjectRoute(options);if(route){yield* routeChunks(route);return;}
      const index=options.messages.findLastIndex(message=>message.role==='user'&&message.content.some(block=>block.type==='text'&&block.text.includes('FS_ACCESS_PLAN=')));
      const prompt=options.messages[index]?.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')??'';
      const encoded=[...prompt.matchAll(/FS_ACCESS_PLAN=([A-Za-z0-9+/=]+)/g)].at(-1)?.[1];
      if(!encoded)throw Error('filesystem_fixture_plan_missing');
      const actions=JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));
      const prior=options.messages.slice(index+1).filter(message=>message.role==='tool').length;
      const [tool,args]=actions[prior]??[];
      const output=tool?[{type:'function_call',id:'fc_'+randomUUID(),call_id:'call_'+randomUUID(),name:tool,arguments:JSON.stringify(args),status:'completed'}]
        :[{type:'message',id:'msg_'+randomUUID(),role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'filesystem fixture complete',annotations:[]}]}];
      yield* responseToolChunks({streamItems:async()=>({output})},options,config.allowedTools);
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Mock()));
}
