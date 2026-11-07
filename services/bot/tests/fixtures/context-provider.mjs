/** Offline model validates context carried through actual employee and review Harness sessions. */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {responseToolChunks} from '../../../agent/responses-protocol.mjs';
export const name='task-context-fixture';export const inject=['llm'];
export const QUESTION='请告诉我读书会的名称。';
export const ANSWER='名称是“冬季读书会”，请按这个名称完成 welcome.md。';
export const CORRECTION='更正：名称改为“春日读书会”，其余要求不变，请更新 welcome.md。';
function readContent(message){
  const text=(message?.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
  return text.split('\n').filter(line=>/^\d+: /.test(line)).map(line=>line.replace(/^\d+: /,'')).join('\n');
}
export async function apply(ctx,config){
  const {LlmAdapter}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  class Mock extends LlmAdapter{
    info(){return {provider:'opennova-chatgpt',id:'gpt-6.1-sol',name:'Task context fixture',inputModalities:['text'],context:{contextWindow:64000},defaultMaxTokens:4096};}
    async listModels(){return [this.info()];}async resolveModel(){return this.info();}
    async *stream(options){
      const index=options.messages.findLastIndex(message=>message.role==='user'),current=options.messages.slice(index),prior=current.filter(message=>message.role==='tool');
      const names=(options.tools??[]).map(tool=>tool.name);let tool,args,text='员工已按收到的名称完成 welcome.md。';
      if(names.includes('review_decide')){
        assert.ok(names.every(name=>['glob','grep','read','review_decide'].includes(name)),'management tools remain readonly');
        const system=[options.system,...options.messages.filter(message=>['system','developer'].includes(message.role)).map(message=>JSON.stringify(message.content))].filter(Boolean).join('\n');
        assert.match(system,/taskContext/,'management prompt explains the context timeline');
        if(!prior.length){tool='read';args={file_path:'report.json'};}
        else{
          const report=JSON.parse(readContent(prior[0])),context=report.taskContext;
          assert.equal(context?.version,1,'management read contains versioned context');
          assert.equal(context.taskId,report.taskId);assert.equal(context.throughRunId,report.runId);assert.equal(context.assignmentVersion,report.assignmentVersion);
          assert.ok(context.events.some(event=>event.kind==='question'&&event.source==='employee'&&event.text===QUESTION),'original employee question is retained');
          if(report.status==='waiting_input'){
            if(prior.length===1){tool='review_decide';args={action:'needs_user',summary:'还没有收到用户指定的读书会名称。',evidenceIds:[]};}
            else text='总管等待用户提供名称。';
          }else{
            const userEvents=context.events.filter(event=>event.source==='user');
            assert.ok(userEvents.some(event=>event.text===ANSWER),'exact user answer must reach independent management');
            const latest=userEvents.findLast(event=>event.text===ANSWER||event.text===CORRECTION),expected=latest.text===CORRECTION?'春日读书会':'冬季读书会';
            const artifact=report.artifacts.find(item=>item.name==='welcome.md');assert.ok(artifact?.path,'welcome artifact is available');
            if(prior.length===1){tool='read';args={file_path:artifact.path};}
            else if(prior.length===2){
              assert.equal(readContent(prior[1]),'# '+expected+'\n\n欢迎来到'+expected+'。','actual artifact follows the latest explicit user answer');
              tool='review_decide';args={action:'accept',summary:'已核对历史提问、用户明确回答和最新更正，welcome.md 与“'+expected+'”一致。',evidenceIds:[artifact.id]};
            }else text='总管已依据完整问答上下文验收。';
          }
        }
      }else if(!prior.length){
        const history=JSON.stringify(options.messages),answer=history.lastIndexOf('冬季读书会'),correction=history.lastIndexOf('春日读书会');
        if(answer<0&&correction<0){tool='task_question';args={question:QUESTION};}
        else{
          const title=correction>answer?'春日读书会':'冬季读书会';
          tool='write';args={file_path:'welcome.md',content:'# '+title+'\n\n欢迎来到'+title+'。'};
        }
      }else if(JSON.stringify(prior).includes('waitingForUser'))text='已询问读书会名称，等待用户回复。';
      const output=tool?[{type:'function_call',id:'fc_'+randomUUID(),call_id:'call_'+randomUUID(),name:tool,arguments:JSON.stringify(args),status:'completed'}]
        :[{type:'message',id:'msg_'+randomUUID(),role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text,annotations:[]}]}];
      yield* responseToolChunks({streamItems:async()=>({output})},options,config.allowedTools);
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Mock()));
}
