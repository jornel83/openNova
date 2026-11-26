import {legacyProjectRoute,routeChunks} from './routing-fixture.mjs';
/** Offline model exercises real media creation and the readonly review tool gate. */
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {responseToolChunks} from '../../../agent/responses-protocol.mjs';
export const name='media-review-fixture';
export const inject=['llm'];

function readJsonResults(messages){
  return messages.filter(message=>message.role==='tool').flatMap(message=>(message.content??[]).flatMap(block=>{
    if(block.type!=='text')return [];
    const lines=block.text.split('\n').filter(line=>/^\d+: /.test(line)).map(line=>line.replace(/^\d+: /,''));
    if(!lines.length)return [];
    try{return [JSON.parse(lines.join('\n'))];}catch{return [];}
  }));
}

export async function apply(ctx,config){
  const {LlmAdapter}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  class Mock extends LlmAdapter{
    info(){return {provider:'opennova-chatgpt',id:'gpt-6.1-sol',name:'Media review fixture',inputModalities:['text'],context:{contextWindow:64000},defaultMaxTokens:4096};}
    async listModels(){return [this.info()];}async resolveModel(){return this.info();}
    async *stream(options){
      const route=legacyProjectRoute(options);if(route){yield* routeChunks(route);return;}
      const index=options.messages.findLastIndex(message=>message.role==='user'),current=options.messages.slice(index);
      const prior=current.filter(message=>message.role==='tool').length,names=(options.tools??[]).map(tool=>tool.name);
      let tool,args,text='本地媒体文件已生成。';
      if(names.includes('review_decide')){
        if(names.some(name=>!['glob','grep','read','review_decide'].includes(name)))throw Error('media_review_exposed_mutation_tool');
        if(!prior){tool='read';args={file_path:'report.json'};}
        else{
          const results=readJsonResults(current),report=results.find(value=>value.reportId&&Array.isArray(value.artifacts));
          if(!report)throw Error('media_fixture_report_not_read');
          if(report.mediaAcceptancePolicy!=='generation-only-v1')throw Error('media_fixture_policy_missing');
          const media=report.artifacts.filter(artifact=>artifact.reviewContent==='generated_media');
          if(!media.length||media.length!==report.artifacts.length)throw Error('media_fixture_generation_evidence_missing');
          const skip=report.goal.includes('MEDIA_SKIP_RECEIPT');
          if(!skip&&prior<=media.length){tool='read';args={file_path:media[prior-1].path};}
          else if(prior===(skip?1:media.length+1)){
            if(!skip&&results.length!==media.length+1)throw Error('media_fixture_receipt_not_read');
            if(!skip&&media.some(artifact=>!results.some(value=>value.artifactId===artifact.id&&value.generatedMedia?.verified===true&&value.generatedMedia.sha256===artifact.sha256&&value.generatedMedia.size===artifact.size)))throw Error('media_fixture_receipt_mismatch');
            tool='review_decide';args={action:'accept',summary:'已读取宿主保存的生成证明，媒体文件已实际生成。默认不要求画面或审美判断。',evidenceIds:media.map(artifact=>artifact.id)};
          }else text='独立验收已结束。';
        }
      }else if(!prior){
        const prompt=JSON.stringify(options.messages);
        const format=prompt.includes('MEDIA_FIXTURE_PNG')?'png':'mp4';
        tool='task_command';args={command:format==='png'
          ?'ffmpeg -v error -f lavfi -i color=c=blue:s=160x90 -frames:v 1 result.png'
          :'ffmpeg -v error -f lavfi -i color=c=blue:s=160x90:r=24 -t 0.5 -c:v libx264 result.mp4',timeoutMs:15000};
      }
      const output=tool?[{type:'function_call',id:'fc_'+randomUUID(),call_id:'call_'+randomUUID(),name:tool,arguments:JSON.stringify(args),status:'completed'}]
        :[{type:'message',id:'msg_'+randomUUID(),role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text,annotations:[]}]}];
      yield* responseToolChunks({streamItems:async()=>({output})},options,config.allowedTools);
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Mock()));
}
