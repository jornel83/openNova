/** Offline adapter exercises the real isolated Harness runtime and native tools. */
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {responseToolChunks} from '../../../agent/responses-protocol.mjs';
export const name='opennova-task-fixture';
export const inject=['llm'];
export async function apply(ctx,config){
  const {LlmAdapter}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  class Mock extends LlmAdapter{
    info(){return {provider:'opennova-chatgpt',id:'gpt-6.1-sol',name:'Task fixture',inputModalities:['text'],context:{contextWindow:64000},defaultMaxTokens:4096};}
    async listModels(){return [this.info()];} async resolveModel(){return this.info();}
    async *stream(options){
      const index=options.messages.findLastIndex(m=>m.role==='user'&&m.content.some(b=>b.type==='text'&&/任务目标：|用户补充要求：/.test(b.text)));
      const prompt=options.messages[index]?.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')||'';
      const prior=options.messages.slice(index+1).filter(m=>m.role==='tool').length;
      const history=JSON.stringify(options.messages);
      let tool,args;
      if(prompt.includes('RESUME_ONLY')){yield* responseToolChunks({streamItems:async()=>({output:[{type:'message',id:'msg_'+randomUUID(),role:'assistant',status:'completed',content:[{type:'output_text',text:'resumed; remembered='+history.includes('REMEMBER_ALPHA'),annotations:[]}]}]})},options,config.allowedTools);return;}
      if(prompt.includes('FIXTURE_DELAY'))await delay(1200,undefined,{signal:options.signal});
      if(prompt.includes('FIXTURE_SLOW'))await delay(30000,undefined,{signal:options.signal});
      if(prompt.includes('FIXTURE_DOCUMENT')&&!prior){tool='write';args={file_path:'report.md',content:'资料整理完成。'};}
      else if(prompt.includes('FIXTURE_EVENT_SLOW_CHECK')&&!prior){tool='task_check';args={command:"node -e \"require('fs').writeFileSync('check-pid',String(process.pid));setInterval(()=>{},1000)\"",timeoutMs:60000};}
      else if(prompt.includes('FIXTURE_EVENT_LOOP')){
        const event=prompt.includes('"type":"command.finished"');
        const failed=event&&prompt.includes('"status":"failed"');
        const command="node -e \"if(require('fs').readFileSync('sample.txt','utf8')!=='updated\\n')process.exit(7);console.log('event workflow verified')\"";
        const actions=failed?[['read',{file_path:'sample.txt'}],['write',{file_path:'sample.txt',content:'updated\n'}],['task_check',{command}]]:event?[]:[['task_check',{command}]];
        [tool,args]=actions[prior]||[];
      }
      else if(prompt.includes('FIXTURE_COMMAND')&&!prior){tool='task_command';args={command:"node -e \"require('fs').writeFileSync('started',String(process.pid));console.log('command running');setInterval(()=>{},1000)\"",timeoutMs:60000};}
      else if(prompt.includes('FIXTURE_INVALID')&&!prior){tool='task_command';args={command:'true',workdir:'../outside'};}
      else if(prompt.includes('FIXTURE_QUESTION')&&!prior){tool='task_question';args={question:'需要哪种颜色？'};}
      else if(prompt.includes('FIXTURE_EDIT')){
        const actions=[['read',{file_path:'sample.txt'}],['write',{file_path:'sample.txt',content:'updated\n'}],['task_command',{command:"node -e \"if(require('fs').readFileSync('sample.txt','utf8')!=='updated\\n')process.exit(3);console.log('verified')\""}]];
        [tool,args]=actions[prior]||[];
      }else if(!prior&&prompt.includes('FIXTURE_READ')){tool='read';args={file_path:'sample.txt'};}
      const output=tool?[{type:'function_call',id:'fc_'+randomUUID(),call_id:'call_'+randomUUID(),name:tool,arguments:JSON.stringify(args),status:'completed'}]:[{type:'message',id:'msg_'+randomUUID(),role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'fixture completed; remembered='+history.includes('REMEMBER_ALPHA')+'; employee='+prompt.includes('资料整理员'),annotations:[]}]}];
      yield* responseToolChunks({streamItems:async()=>({output})},options,config.allowedTools);
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Mock()));
}
