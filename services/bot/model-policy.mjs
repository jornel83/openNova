import {readFileSync} from 'node:fs';
import {sanitizeOptions} from './policy.mjs';
export function filterRequest(options,config) {
  // A1's host projects retirements against the bound project, including replay
  // metadata. Applying the old Bot-wide list here would mask unrelated projects.
  if(config.projectMemory)return options;
  let retired=[];
  try{retired=JSON.parse(readFileSync(config.retiredMemoryPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  return sanitizeOptions(options,retired);
}
