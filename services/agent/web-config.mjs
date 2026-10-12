import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export const WEB_LIMITS=Object.freeze({searchCalls:2,fetchCalls:3,modelCalls:6,searchMs:15000,fetchMs:10000,webMs:45000,requestMs:90000});
const read=file=>existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
export function loadWebConfig({env=process.env,enabled,configFile=env.OPENNOVA_CONFIG||fileURLToPath(new URL('../../config/voice.local.json',import.meta.url)),secretsFile=env.OPENNOVA_SECRETS_FILE||fileURLToPath(new URL('../../config/secrets.local.json',import.meta.url))}={}) {
  let web,secret,limits,provider;
  try {
    web=read(configFile).web??{};
    if(!web || Array.isArray(web) || typeof web!=='object' || Object.keys(web).some(k=>!['enabled','provider','limits'].includes(k)))throw Error();
    if(web.enabled!==undefined&&typeof web.enabled!=='boolean')throw Error();
    provider=web.provider??'exa';
    if(!['exa','deepseek'].includes(provider))throw Error();
    limits={...WEB_LIMITS};
    if(web.limits!==undefined) {
      if(!web.limits||Array.isArray(web.limits)||typeof web.limits!=='object')throw Error();
      for(const [k,v] of Object.entries(web.limits)) {
        if(!(k in limits)||!Number.isInteger(v)||v<1||v>WEB_LIMITS[k])throw Error();limits[k]=v;
      }
    }
    enabled=enabled??web.enabled??false;
    // The disabled mode never needs to parse the secrets file.
    secret=enabled?(env[provider==='deepseek'?'DEEPSEEK_API_KEY':'EXA_API_KEY'] || read(secretsFile).web?.[`${provider}_api_key`] || ''):'';
    if(typeof secret!=='string')throw Error();
  }catch {throw Error('invalid_web_configuration');}
  if(enabled&&!secret.trim())throw Error(provider==='deepseek'?'deepseek_api_key_missing':'web_api_key_missing');
  return {enabled,provider,apiKey:secret.trim(),limits};
}
export function childEnvironment(env,web) {
  const result=Object.fromEntries(Object.entries(env).filter(([key])=>!/KEY|TOKEN|SECRET|PASSWORD/i.test(key)));
  if(web?.enabled) {
    result[web.provider==='deepseek'?'DEEPSEEK_API_KEY':'EXA_API_KEY']=web.apiKey;
    result.OPENNOVA_WEB_PROVIDER=web.provider==='deepseek'?'deepseek-official':'exa';
  }
  return result;
}
