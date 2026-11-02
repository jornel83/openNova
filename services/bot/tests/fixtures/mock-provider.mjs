/** Deterministic model for the real process integration test; no remote connection. */
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {responseToolChunks} from '../../../agent/responses-protocol.mjs';
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
      const input=options.messages.filter(m=>m.role==='user').flatMap(m=>m.content.filter(b=>b.type==='text').map(b=>b.text)).findLast(text=>['hello','slow','stream','cancel-stream','stream-fail'].includes(text))||'';
      if(input==='slow')await setTimeout(30000,undefined,{signal:options.signal});
      const parts=input.includes('stream')?['第一句已经生成。','第二句稍后完成。']:['offline:'+input];
      const attemptId=randomUUID();
      const client={async streamItems({onEvent,signal}){
        const message={type:'message',id:'offline-message',role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:parts.join(''),annotations:[]}]};
        onEvent?.({type:'response.output_item.added',output_index:0,item:{...message,status:'in_progress',content:[]}});
        for(const [i,part] of parts.entries()){
          if(i)await setTimeout(input==='cancel-stream'?30000:1000,undefined,{signal});
          if(i&&input==='stream-fail')throw Object.assign(Error('stream_interrupted'),{code:'stream_interrupted'});
          onEvent?.({type:'response.output_text.delta',output_index:0,content_index:0,item_id:message.id,delta:part});
        }
        return {output:[message]};
      }};
      yield* responseToolChunks(client,options,config.allowedTools,
        event=>ctx.emit('opennova/reply-stream',{sessionId:options.sessionId,purpose:options.purpose,attemptId,...event}),{enabled:config.replyMode!=='settled'});
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Mock()));
}
