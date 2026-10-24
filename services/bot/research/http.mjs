import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {canonicalUrl} from './sources.mjs';
import {assessContent} from '../../agent/web-content-quality.mjs';

export function normalizeHttpRequest(args){
 if(!args||typeof args!=='object'||!canonicalUrl(args.url))throw Error('invalid_research_url');
 if(Object.keys(args).some(k=>!['url','headers','encoding','responseType'].includes(k)))throw Error('invalid_http_argument');
 const headers={};
 if(args.headers!==undefined&&(!args.headers||typeof args.headers!=='object'||Array.isArray(args.headers)))throw Error('invalid_public_header');
 for(const [name,value] of Object.entries(args.headers??{})){
  const key=name.toLowerCase();
  if(!['accept','accept-language','referer','user-agent'].includes(key)||typeof value!=='string'||value.length>2048||/[\r\n]/.test(value)||key in headers)throw Error('invalid_public_header');
  if(key==='referer'&&!canonicalUrl(value))throw Error('invalid_public_header');
  headers[key]=value;
 }
 if(args.encoding!==undefined&&(typeof args.encoding!=='string'||args.encoding.length>40))throw Error('invalid_encoding');
 if(args.encoding!==undefined)new TextDecoder(args.encoding);
 const responseType=args.responseType??'auto';if(!['auto','text','json'].includes(responseType))throw Error('invalid_response_type');
 return {url:canonicalUrl(args.url),headers:Object.fromEntries(Object.entries(headers).sort()),...(args.encoding?{encoding:new TextDecoder(args.encoding).encoding}:{}),responseType};
}

/** Only this host-side function turns an observed response into an HTTP receipt. */
export function createResearchHttp({transport,sources,ops,artifactRoot}){
 return async function executeResearchHttp(args,{requestId,callId,parentCallId,signal,origin='tool',valid=()=>true}){
  const request=normalizeHttpRequest(args);signal?.throwIfAborted();
  const result=await transport.fetchWithOptions({url:request.url},{headers:request.headers,encoding:request.encoding,allowScriptText:true},signal);
  signal?.throwIfAborted();if(!valid())throw Error('cancelled');
  const content=result.body?.content??'',quality=assessContent(result);
  let error=quality.state==='usable'?undefined:quality.reason??quality.state;
  if(!error&&request.responseType==='json'){try{JSON.parse(content);}catch{error='invalid_json';}}
  const receiptId=randomUUID(),directory=join(artifactRoot,requestId);
  mkdirSync(directory,{recursive:true,mode:0o700});
  const artifactPath=join(directory,receiptId+'.txt'),artifactHash=createHash('sha256').update(content).digest('hex');
  writeFileSync(artifactPath,content,{encoding:'utf8',mode:0o600,flag:'wx'});
  const receipt={receiptId,requestId,callId,parentCallId,origin,request,requestedUrl:request.url,url:result.url,statusCode:result.statusCode,
   contentType:result.contentType,encoding:result.encoding,replacementCount:result.replacementCount??0,retrievedAt:new Date().toISOString(),quality,
   truncated:!!result.truncated,excerptTruncated:content.length>11000,excerpt:content.slice(0,11000),artifactPath,artifactHash,ok:!error,...error?{error}:{}};
  if(!error){
   const source=sources.record({...receipt,status:'completed',provider:'opennova-http',evidenceType:'api_response'});
   receipt.observationId=source?.observationId;receipt.sourceId=source?.sourceId;
  }
  ops.put({...receipt,id:receiptId,kind:'research_http',status:error?'failed':'completed'});
  return receipt;
 };
}
