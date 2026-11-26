import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {responseToolChunks} from '../../../agent/responses-protocol.mjs';
export const name='task-recovery-fixture';export const inject=['llm'];
export async function apply(ctx,config){
  const {LlmAdapter,LlmError}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  class Mock extends LlmAdapter{
    info(){return {provider:'opennova-chatgpt',id:'gpt-6.1-sol',name:'Task recovery fixture',inputModalities:['text'],context:{contextWindow:64000},defaultMaxTokens:4096};}
    async listModels(){return [this.info()];}async resolveModel(){return this.info();}
    async *stream(options){
      const current=options.messages.slice(options.messages.findLastIndex(m=>m.role==='user')),history=JSON.stringify(current),prior=current.filter(m=>m.role==='tool').length,names=(options.tools??[]).map(t=>t.name);
      let tool,args,text='RECOVERY_FIXTURE：仅汇总已保存的命令结果 A-731 / v1 / 蓝色，没有重新执行。';
      const fail=()=>{throw new LlmError('network_error','network_error',{status:503,requestId:'req_recovery_fixture'});};
      if(names.includes('review_decide')){
        if(!prior){tool='read';args={file_path:'report.json'};}
        else if(!history.includes('恢复同一报告的只读验收'))fail();
        else if(prior===1){tool='read';args={file_path:'artifacts/001-once.txt'};}
        else if(prior===2){tool='review_decide';args={action:'accept',summary:'已核对原命令的成功证据与补充汇总。',evidenceIds:[history.match(/artifact-[0-9a-f]{64}/)?.[0]]};}
      }else if(names.includes('task_command')){
        if(!prior){tool='task_command';args={command:"printf 'A-731 / v1 / 蓝色\\n' >> once.txt; cat once.txt"};}
        else fail();
      }else if(names.length)throw Error('summary_recovery_exposed_tool');
      const output=tool?[{type:'function_call',id:'fc_'+randomUUID(),call_id:'call_'+randomUUID(),name:tool,arguments:JSON.stringify(args),status:'completed'}]:[{type:'message',id:'msg_'+randomUUID(),role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text,annotations:[]}]}];
      yield* responseToolChunks({streamItems:async()=>({output})},options,config.allowedTools);
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Mock()));
}
