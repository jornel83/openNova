/** Deterministic model; all browser transport and file effects remain real. */
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {responseToolChunks} from '../../../agent/responses-protocol.mjs';
export const name='opennova-browser-task-fixture';
export const inject=['llm'];
function receipt(message){
  let found;
  const visit=value=>{
    if(typeof value==='string'){try{visit(JSON.parse(value));}catch{}return;}
    if(!value||typeof value!=='object')return;
    if(value.status&&value.page){found=value;return;}
    for(const child of Object.values(value))visit(child);
  };
  visit(message);return found;
}
export async function apply(ctx,config){
  const {LlmAdapter}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  class Mock extends LlmAdapter{
    info(){return {provider:'opennova-chatgpt',id:'gpt-6.1-sol',name:'Browser task fixture',inputModalities:['text'],context:{contextWindow:64000},defaultMaxTokens:4096};}
    async listModels(){return [this.info()];}async resolveModel(){return this.info();}
    async *stream(options){
      const history=JSON.stringify(options.messages),prior=options.messages.filter(message=>message.role==='tool');
      let tool,args,text='Browser source delivered to report.md';
      if(history.includes('READONLY_BROWSER_CATALOG')){
        const host=(options.tools??[]).map(tool=>tool.name).filter(name=>name.startsWith('browser_')||['nova_show','document_open'].includes(name));
        if(host.length)throw Error('readonly_exposed_host_tools:'+host.join(','));
        text='readonly catalog verified: no browser, Nova or document dispatch tools';
      }else if(!prior.length){tool='browser_open';args={url:'https://browser-fixture.invalid/report'};}
      else if(prior.length===1){
        const opened=receipt(prior[0]);if(!opened?.page)throw Error('fixture_open_receipt_missing');
        tool='browser_read';args={page:opened.page};
      }else if(prior.length===2){
        const read=receipt(prior[1]);if(!read?.snapshot?.text)throw Error('fixture_read_receipt_missing');
        tool='write';args={file_path:'report.md',content:'# Browser report\n\nSource: '+read.page.url+'\n\n'+read.snapshot.text+'\n'};
      }
      const output=tool?[{type:'function_call',id:'fc_'+randomUUID(),call_id:'call_'+randomUUID(),name:tool,arguments:JSON.stringify(args),status:'completed'}]
        :[{type:'message',id:'msg_'+randomUUID(),role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text,annotations:[]}]}];
      yield* responseToolChunks({streamItems:async()=>({output})},options,config.allowedTools);
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Mock()));
}
