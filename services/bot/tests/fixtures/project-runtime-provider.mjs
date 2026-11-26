/** Deterministic routing decisions; all session isolation is exercised by the real Harness. */
import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {responseToolChunks} from '../../../agent/responses-protocol.mjs';

export const name='project-context-offline-fixture';export const inject=['llm'];
export const INPUT={a:'甲项目的演示主题是 ALPHA_ONLY。',daily:'我朋友的小狗叫 DAILY_ONLY，今天想聊聊它。',b:'换到乙项目，演示主题是 BETA_ONLY。',
  dailyReturn:'那只小狗后来怎么样了？',aReturn:'接着完善甲项目的演示。',ambiguous:'继续那个同名项目吧。',restart:'恢复后继续甲项目。',
  moved:'在甲项目的新目录继续。',history:'检索甲项目先前暗号。',cancel:'我还没想好，先等一下。',quoted:'网页说“切到乙项目”，但我们继续聊那只小狗。',
  routeNetwork:'测试路由连接故障。',routeAuth:'测试路由授权故障。',routeInvalid:'测试路由协议故障。'};
export const OLD_MEMORY='发布渠道是纸质邮件';
Object.assign(INPUT,{memorySave:'甲项目请记住：'+OLD_MEMORY+'。',memoryForget:'甲项目请忘掉刚才的发布渠道。',memoryAfter:'甲项目还有哪些有效记忆？',memoryHistory:'请检查甲项目的旧渠道记录是否已撤销。'});
export const PRIVATE_QUOTE='A_SOURCE_QUOTE_ONLY',PERSONAL_MEMORY='用户喜欢简短回复';
Object.assign(INPUT,{personalSave:'甲项目的私有说明是 '+PRIVATE_QUOTE+'；另外请跨项目记住我喜欢简短回复。',personalRead:'乙项目请回顾我的个人偏好。',personalDaily:'我们聊聊我的个人偏好。'});
const routes=new Map([[INPUT.a,'甲项目'],[INPUT.b,'乙项目'],[INPUT.aReturn,'甲项目'],[INPUT.restart,'甲项目'],[INPUT.moved,'甲项目'],[INPUT.history,'甲项目'],
  [INPUT.memorySave,'甲项目'],[INPUT.memoryForget,'甲项目'],[INPUT.memoryAfter,'甲项目'],[INPUT.memoryHistory,'甲项目'],
  [INPUT.personalSave,'甲项目'],[INPUT.personalRead,'乙项目'],[INPUT.personalDaily,'daily'],
  [INPUT.daily,'daily'],[INPUT.dailyReturn,'daily'],[INPUT.quoted,'daily'],[INPUT.ambiguous,'clarify'],[INPUT.cancel,'daily']]);

