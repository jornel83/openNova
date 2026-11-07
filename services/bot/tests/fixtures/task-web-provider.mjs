/** Replaces only the model; web_fetch, HTTP transport and source recording stay real. */
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {responseToolChunks} from '../../../agent/responses-protocol.mjs';
export const name='opennova-task-web-fixture';
export const inject=['llm'];
export async function apply(ctx,config){
  const {LlmAdapter}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  class Mock extends LlmAdapter{
    info(){return {provider:'opennova-chatgpt',id:'gpt-6.1-sol',name:'Task web fixture',inputModalities:['text'],context:{contextWindow:64000},defaultMaxTokens:4096};}
    async listModels(){return [this.info()];}async resolveModel(){return this.info();}
    async *stream(options){
      const index=options.messages.findLastIndex(m=>m.role==='user');
      const history=options.messages.slice(index+1),calls=history.filter(m=>m.role==='tool').length;
      const prompt=JSON.stringify(options.messages.filter(m=>m.role==='user'));
      if(calls&&prompt.includes('FIXTURE_FAIL_AFTER_FETCH'))throw Error('fixture_model_failure');
      if(calls&&prompt.includes('FIXTURE_CANCEL_AFTER_FETCH'))await delay(30000,undefined,{signal:options.signal});
      const actions=[['web_fetch',{url:'http://task-fixture.invalid/source'}],['research_sources',{}]];
      const [tool,args]=actions[calls]??[];
      const output=tool?[{type:'function_call',id:'fc_'+randomUUID(),call_id:'call_'+randomUUID(),name:tool,arguments:JSON.stringify(args),status:'completed'}]:[
        {type:'message',id:'msg_'+randomUUID(),role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'native-body='+JSON.stringify(history).includes('Verified employee web fixture')+'; source-journal='+JSON.stringify(history).includes('page_response'),annotations:[]}]}];
      yield* responseToolChunks({streamItems:async()=>({output})},options,config.allowedTools);
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Mock()));
}
