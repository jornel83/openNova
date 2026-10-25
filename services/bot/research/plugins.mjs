import {DEFAULT_LIMITS} from './config.mjs';
import {fileURLToPath} from 'node:url';
export function researchPlugins({harnessRoot,enabled,searchAvailable=enabled,mode='native',limits=DEFAULT_LIMITS}) {
 if(!enabled)return [];
 if(mode==='native')return [
  {id:'web',name:'@deepseek-ai/dsh-web',config:{searchProvider:'deepseek-official',fetchProvider:'http'}},
  {id:'web-search-deepseek',name:'@deepseek-ai/dsh-web-search-deepseek',config:{}},
  {id:'web-fetch-http',name:'@deepseek-ai/dsh-web-fetch-http'},
  {id:'tool-web',name:'@deepseek-ai/dsh-tool-web',config:{search:searchAvailable,fetch:true,searchTimeoutMs:60000}},
 ];
 return [
  {id:'web',name:'@deepseek-ai/dsh-web',config:{searchProvider:'deepseek-official',fetchProvider:'opennova-http'}},
  {id:'web-search-deepseek',name:'@deepseek-ai/dsh-web-search-deepseek',config:{model:'deepseek-flash',maxTokens:2048,maxUses:1}},
  {id:'opennova-web-fetch-content',name:fileURLToPath(new URL('../../agent/web-fetch-content.mjs',import.meta.url)),config:{harnessRoot}},
  {id:'tool-web',name:'@deepseek-ai/dsh-tool-web',config:{search:searchAvailable,fetch:true,searchMaxResults:5,searchMaxQueries:2,searchTimeoutMs:limits.searchMs,fetchTimeoutMs:limits.fetchMs,fetchMaxOutputChars:12000}},
 ];
}
