import {fileURLToPath} from 'node:url';
export function researchPlugins({harnessRoot,enabled}) {
 if(!enabled)return [];
 return [
  {id:'web',name:'@deepseek-ai/dsh-web',config:{searchProvider:'deepseek-official',fetchProvider:'opennova-http'}},
  {id:'web-search-deepseek',name:'@deepseek-ai/dsh-web-search-deepseek',config:{model:'deepseek-flash',maxTokens:2048,maxUses:1}},
  {id:'opennova-web-fetch-content',name:fileURLToPath(new URL('../../agent/web-fetch-content.mjs',import.meta.url)),config:{harnessRoot}},
  {id:'tool-web',name:'@deepseek-ai/dsh-tool-web',config:{search:true,fetch:true,searchMaxResults:5,searchMaxQueries:1,searchTimeoutMs:15000,fetchTimeoutMs:10000,fetchMaxOutputChars:12000}},
 ];
}
