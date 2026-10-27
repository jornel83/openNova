import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export const RESEARCH_TOOLS=['web_search','web_fetch','web_request','research_exec','research_derive'];
export const RESEARCH_VERSION=3;
export const DEFAULT_LIMITS=Object.freeze({searchCalls:2,fetchCalls:6,execCalls:4,execMs:45000,searchMs:15000,fetchMs:10000,webMs:90000,softMs:60000});
const read=path=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
export function loadResearchConfig({env=process.env,configFile=env.OPENNOVA_CONFIG||fileURLToPath(new URL('../../../config/voice.local.json',import.meta.url)),secretsFile=env.OPENNOVA_SECRETS_FILE||fileURLToPath(new URL('../../../config/secrets.local.json',import.meta.url))}={}) {
 const base={version:RESEARCH_VERSION,mode:'native',enabled:false,available:false,httpAvailable:false,provider:'deepseek',childEnv:{}};
 try {
  const web=read(configFile).web??{};
  if(typeof web!=='object'||Array.isArray(web)||web.enabled!==undefined&&typeof web.enabled!=='boolean')throw Error();
  base.mode=env.OPENNOVA_RESEARCH_MODE||web.mode||'native';
  if(!['native','legacy'].includes(base.mode))throw Error();
  if(base.mode==='legacy')base.limits={...DEFAULT_LIMITS};
  base.enabled=web.enabled??false;
  if(!base.enabled)return {...base,reason:'disabled'};
  if(web.provider&&web.provider!=='deepseek')return {...base,reason:'research_provider_unsupported'};
  if(base.mode==='legacy'&&web.limits){
   if(typeof web.limits!=='object'||Array.isArray(web.limits))throw Error();
   for(const [key,value] of Object.entries(web.limits)){
    // Legacy model/request caps belong to the old Agent, never the Bot.
    if(['modelCalls','requestMs'].includes(key))continue;
    if(!(key in DEFAULT_LIMITS)||!Number.isInteger(value)||value<1||value>DEFAULT_LIMITS[key])throw Error();
    base.limits[key]=value;
   }
  }
  if(base.limits)base.limits.softMs=Math.min(base.limits.softMs,base.limits.webMs);
  base.httpAvailable=true;
  const key=env.DEEPSEEK_API_KEY||read(secretsFile).web?.deepseek_api_key||'';
  if(typeof key!=='string')throw Error();
  if(!key.trim())return {...base,reason:'deepseek_api_key_missing'};
  return {...base,available:true,childEnv:{DEEPSEEK_API_KEY:key.trim()}};
 }catch{return {...base,available:false,httpAvailable:false,reason:'invalid_research_configuration',childEnv:{}};}
}
export function publicResearchConfig({version=RESEARCH_VERSION,mode='native',enabled=false,available=false,httpAvailable=available,provider='deepseek',reason,limits=DEFAULT_LIMITS}={}){
 return {version,mode,enabled,available,httpAvailable,provider,...reason?{reason}:{},...(mode==='legacy'?{limits}:{policy:'dsh-native'})};
}
export function researchTools(base,config){return [...new Set([...base,'research_sources',...(config?.available?['web_search']:[]),...((config?.httpAvailable??config?.available)?config?.mode==='legacy'?RESEARCH_TOOLS.filter(n=>n!=='web_search'):['web_fetch']:[])])];}
