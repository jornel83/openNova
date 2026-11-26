import {legacyProjectRoute,routeChunks} from './routing-fixture.mjs';
/** Offline model exercises real employee and readonly supervisor Harness sessions. */
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {responseToolChunks} from '../../../agent/responses-protocol.mjs';
export const name='management-fixture';export const inject=['llm'];
export async function apply(ctx,config){
  const {LlmAdapter}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  class Mock extends LlmAdapter{
    info(){return {provider:'opennova-chatgpt',id:'gpt-6.1-sol',name:'Management fixture',inputModalities:['text'],context:{contextWindow:64000},defaultMaxTokens:4096};}
    async listModels(){return [this.info()];}async resolveModel(){return this.info();}
    async *stream(options){
      const route=legacyProjectRoute(options);if(route){yield* routeChunks(route);return;}
      const index=options.messages.findLastIndex(message=>message.role==='user'),current=options.messages.slice(index),history=JSON.stringify(current),prior=current.filter(message=>message.role==='tool').length;
      const names=(options.tools??[]).map(tool=>tool.name);let tool,args,text='员工已交付报告';
      if(names.includes('skill_draft')){
        if(!prior){tool='read';args={file_path:'report.json'};}
        else if(prior===1){tool='skill_draft';args={name:'report-completion',description:'整理输入为报告，核对完整结论后交付。',content:'# 报告交付\n\n输入：input_paths、output_path、acceptance_criteria。\n\n1. 读取本次输入，识别要求的结论。\n2. 将结论写入 output_path。\n3. 读取输出，对照 acceptance_criteria 检查内容；缺少结论时补齐，再交由总管验收。\n\n适用边界：只复用方法，不复制原任务的数据或机器目录。'};}
        else text='技能草稿已整理';
      }else if(names.includes('review_decide')){
        if(names.some(name=>!['glob','grep','read','review_decide'].includes(name)))throw Error('management_exposed_mutation_tool');
        if(prior===0){tool='read';args={file_path:'report.json'};}
        else if(history.includes('COMMAND_REVIEW_FIXTURE')){
          if(prior===1){tool='review_decide';args=history.includes('COMMAND_FAILURE_MARKER')
            ?{action:'request_changes',summary:'命令实际失败，不能沿用成功结果。',instruction:'修复后重新运行命令。',evidenceIds:[]}
            :{action:'accept',summary:'已读取实际命令及输出，退出码为零。',evidenceIds:['report:summary']};}
        }
        else if(prior===1){
          if(history.includes('PAUSE_REVIEW_FIXTURE')&&!history.includes('恢复同一报告的只读验收'))await delay(3000);
          tool='read';args={file_path:'artifacts/001-report.md'};
        }
        else if(prior===2){
          const artifact=history.match(/artifact-[0-9a-f]{64}/)?.[0];if(!artifact)throw Error('management_fixture_evidence_missing');
          tool='review_decide';args=history.includes('NEEDS_USER_REVIEW_FIXTURE')?{action:'needs_user',summary:'成果内容已核对，但最终名称需要用户判断。',evidenceIds:[artifact]}:history.includes('COMPLETE_MARKER')?{action:'accept',summary:'报告内容完整，已经核对成果。',evidenceIds:[artifact]}:{action:'request_changes',summary:'报告缺少完整结论。',instruction:'补齐报告并写入 COMPLETE_MARKER，REWORK_COMPLETE_MARKER。',evidenceIds:[artifact]};
        }else text='总管已提交结构化验收决定';
      }else if(names.includes('skill')&&!prior){tool='skill';args={name:'soak-report'};}
      else if(prior===(names.includes('skill')?1:0)){tool='write';args={file_path:'report.md',content:history.includes('REWORK_COMPLETE_MARKER')?'COMPLETE_MARKER：完整结论。':'DRAFT：缺少完整结论。'};}
      const output=tool?[{type:'function_call',id:'fc_'+randomUUID(),call_id:'call_'+randomUUID(),name:tool,arguments:JSON.stringify(args),status:'completed'}]:[{type:'message',id:'msg_'+randomUUID(),role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text,annotations:[]}]}];
      yield* responseToolChunks({streamItems:async()=>({output})},options,config.allowedTools);
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Mock()));
}
