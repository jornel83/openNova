import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
// Raw HTML and model text have separate limits. Preserve the native network and conversion safeguards.
const HTML_LIMIT=500000;
const TEXT_LIMIT=11000;
function withoutNavigation(text) {
 return text.split(/\n\s*\n/).filter(block=>{
  if(block.includes('|'))return true;
  // Scan each span once. Unclosed/nested links keep the block rather than retrying suffixes.
  let cursor=0,links=0;
  const rest=[];
  while(cursor<block.length) {
   const start=block.indexOf('[',cursor);
   if(start<0)break;
   const labelEnd=block.indexOf('](',start+1);
   if(labelEnd<0)return true;
   const label=block.slice(start+1,labelEnd);
   if(label.includes('[')||label.includes('\n'))return true;
   const end=block.indexOf(')',labelEnd+2);
   if(end<0||block.slice(labelEnd+2,end).includes('\n'))return true;
   rest.push(block.slice(cursor,start));
   links++;cursor=end+1;
  }
  if(links<6)return true;
  rest.push(block.slice(cursor));
  return rest.join('').replace(/[\s*#>·•—_-]/g,'').length>30;
 }).join('\n\n').trim();
}
export async function createContentFetcher(root) {
 const {HttpFetchProvider}=await import(pathToFileURL(join(root,'packages/web/web-fetch-http/lib/index.js')));
 const {formatFetchOutput,fetchMetaFromValue}=await import(pathToFileURL(join(root,'packages/web/tool-web/lib/index.js')));
 const transport=new HttpFetchProvider({maxResponseBytes:2000000,maxBodyChars:HTML_LIMIT,timeoutMs:10000,maxRedirects:5,userAgent:'OpenNova/0.1'});
 return {id:'opennova-http',available:()=>true,transport,async fetch(request,signal){
  signal?.throwIfAborted();
  const result=await this.transport.fetch(request,signal);
  signal?.throwIfAborted();
  if(result.statusCode<200||result.statusCode>=300)return result;
  // Native rendering guards depth, omits scripts, preserves tables and marks truncation.
  const cap=HTML_LIMIT+4096;
  const prefix=formatFetchOutput({...result,body:{kind:'text',content:''},truncated:false},cap);
  const rendered=formatFetchOutput(result,cap).slice(prefix.length);
  const truncated=fetchMetaFromValue(result,cap).truncated;
  const content=withoutNavigation(rendered.replace(/\n\n\(Content truncated\.[^\n]*\)$/,''));
  if(!content || content.includes('[HTML content omitted:') || (truncated&&content.length<120))throw Error('web_page_body_unavailable');
  signal?.throwIfAborted();
  return {...result,body:{kind:'text',content:content.slice(0,TEXT_LIMIT)},truncated:truncated||content.length>TEXT_LIMIT};
 }};
}
export const name='opennova-web-fetch-content';
export const inject=['web'];
export async function apply(ctx,config) {
 ctx.web.registerFetchProvider(await createContentFetcher(config.harnessRoot));
}
