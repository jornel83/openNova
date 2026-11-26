import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {responseToolChunks} from '../../../agent/responses-protocol.mjs';
import {legacyProjectRoute,routeChunks} from './routing-fixture.mjs';

export const name='opennova-task-image-media-fixture';
export const inject=['llm'];
const blockTexts=messages=>messages.flatMap(msg=>(msg.content??[]).filter(block=>block.type==='text').map(block=>block.text));
export async function apply(ctx,config){
  const {LlmAdapter}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  class Mock extends LlmAdapter{
    info(){return {provider:'opennova-chatgpt',id:'gpt-6.1-sol',name:'Background media fixture',inputModalities:['text'],context:{contextWindow:64000},defaultMaxTokens:4096};}
    async listModels(){return [this.info()];}
    async resolveModel(){return this.info();}
    async *stream(options){
      const route=legacyProjectRoute(options);if(route){yield* routeChunks(route);return;}
      const matches=text=>text.includes('M5_MEDIA_PLAN=')||text.includes('task-media-');
      const index=options.messages.findLastIndex(message=>message.role==='user'&&blockTexts([message]).some(matches));
      const prompt=blockTexts(options.messages.slice(index,index+1)).join('\n');
      const prior=options.messages.slice(index+1).filter(message=>message.role==='tool').length;
      const plan=[...prompt.matchAll(/M5_MEDIA_PLAN=([A-Za-z0-9+/=]+)/g)].at(-1)?.[1];
      const resumed=[...prompt.matchAll(/task-media-[0-9a-f]+/g)].at(-1)?.[0];
      const actions=resumed?[['task_media_status',{operationId:resumed}],['gif_review',{operationId:resumed,question:'查看首尾动作。'}]]:
        plan?JSON.parse(Buffer.from(plan,'base64').toString('utf8')):[];
      const [tool,args]=actions[prior]??[];
      if(tool&&!options.tools?.some(def=>def.name===tool))throw Error('fixture_media_tool_missing:'+tool);
      const output=tool?[{type:'function_call',id:'fc_'+randomUUID(),call_id:'call_'+randomUUID(),name:tool,arguments:JSON.stringify(args),status:'completed'}]
        :[{type:'message',id:'msg_'+randomUUID(),role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'后台图片流程完成，确认工具回执。',annotations:[]}]}];
      yield* responseToolChunks({streamItems:async()=>({output})},options,config.allowedTools);
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Mock()));
}
