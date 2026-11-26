/** Offline model responses only: native token measurement and maintenance are unchanged. */
import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {responseToolChunks} from '../../../agent/responses-protocol.mjs';

export const name='project-compaction-offline-fixture',inject=['llm'];
export const INPUT={long:'甲项目请展开 A_COMPACTION_ONLY 的详细说明。',inspectA:'甲项目请核对当前上下文。',
  beta:'乙项目只讨论 B_COMPACTION_ONLY。',daily:'今天想聊 DAILY_COMPACTION_ONLY 的生活故事。'};
const heads=['Goals','Constraints and preferences','Progress','Decisions','Facts to keep','Open threads','Next step','Where to look'];

export async function apply(ctx,config){
  const {LlmAdapter}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  const trace=record=>appendFileSync(config.tracePath,JSON.stringify(record)+'\n');
  class Mock extends LlmAdapter{
    info(){return {provider:'opennova-chatgpt',id:'gpt-6.1-sol',name:'Project compaction fixture',inputModalities:['text'],context:{contextWindow:32000},defaultMaxTokens:4096};}
    async listModels(){return [this.info()];}async resolveModel(){return this.info();}
    async *stream(options){
      const history=JSON.stringify(options.messages),seen={a:history.includes('A_COMPACTION_ONLY'),b:history.includes('B_COMPACTION_ONLY'),daily:history.includes('DAILY_COMPACTION_ONLY')};
      let text,kind;
      if(options.system?.includes('话题与项目路由器')){
        kind='routing';assert.equal(options.sessionId,undefined);assert.deepEqual(options.tools,[]);
        const input=JSON.parse(options.messages[0].content[0].text);
        const target=input.currentUserText===INPUT.daily?null:input.projects.find(project=>project.name===(input.currentUserText===INPUT.beta?'乙项目':'甲项目'))?.id;
        text=JSON.stringify({focus:target?'work':'daily',projectId:target});
      }else if(options.purpose==='compaction'){
        assert.ok(seen.a,'maintenance must be driven by the long A conversation');
        assert.equal(seen.b,false);assert.equal(seen.daily,false);
        // The production preset currently uses native note-and-rollover; it does
        // not mount compaction-basic for in-place checkpoint summaries.
        assert.ok(options.messages.at(-1).content.some(block=>block.text?.includes('writing a handoff note')));
        kind='note';text=heads.map(head=>`## ${head}\n- A_COMPACTION_ONLY; ${head==='Next step'?'(none)':'keep the verified A project context'}`).join('\n\n');
      }else{
        kind='foreground';
        const user=options.messages.flatMap(message=>message.role==='user'?message.content.filter(block=>block.type==='text').map(block=>block.text):[]).findLast(text=>Object.values(INPUT).includes(text));
        assert.ok(user,'foreground must have a declared direct user request');
        text=JSON.stringify({sessionId:options.sessionId,...seen,checkpoint:/\[Checkpoint \d+\]/.test(history),handoff:/\[Handoff · part \d+\]/.test(history),...(user===INPUT.long?{padding:'甲'.repeat(14500)}:{})});
      }
      trace({kind,sessionId:options.sessionId??null,...seen,characters:history.length});
      const output=[{type:'message',id:'offline_compaction',role:'assistant',status:'completed',content:[{type:'output_text',text}]}];
      yield* responseToolChunks({streamItems:async()=>({output})},options,config.allowedTools);
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Mock()));
}
