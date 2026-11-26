/** Deterministic intents; uses the production response projection and real Harness tools. */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {responseToolChunks} from '../../../agent/responses-protocol.mjs';

export const name='native-file-offline-fixture';
export const inject=['llm'];
export const INPUT={
  name:'甲项目读一下 source.pdf。',
  current:'甲项目再读一下当前文件。',
  history:'甲项目复述前面实际读到的标记，不需要重读。',
  betaMissing:'乙项目读一下当前文件。',
  beta:'乙项目读一下 source.pdf。',
  duplicate:'甲项目读一下 dup.pdf。',
  late:'甲项目慢慢读取 late.pdf。',
  changed:'甲项目读取刚刚修改后的当前文件。',
  ambiguous:'甲项目读取 same.pdf。',
  oldExternal:'甲项目读取 old-external.pdf。',
  oldExternalAmbiguous:'甲项目读取 old-same.pdf。',
  desktop:'甲项目：帮我读一下我正在 WPS 里打开的 PDF 文档。',
  desktopVoice:'甲项目：帮我看一下当前我正打开的 PDF 文档。',
  desktopMissing:'甲项目：读一下我正在 WPS 中看的文档。',
};
const commands=new Map([
  [INPUT.name,{path:'source.pdf',question:'marker'}],
  [INPUT.current,{current:true,question:'marker'}],
  [INPUT.betaMissing,{current:true,question:'marker'}],
  [INPUT.beta,{path:'source.pdf',question:'marker'}],
  [INPUT.duplicate,{path:'dup.pdf',question:'marker'}],
  [INPUT.late,{path:'late.pdf',question:'DELAY_LATE'}],
  [INPUT.changed,{current:true,question:'marker'}],
  [INPUT.ambiguous,{path:'same.pdf',question:'marker'}],
  [INPUT.oldExternal,{path:'old-external.pdf',question:'marker'}],
  [INPUT.oldExternalAmbiguous,{path:'old-same.pdf',question:'marker'}],
  [INPUT.desktop,{currentOpen:true,question:'marker'}],
  [INPUT.desktopVoice,{current:true,question:'marker'}],
  [INPUT.desktopMissing,{currentOpen:true,question:'marker'}],
]);
const inputs=new Set(Object.values(INPUT));

export async function apply(ctx,config){
  const {LlmAdapter}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  class Mock extends LlmAdapter{
    info(){return {provider:'opennova-chatgpt',id:'gpt-6.1-sol',name:'Native file fixture',inputModalities:['text'],context:{contextWindow:64000},defaultMaxTokens:4096};}
    async listModels(){return [this.info()];}async resolveModel(){return this.info();}
    async *stream(options){
      let text,tool;
      if(options.system?.includes('话题与项目路由器')){
        const input=JSON.parse(options.messages[0].content[0].text);
        assert.ok(inputs.has(input.currentUserText),'unexpected routing fixture input');
        const project=input.projects.find(p=>p.name===(input.currentUserText.startsWith('乙')?'乙项目':'甲项目'));
        assert.ok(project,'fixture project must exist');
        text=JSON.stringify({focus:'work',projectId:project.id});
      }else{
        const index=options.messages.findLastIndex(m=>m.role==='user'&&m.content.some(b=>b.type==='text'&&inputs.has(b.text)));
        assert.ok(index>=0,'foreground user input must survive native history');
        const input=options.messages[index].content.find(b=>b.type==='text'&&inputs.has(b.text)).text;
        const results=options.messages.slice(index+1).filter(m=>m.role==='tool');
        if(commands.has(input)&&!results.length)tool={name:'document_read',arguments:JSON.stringify(commands.get(input))};
        else{
          const history=options.messages.filter(m=>m.role==='tool').map(m=>m.content.filter(b=>b.type==='text').map(b=>b.text).join('')).join('\n');
          const last=results.at(-1)?.content.filter(b=>b.type==='text').map(b=>b.text).join('');
          let result;try{result=last?JSON.parse(last):undefined;}catch{result={parseError:last};}
          const context=options.messages[index].content.flatMap(block=>{try{const value=JSON.parse(block.text);return value.kind==='project_context_reference'?[value.context]:[];}catch{return [];}}).at(-1);
          text=JSON.stringify({result,sessionId:options.sessionId,
            alpha:history.includes('NATIVE_ALPHA_ONLY'),beta:history.includes('NATIVE_BETA_ONLY'),
            referencePaths:context?.references?.map(reference=>reference.path)??[],
            historySourceIds:[...new Set([...history.matchAll(/"sourceId":"([^"]+)"/g)].map(m=>m[1]))]});
        }
      }
      const output=tool?[{type:'function_call',id:'fc_'+randomUUID(),call_id:'call_'+randomUUID(),...tool,status:'completed'}]:
        [{type:'message',id:'msg_'+randomUUID(),role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text,annotations:[]}]}];
      yield* responseToolChunks({streamItems:async()=>({output})},options,config.allowedTools);
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Mock()));
}
