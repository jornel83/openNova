import {mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync,unlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
export function saveJson(path,value){
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const temp=path+'.'+randomUUID()+'.tmp';
  try{writeFileSync(temp,JSON.stringify(value),{mode:0o600});renameSync(temp,path);}
  catch(error){try{unlinkSync(temp);}catch{}throw error;}
}
export function readJson(path,fallback=null){try{return JSON.parse(readFileSync(path,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}}
export function readSteps(directory){
  let names;try{names=readdirSync(join(directory,'steps'));}catch(error){if(error.code==='ENOENT')return [];throw error;}
  return names.filter(n=>/^[\w-]+\.json$/.test(n)).map(n=>readJson(join(directory,'steps',n))).sort((a,b)=>a.createdAt-b.createdAt);
}