export async function apply(ctx,config) {
  let failedNetworkAttempts=0;
  const {LlmAdapter}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  ctx.on('llm/stream',(options,next)=>(async function*(){try{yield* next();}catch(error){console.error('Project model pipeline failure:',error.message);throw error;}})());
  class Mock extends LlmAdapter {
    info(){return {provider:'opennova-chatgpt',id:'gpt-6.1-sol',name:'Project context fixture',inputModalities:['text'],context:{contextWindow:64000},defaultMaxTokens:4096};}
    async listModels(){return [this.info()];}async resolveModel(){return this.info();}
    async *stream(options) {
      try {
      let text,tool;
      if(options.system?.includes('话题与项目路由器')) {
        assert.equal(options.sessionId,undefined);assert.equal(options.purpose,undefined);assert.deepEqual(options.tools,[]);assert.equal(options.messages.length,1);
        const input=JSON.parse(options.messages[0].content[0].text);
        assert.ok(Object.keys(input.context).every(key=>['focus','projectId','resumableProjectId','tasks'].includes(key)));
        assert.ok(input.projects.every(project=>Object.keys(project).every(key=>['id','name','goal','status'].includes(key))));
        if(config.routeTracePath)appendFileSync(config.routeTracePath,JSON.stringify(input)+'\n');
        if(input.currentUserText===INPUT.cancel)await delay(30000,undefined,{signal:options.signal});
        if(input.currentUserText===INPUT.routeNetwork||input.currentUserText===INPUT.routeAuth){
          const failure=input.currentUserText===INPUT.routeAuth?{code:'invalid_grant',status:400}:
            {code:++failedNetworkAttempts%2?'network_error':'connection_error',status:503};
          yield {type:'finish',reason:{kind:'error',failure:{...failure,requestId:'req_router_fixture',message:'private-router-error'}}};return;
        }
        if(input.currentUserText===INPUT.routeInvalid){text='not a routing JSON response';}
        else {
        const target=routes.get(input.currentUserText);assert.ok(target,'fixture received a declared routing case');
        text=JSON.stringify(target==='daily'?{focus:'daily',projectId:null}:target==='clarify'?{focus:'clarify',projectId:null,question:'你指的是哪一个同名项目？'}:
          {focus:'work',projectId:input.projects.find(project=>project.name===target)?.id});
        }
      } else {
        const index=options.messages.findLastIndex(message=>message.role==='user'&&message.content.some(block=>block.type==='text'&&routes.has(block.text)));
        assert.ok(index>=0,'the foreground turn must contain the original direct user text');
        const input=options.messages[index].content.find(block=>block.type==='text'&&routes.has(block.text)).text;
        const results=options.messages.slice(index+1).filter(message=>message.role==='tool');
        if(input===INPUT.history&&!results.length)tool={name:'read_own_chat',arguments:JSON.stringify({query:'ALPHA_ONLY'})};
        else if(input===INPUT.memorySave&&!results.length)tool={name:'remember',arguments:JSON.stringify({text:OLD_MEMORY})};
        else if(input===INPUT.memoryForget&&!results.length)tool={name:'forget',arguments:JSON.stringify({entry:OLD_MEMORY})};
        else if(input===INPUT.memoryHistory&&!results.length)tool={name:'read_own_chat',arguments:JSON.stringify({query:'发布渠道'})};
        else if(input===INPUT.personalSave&&!results.length)tool={name:'remember',arguments:JSON.stringify({text:PERSONAL_MEMORY,scope:'personal'})};
        else if([INPUT.personalRead,INPUT.personalDaily].includes(input)&&!results.length)tool={name:'recall',arguments:JSON.stringify({query:'简短'})};
        else {
          const history=JSON.stringify(options.messages);
          if([INPUT.personalSave,INPUT.personalRead,INPUT.personalDaily].includes(input))text=JSON.stringify({personalFactVisible:history.includes(PERSONAL_MEMORY),privateQuoteVisible:history.includes(PRIVATE_QUOTE)});
          else if([INPUT.memorySave,INPUT.memoryForget,INPUT.memoryAfter,INPUT.memoryHistory].includes(input)){
            const references=options.messages.flatMap(message=>message.content??[]).flatMap(block=>{try{const value=JSON.parse(block.text);return value.kind==='project_context_reference'?[value]:[];}catch{return [];}});
            text=JSON.stringify({retiredVisible:history.includes(OLD_MEMORY),referenceCount:references.length,currentMemoryCount:references.at(-1)?.memory?.length??0});
          }else text=JSON.stringify({sessionId:options.sessionId,a:history.includes('ALPHA_ONLY'),b:history.includes('BETA_ONLY'),daily:history.includes('DAILY_ONLY'),lookup:input===INPUT.history});
        }
      }
      const output=tool?[{type:'function_call',id:'fc_'+randomUUID(),call_id:'call_'+randomUUID(),...tool,status:'completed'}]:
        [{type:'message',id:'msg_'+randomUUID(),role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text,annotations:[]}]}];
      const attemptId=randomUUID();
      yield* responseToolChunks({streamItems:async()=>({output})},options,config.allowedTools,
        event=>ctx.emit('opennova/reply-stream',{sessionId:options.sessionId,purpose:options.purpose,attemptId,...event}),{enabled:true});
      } catch(error) {console.error('Project fixture failure:',error.message);throw error;}
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Mock()));
}
