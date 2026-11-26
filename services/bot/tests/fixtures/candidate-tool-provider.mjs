// The employee executes a deterministic tool script. The reviewer reads the
// frozen report and all candidate proof via the normal read-only Harness tools.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {responseToolChunks} from '../../../agent/responses-protocol.mjs';
import {apply as employee} from './filesystem-provider.mjs';

export const name='candidate-tool-verification-fixture';
export const inject=['llm'];
export async function apply(ctx,config){
  if(!config.allowedTools.includes('review_decide'))return employee(ctx,config);
  const {LlmAdapter}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  class Reviewer extends LlmAdapter{
    info(){return {provider:'opennova-chatgpt',id:'gpt-6.1-sol',name:'Candidate review fixture',inputModalities:['text'],context:{contextWindow:64000},defaultMaxTokens:4096};}
    async listModels(){return [this.info()];}
    async resolveModel(){return this.info();}
    async *stream(options){
      if(config.allowedTools.some(name=>!['glob','grep','read','review_decide'].includes(name)))throw Error('reviewer_exposed_mutation_tool');
      // Plan reads from the same immutable manifest the host supplies. The decision
      // tool independently rejects a citation if the real read operation is missing.
      const report=JSON.parse(readFileSync('report.json','utf8')),gate=report.evidence.candidateReview;
      const actions=[['read',{file_path:'report.json'}]];
      if(gate?.status==='passed'){
        const evidenceIds=[gate.stepId,gate.patchArtifactId,...gate.artifactIds];
        for(const file of report.artifacts.filter(item=>evidenceIds.includes(item.id))){
          actions.push(['read',{file_path:file.path,...(file.name==='candidate/build.log'?{limit:20}:{})}]);
        }
        actions.push(['review_decide',{action:'accept',summary:'本轮候选补丁与最终回执及回归结果一致。',evidenceIds}]);
      }else actions.push(['review_decide',{action:'needs_user',summary:'缺少本轮候选验收证据，请查看执行日志。',evidenceIds:[]}]);
      const start=options.messages.findLastIndex(message=>message.role==='user');
      const count=options.messages.slice(start+1).filter(message=>message.role==='tool').length;
      const next=actions[count],id=randomUUID();
      const output=next?[{type:'function_call',id:'fc_'+id,call_id:'call_'+id,name:next[0],arguments:JSON.stringify(next[1]),status:'completed'}]:
        [{type:'message',id:'msg_'+id,role:'assistant',status:'completed',content:[{type:'output_text',text:'已核对候选验收证据。',annotations:[]}]}];
      yield* responseToolChunks({streamItems:async()=>({output})},options,config.allowedTools);
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Reviewer()));
}
