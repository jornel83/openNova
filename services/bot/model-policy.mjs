import {readFileSync} from 'node:fs';
import {sanitizeOptions} from './policy.mjs';
export function filterRequest(options,config) {
  let retired=[];
  try{retired=JSON.parse(readFileSync(config.retiredMemoryPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  return sanitizeOptions(options,retired);
}
