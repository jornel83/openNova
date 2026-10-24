import {createHash,randomUUID} from 'node:crypto';
import {mapWebLinks} from '../../agent/web-links.mjs';
const clip=(v,n)=>typeof v==='string'?v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').slice(0,n):'';
export function canonicalUrl(raw){
 try{if(typeof raw!=='string'||raw.length>8192)return;const u=new URL(raw);
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return;
  if(['localhost','127.0.0.1','[::1]'].includes(u.hostname))return;
  u.hash='';return u.href;
 }catch{return;}
}
export function createSources({ops,botId,workspace}){
 const scope=r=>r.botId===botId&&r.workspace===workspace;
 const list=kind=>ops.list(kind).filter(scope);
 const observations=()=>list('research_observation').sort((a,b)=>a.sequence-b.sequence);
 const view=o=>({id:o.sourceId,sourceId:o.sourceId,observationId:o.id,url:o.finalUrl,title:o.title,requestId:o.requestId,callId:o.callId,
  provider:o.provider,evidenceType:o.evidenceType,retrieval:o.evidenceType==='page_body'?'fetch':'search',excerpt:o.excerpt,truncated:o.truncated,
  retrievedAt:o.retrievedAt,...o.publishedAt?{publishedAt:o.publishedAt}:{},...o.publishedAtRaw?{publishedAtRaw:o.publishedAtRaw}:{},...o.eventDate?{eventDate:o.eventDate}:{}});
 function forRequest(id){
  const usage=new Set(list('research_usage').filter(r=>r.requestId===id).map(r=>r.observationId));
  return observations().filter(o=>o.requestId===id||usage.has(o.id)).map(view);
 }
 const resolve=ids=>{
  if(!Array.isArray(ids)||ids.length>10||ids.some(id=>typeof id!=='string'))throw Error('invalid_source_lookup');
  const rows=observations().filter(o=>ids.includes(o.sourceId)).map(view);
  if(ids.some(id=>!rows.some(r=>r.id===id)))throw Error('source_not_found');return rows.slice(-10);
 };
 function lookup({requestId,sourceIds}={}){
  if(requestId!==undefined&&sourceIds!==undefined||requestId!==undefined&&typeof requestId!=='string')throw Error('invalid_source_lookup');
  if(sourceIds!==undefined)return resolve(sourceIds);
  if(requestId!==undefined){const rows=forRequest(requestId);if(!rows.length)throw Error('source_not_found');return rows.slice(0,10);}
  const completed=ops.list('request').filter(r=>r.status==='completed').sort((a,b)=>(b.completedAt??b.createdAt)-(a.completedAt??a.createdAt));
  for(const r of completed){const rows=forRequest(r.id);if(rows.length)return rows.slice(0,10);}
  return [];
 }
 return {
  record(o){
   if(o.status!=='completed')return null;
   const url=canonicalUrl(o.finalUrl??o.url);if(!url)return null;
   const sourceId='src-'+createHash('sha256').update(JSON.stringify([botId,workspace,url])).digest('hex').slice(0,24);
   const previous=list('research_source').find(s=>s.id===sourceId);
   const title=clip(o.title||previous?.title||new URL(url).hostname,200);
   ops.put({id:sourceId,kind:'research_source',botId,workspace,canonicalUrl:url,title});
   const rawDate=clip(o.publishedAt,100),publishedAt=/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(rawDate)&&Number.isFinite(Date.parse(rawDate))?rawDate:undefined;
   const record={id:randomUUID(),kind:'research_observation',botId,workspace,sourceId,requestId:o.requestId,callId:o.callId,
    provider:o.provider,query:clip(o.query,512),requestedUrl:canonicalUrl(o.requestedUrl??o.url)??url,finalUrl:url,title,
    retrievedAt:o.retrievedAt??new Date().toISOString(),publishedAt,publishedAtRaw:rawDate||undefined,eventDate:clip(o.eventDate,100)||undefined,
    evidenceType:o.evidenceType==='page_body'?'page_body':'search_summary',excerpt:clip(o.excerpt,12000),truncated:!!o.truncated||(o.excerpt?.length??0)>12000,
    status:'completed',sequence:observations().length+1};
   ops.put(record);return {...view(record),sourceId};
  },
  forRequest,resolve,lookup,
  resolveUrls(urls){const wanted=new Set(urls.map(canonicalUrl).filter(Boolean));return observations().filter(o=>wanted.has(o.finalUrl)).map(view);},
  use(requestId,rows){for(const row of rows){const found=observations().find(o=>o.id===row.observationId);if(!found)throw Error('source_not_found');ops.put({id:`use-${requestId}-${found.id}`,kind:'research_usage',botId,workspace,requestId,observationId:found.id});}},
  forReply(requestId,text){
   // A URL identifies a source, not which observation supports a statement.
   // Keep its actual observations instead of promoting a summary to a newer body.
   const known=forRequest(requestId),selected=new Map();
   const accept=url=>{for(const s of known)if(s.url===canonicalUrl(url))selected.set(s.observationId,s);return url;};
   mapWebLinks(text,{bare:accept,markdown:(label,url)=>{accept(url);return label;}});
   return [...selected.values()];
  },
 };
}
