/** Offline responses exercise real evidence reading, skill extraction and later reuse. */
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {existsSync,unlinkSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {responseToolChunks} from '../../../agent/responses-protocol.mjs';
export const name='skills-learning-fixture';export const inject=['llm'];
export const DRAFT={name:'sum-csv-amounts',description:'汇总 CSV 的 amount 列，使用 Decimal 保留金额精度并验证汇总报告。',content:`# CSV 金额汇总\n\n## 适用条件与输入\n\n输入 {{input_csv}} 必须为 UTF-8 CSV，包含 amount 列；输出位置为 {{output_md}}。其他列可以保留，汇总只使用 amount。\n\n## 步骤\n\n1. 读取表头和样例，确认 amount 存在。\n2. 使用 csv.DictReader 按行读取，通过 Decimal 转换金额，拒绝缺失或非数值单元格。\n3. 用 Decimal 从零开始累加，并统计实际数据行数；避免二进制浮点累计误差。\n4. 生成 Markdown 报告，写入数据行数和保留两位小数的合计。\n5. 重新读取报告，验证行数与输入一致、金额等于独立求和结果，检查命令退出码为零。\n\n## 验证与边界\n\n本方法已经在两行小数金额样例上验证。空文件、缺少 amount 列、金额无效时停止并报告输入问题；不推断币种、不混合不同币种，不承诺大文件内存表现。保留原输入，不复用上次的具体金额。\n`};
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const script="import csv\nfrom decimal import Decimal\nfrom pathlib import Path\nrows=list(csv.DictReader(Path('ledger.csv').open()))\nassert rows and all(r.get('amount') for r in rows)\ntotal=sum((Decimal(r['amount']) for r in rows),Decimal(0))\ntext=f'行数：{len(rows)}\\n合计：{total:.2f}\\n'\nPath('summary.md').write_text(text)\nassert Path('summary.md').read_text()==text\nprint(text)";
export async function apply(ctx,config){
  const {LlmAdapter}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  class Mock extends LlmAdapter{
    info(){return {provider:'opennova-chatgpt',id:'gpt-6.1-sol',name:'Skills learning fixture',inputModalities:['text'],context:{contextWindow:64000},defaultMaxTokens:4096};}
    async listModels(){return [this.info()];}async resolveModel(){return this.info();}
    async *stream(options){
      const taskIndex=options.messages.findLastIndex(message=>message.role==='user'&&message.content?.some(block=>block.type==='text'&&block.text.includes('任务目标：')));
      const index=taskIndex<0?options.messages.findLastIndex(message=>message.role==='user'):taskIndex,current=options.messages.slice(index),history=JSON.stringify(current),prior=current.filter(message=>message.role==='tool').length;
      const names=(options.tools??[]).map(tool=>tool.name);let tool,args,text='已计算 CSV 金额并生成 summary.md，检查通过。';
      if(names.includes('skill_draft')){
        if(names.some(name=>!['glob','grep','read','skill_draft'].includes(name)))throw Error('learning_exposed_mutation_tool');
        if(prior===0){tool='read';args={file_path:'report.json'};}
        else if(prior===1){tool='read';args={file_path:history.match(/artifacts\/\d{3}-summary\.md/)?.[0]??'artifacts/001-summary.md'};}
        else if(prior===2){
          const flag=history.match(/LEARNING_FAIL_ONCE=([A-Za-z0-9+/=]+)/)?.[1];
          const path=flag&&Buffer.from(flag,'base64').toString('utf8');
          if(path&&existsSync(path)){unlinkSync(path);text='模拟一次未提交草稿的模型结束。';}
          else{if(history.includes('LEARNING_SLOW'))await delay(2500,undefined,{signal:options.signal});tool='skill_draft';args=DRAFT;}
        }else text='已提交基于真实证据的参数化 CSV 金额汇总方法。';
      }else if(names.includes('review_decide')){
        if(names.some(name=>!['glob','grep','read','review_decide'].includes(name)))throw Error('review_exposed_mutation_tool');
        if(prior===0){tool='read';args={file_path:'report.json'};}
        else if(prior===1){tool='read';args={file_path:history.match(/artifacts\/\d{3}-summary\.md/)?.[0]??'artifacts/001-summary.md'};}
        else if(prior===2){const artifact=history.match(/artifact-[0-9a-f]{64}/)?.[0];if(!artifact)throw Error('learning_fixture_artifact_missing');tool='review_decide';args={action:'accept',summary:'已读取金额汇总报告并核对实际检查记录。',evidenceIds:[artifact]};}
        else text='总管验收通过。';
      }else{
        const useSkill=history.includes('USE_LEARNED_SKILL');
        if(useSkill&&!names.includes('skill'))throw Error('learned_skill_tool_missing');
        if(useSkill&&prior===0){tool='skill';args={name:DRAFT.name};}
        else{
          if(useSkill&&!history.includes('Decimal'))throw Error('learned_skill_content_not_loaded');
          const step=prior-(useSkill?1:0);
          if(step===0){tool='read';args={file_path:'ledger.csv'};}
          else if(step===1){tool='task_command';args={command:'python3.11 -c '+quote(script)};}
          else if(step===2){tool='read';args={file_path:'summary.md'};}
        }
      }
      const output=tool?[{type:'function_call',id:'fc_'+randomUUID(),call_id:'call_'+randomUUID(),name:tool,arguments:JSON.stringify(args),status:'completed'}]
        :[{type:'message',id:'msg_'+randomUUID(),role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text,annotations:[]}]}];
      yield* responseToolChunks({streamItems:async()=>({output})},options,config.allowedTools);
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Mock()));
}
