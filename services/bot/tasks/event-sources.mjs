/** Bounded observations; sources never execute instructions or write to GitHub. */
import {readFileSync,lstatSync,realpathSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {inside} from './workspace.mjs';
export const eventHash=value=>createHash('sha256').update(value).digest('hex');
const excluded=new Set(['.git','node_modules','output','dist','build','coverage','.cache']);
export function watchedPaths(paths){
  if(!Array.isArray(paths)||!paths.length||paths.length>10||paths.some(p=>typeof p!=='string'||p.length>500||!p||p.startsWith('/')||p.includes('\\')||p.includes('\0')||p.toLowerCase().split('/').some(s=>!s||s==='..'||s==='.'||excluded.has(s)||s.startsWith('.env')||s.endsWith('.local.json'))))throw Error('invalid_event_paths');
  return [...new Set(paths)].sort();
}
export function fileObservation(root,paths){
  root=realpathSync(root);paths=watchedPaths(paths);
  const files=paths.map(path=>{
    const absolute=resolve(root,path);let parent=dirname(absolute);
    while(!existsSync(parent))parent=dirname(parent);
    if(!inside(root,realpathSync(parent)))throw Error('event_path_outside_workspace');
    let stat;try{stat=lstatSync(absolute);}catch(e){if(e.code==='ENOENT')return {path,exists:false};throw e;}
    if(!stat.isFile()||!inside(root,realpathSync(absolute)))throw Error('event_path_outside_workspace');
    if(stat.size>65536)throw Error('event_file_too_large');
    const bytes=readFileSync(absolute);if(bytes.length>65536)throw Error('event_file_too_large');
    const binary=bytes.includes(0),text=binary?undefined:bytes.toString('utf8').slice(0,2000);
    return {path,exists:true,size:bytes.length,digest:eventHash(bytes),binary,text,truncated:!binary&&bytes.toString('utf8').length>2000};
  });
  return {digest:eventHash(JSON.stringify(files.map(({text,truncated,...f})=>f))),files};
}
export function githubSource(value){
  if(typeof value?.repository!=='string'||!/^[-\w.]+\/[-\w.]+$/.test(value.repository)||value.repository.split('/').some(s=>s==='.'||s==='..')||!Number.isSafeInteger(value.number)||value.number<1)throw Error('invalid_github_source');
  if(!Array.isArray(value.authors)||!value.authors.length||value.authors.length>20||value.authors.some(a=>typeof a!=='string'||!/^[-\w]+(?:\[bot\])?$/.test(a)))throw Error('invalid_github_authors');
  return {repository:value.repository.toLowerCase(),number:value.number,authors:[...new Set(value.authors.map(a=>a.toLowerCase()))].sort(),prefix:'/opennova'};
}
/** Query a fixed GitHub endpoint; redirects cannot forward the optional token. */
export async function githubComments(source,{since,tokenPath,workspace,fetcher=fetch,signal}){
  let token;
  if(tokenPath&&existsSync(tokenPath)){
    const path=realpathSync(tokenPath);if(inside(realpathSync(workspace),path))throw Error('github_token_must_be_external');
    const stat=lstatSync(path);if(!stat.isFile()||stat.size>8192)throw Error('invalid_github_token');
    token=readFileSync(path,'utf8').trim();if(!token||token.length>8192||/[\r\n]/.test(token))throw Error('invalid_github_token');
  }
  const headers={Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'OpenNova',...(token?{Authorization:'Bearer '+token}:{})};
  const found=[];
  for(let page=1;page<=5;page++){
    const url=new URL(`https://api.github.com/repos/${source.repository}/issues/${source.number}/comments`);
    url.searchParams.set('since',new Date(since).toISOString());url.searchParams.set('per_page','100');url.searchParams.set('page',String(page));
    const response=await fetcher(url,{headers,redirect:'error',signal});
    if(!response.ok){
      const error=Error(response.status===403||response.status===429?'github_rate_limited':response.status===401?'github_auth_required':'github_poll_failed');
      const retry=response.headers.get('retry-after'),reset=Number(response.headers.get('x-ratelimit-reset'))*1000-Date.now();
      const after=Number.isFinite(Number(retry))?Number(retry)*1000:Date.parse(retry)-Date.now();
      error.retryAfterMs=Math.max(0,Number.isFinite(after)?after:0,Number.isFinite(reset)?reset:0);
      throw error;
    }
    const chunks=[];let bytes=0;for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>1024*1024)throw Error('github_response_too_large');chunks.push(Buffer.from(chunk));}
    let comments;try{comments=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('github_invalid_response');}
    if(!Array.isArray(comments)||comments.length>100)throw Error('github_invalid_response');
    for(const comment of comments){
      const createdAt=Date.parse(comment.created_at),author=comment.user?.login?.toLowerCase();
      if(!Number.isSafeInteger(comment.id)||!Number.isFinite(createdAt)||typeof author!=='string'||typeof comment.body!=='string')throw Error('github_invalid_response');
      if(createdAt<since||!source.authors.includes(author)||!/^\/opennova(?:\s|$)/.test(comment.body))continue;
      found.push({id:comment.id,createdAt,author,text:comment.body.slice(0,4000),truncated:comment.body.length>4000,url:`https://github.com/${source.repository}/issues/${source.number}#issuecomment-${comment.id}`});
    }
    if(!response.headers.get('link')?.includes('rel="next"'))return found;
  }
  throw Error('github_backlog_too_large');
}
