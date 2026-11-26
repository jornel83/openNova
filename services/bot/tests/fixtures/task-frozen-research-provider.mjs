/** Offline model for the real worker: force fresh tool-call IDs after restart. */
import {randomUUID} from 'node:crypto';
import {existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {responseToolChunks} from '../../../agent/responses-protocol.mjs';

export const name='opennova-frozen-research-test',inject=['llm'];
export async function apply(ctx,config){
  const {LlmAdapter}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  class Mock extends LlmAdapter{
    info(){return {provider:'opennova-chatgpt',id:'gpt-6.1-sol',name:'Frozen document test',inputModalities:['text'],context:{contextWindow:64000},defaultMaxTokens:4096};}
    async listModels(){return [this.info()];}async resolveModel(){return this.info();}
    async *stream(options){
      const dir=process.env.OPENNOVA_TEST_FREEZE_GATE;
      const until=async file=>{while(!existsSync(join(dir,file)))await delay(50,undefined,{signal:options.signal});};
      await until('start-reading');
      const index=options.messages.findLastIndex(m=>m.role==='user');
      const turns=options.messages.slice(index+1).filter(m=>m.role==='tool');
      const text=turns.flatMap(m=>m.content??[]).map(b=>b.text??'').join(' ');
      const observed=text.match(/NATIVE_[A-Z_]+/)?.[0];
      const format=process.env.OPENNOVA_TEST_RESEARCH_FORMAT;
      const actions=[
        ['document_read',{path:'source.pdf',question:'Extract the inventory marker.'}],
        ['write',{file_path:'.nova-spec/summary.json',content:JSON.stringify({schemaVersion:1,title:'核对报告',blocks:[{type:'paragraph',text:observed??'MISSING_EVIDENCE'}]})}],
        ['document_generate',{format,specPath:'.nova-spec/summary.json',outputPath:'delivery.'+format}],
      ];
      const planned=actions[turns.length];
      if(!planned){writeFileSync(join(dir,'after-generation'),'1');await until('finish');}
      const output=planned?[{type:'function_call',id:'fc_'+randomUUID(),call_id:'call_'+randomUUID(),name:planned[0],arguments:JSON.stringify(planned[1]),status:'completed'}]:
        [{type:'message',id:'msg_'+randomUUID(),role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'已按冻结资料完成核对。',annotations:[]}]}];
      yield* responseToolChunks({streamItems:async()=>({output})},options,config.allowedTools);
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Mock()));
}
