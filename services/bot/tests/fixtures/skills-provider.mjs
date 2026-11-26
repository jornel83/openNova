import {legacyProjectRoute,routeChunks} from './routing-fixture.mjs';
/** Deterministic requests exercise the real skill catalog and employee tool gate. */
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {responseToolChunks} from '../../../agent/responses-protocol.mjs';
export const name='opennova-skills-fixture';
export const inject=['llm'];
const texts=messages=>messages.flatMap(message=>(message.content??[]).filter(block=>block.type==='text').map(block=>block.text)).join('\n');
export async function apply(ctx,config){
  const {LlmAdapter}=await import(pathToFileURL(join(config.harnessRoot,'packages/llm/llm/lib/index.js')));
  class Mock extends LlmAdapter{
    info(){return {provider:'opennova-chatgpt',id:'gpt-6.1-sol',name:'Skills fixture',inputModalities:['text'],context:{contextWindow:64000},defaultMaxTokens:4096};}
    async listModels(){return [this.info()];}async resolveModel(){return this.info();}
    async *stream(options){
      const route=legacyProjectRoute(options);if(route){yield* routeChunks(route);return;}
      const matches=text=>/SKILLS_PLAN=|SKILLS_VIDEO_(?:FLOW|GENERATE)|^lifecycle:/.test(text);
      const index=options.messages.findLastIndex(message=>message.role==='user'&&(message.content??[]).some(block=>block.type==='text'&&matches(block.text)));
      // A real user turn can also carry work/task reference blocks. The fixture
      // action belongs to its own block; appended reference JSON is not input.
      const prompt=options.messages[index]?.content.find(block=>block.type==='text'&&matches(block.text))?.text??'',current=options.messages.slice(index+1),prior=current.filter(message=>message.role==='tool').length;
      const history=texts(options.messages),names=(options.tools??[]).map(tool=>tool.name),catalog=history.includes('<available_skills>')&&history.includes('video-production');
      let actions=[],tool,args;
      const encoded=[...prompt.matchAll(/SKILLS_PLAN=([A-Za-z0-9+/=]+)/g)].at(-1)?.[1];
      if(encoded){
        const plan=JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));actions=plan.actions;
        if(plan.requireCatalog&&!catalog)throw Error('fixture_skill_catalog_missing');
        if(plan.requiredTools?.some(name=>!names.includes(name)))throw Error('fixture_skill_tool_missing');
      }else if(prompt.startsWith('lifecycle:'))actions=[[JSON.parse(prompt.slice(10)).name,JSON.parse(prompt.slice(10)).arguments]];
      else if(prompt.includes('SKILLS_VIDEO_GENERATE')){
        if(!catalog||!names.includes('video_generate'))throw Error('fixture_video_generate_unavailable');
        const resumed=prompt.includes('视频后台跟进返回：');
        actions=resumed?[]:[
          ['video_generate',{config:{model:'minimax-h3-veda',prompt:'Offline blue test shot',duration:4},
            output_dir:'local-shot',filename:'result.mp4',timeout_seconds:60}],
        ];
      }else if(prompt.includes('SKILLS_VIDEO_FLOW')){
        if(!catalog||!names.includes('skill')||!names.includes('video_validate'))throw Error('fixture_employee_skill_tools_missing');
        const resumed=prompt.includes('视频后台跟进返回：');
        actions=resumed?[
          ['skill',{name:'video-production'}],
          ['video_status',{output_dir:'video-fixture'}],
          ['video_download',{output_dir:'video-fixture',filename:'result.mp4'}],
          ['write',{file_path:'report.md',content:'OFFLINE_VIDEO_DELIVERED\n已下载离线测试视频，素材来自本地 FFmpeg。\n'}],
          ['task_command',{command:"test -s video-fixture/result.mp4 && ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json video-fixture/result.mp4"}],
        ]:[
          ['skill',{name:'video-production'}],
          ['video_validate',{config:{prompt:'Offline blue test shot',duration:4}}],
          ['video_submit',{config:{prompt:'Offline blue test shot',duration:4},output_dir:'video-fixture'}],
          ['video_wait',{output_dir:'video-fixture',timeout_seconds:60,poll_seconds:1}],
        ];
      }
      [tool,args]=actions[prior]??[];
      const expand=value=>{
        if(typeof value==='string'&&value.startsWith('$RESOURCE/')){
          const base=[...texts(current).matchAll(/Base directory for this skill: ([^\n<]+)/g)].at(-1)?.[1];
          if(!base)throw Error('fixture_skill_resource_base_missing');return join(base,value.slice(10));
        }
        if(Array.isArray(value))return value.map(expand);
        if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,expand(item)]));return value;
      };
      const output=tool?[{type:'function_call',id:'fc_'+randomUUID(),call_id:'call_'+randomUUID(),name:tool,arguments:JSON.stringify(expand(args)),status:'completed'}]:[{type:'message',id:'msg_'+randomUUID(),role:'assistant',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'skills fixture completed; catalog='+catalog+'; toolResults='+prior,annotations:[]}]}];
      yield* responseToolChunks({streamItems:async()=>({output})},options,config.allowedTools);
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['opennova-chatgpt'],new Mock()));
}
