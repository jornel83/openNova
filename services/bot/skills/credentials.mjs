/** Video credentials remain in the process environment or an external private file. */
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {relative,isAbsolute} from 'node:path';
export function videoCredential({root,path,env=process.env}){
  if(env.ARK_API_KEY?.trim())return env.ARK_API_KEY.trim();
  if(!path)return '';
  let actual;try{actual=realpathSync(path);}catch(error){if(error.code==='ENOENT')return '';throw Error('video_credentials_unavailable');}
  const rel=relative(realpathSync(root),actual);
  if(!rel||rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel))throw Error('video_credentials_must_be_external');
  const stat=statSync(actual);if(!stat.isFile()||stat.size>8192)throw Error('video_credentials_unavailable');
  return readFileSync(actual,'utf8').trim();
}
