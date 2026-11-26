/** Resolve model-proposed citations against durable project reads, never against a live file or model prose. */
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {basename,resolve} from 'node:path';
import {verifyPdfQuotes} from '../desktop/pdf-evidence.mjs';
import {MAX_NATIVE_FILE_BYTES,MAX_RANGED_PDF_SOURCE_BYTES} from '../desktop/file-types.mjs';

const supportedKinds=new Set(['fact','inference','decision','open_question']);
const fields=(v,allowed)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>allowed.includes(k));
const clean=(s,max)=>typeof s==='string'&&s.isWellFormed()&&s.length<=max&&s.trim()&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(s);
const hash=b=>createHash('sha256').update(b).digest('hex');
const extensions=new Map([['application/pdf','.pdf'],['application/vnd.openxmlformats-officedocument.wordprocessingml.document','.docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.xlsx']]);
export function normalizeEvidenceClaims(claims){
  if(!Array.isArray(claims)||!claims.length||claims.length>32)throw Error('invalid_evidence_claims');
  let total=0;
  return claims.map(item=>{
    if(!fields(item,['claim','kind','citations'])||!supportedKinds.has(item.kind)||!clean(item.claim,2000)||
       !Array.isArray(item.citations)||(total+=item.citations.length)>32)throw Error('invalid_evidence_claims');
    return {claim:item.claim.trim(),kind:item.kind,citations:item.citations.map(ref=>{
      if(!ref||!clean(ref.quote,1200))throw Error('invalid_evidence_citation');
      const quote=ref.quote.trim();
      if(fields(ref,['observationId','quote'])&&clean(ref.observationId,180))return {observationId:ref.observationId,quote};
      if(fields(ref,['readId','page','quote'])&&clean(ref.readId,180)&&Number.isSafeInteger(ref.page)&&ref.page>0)return {readId:ref.readId,page:ref.page,quote};
      if(fields(ref,['readId','locator','quote'])&&clean(ref.readId,180)){
        const loc=ref.locator;
        if(fields(loc,['paragraph'])&&Number.isSafeInteger(loc.paragraph)&&loc.paragraph>=1)return {readId:ref.readId,locator:{paragraph:loc.paragraph},quote};
        if(fields(loc,['sheet','cell'])&&clean(loc.sheet,31)&&typeof loc.cell==='string'&&/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(loc.cell))return {readId:ref.readId,locator:{sheet:loc.sheet,cell:loc.cell},quote};
      }
      throw Error('invalid_evidence_citation');
    })};
  });
}

// Open the journal's snapshot with a size bound even if the cached file has since been replaced.
async function snapshot(source,signal,home,maxBytes){
  const name=source.sha256+extensions.get(source.mime);
  if(!home||!/^[a-f0-9]{64}$/.test(source.sha256)||typeof source.snapshotPath!=='string'||basename(source.snapshotPath)!==name||resolve(source.snapshotPath)!==resolve(home,'file-inputs',name))return;
  let handle;
  try{
    handle=await open(source.snapshotPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size!==source.size||stat.size<=0||stat.size>maxBytes)return;
    const bytes=Buffer.alloc(stat.size);let offset=0;
    while(offset<bytes.length){signal?.throwIfAborted();const n=(await handle.read(bytes,offset,bytes.length-offset,offset)).bytesRead;if(!n)return;offset+=n;}
    if(hash(bytes)===source.sha256)return bytes;
  }catch(error){signal?.throwIfAborted();if(!['ENOENT','ENOTDIR','ELOOP','EPERM','EACCES'].includes(error.code))throw error;}
  finally{await handle?.close();}
}

function observationCitation(ops,projectId,ref){
  let row;try{row=ops.get(ref.observationId);}catch(error){if(error.message!=='unknown_id')throw error;}
  if(row?.kind!=='research_observation'||row.status!=='completed'||row.projectId!==projectId)throw Error('unknown_evidence_observation');
  const excerpt=row.excerpt??'',entry={observationId:row.id,sourceId:row.sourceId,sha256:hash(excerpt),url:row.finalUrl,fileName:row.title||row.finalUrl,
    retrievedAt:row.retrievedAt,evidenceType:row.evidenceType,readStatus:row.truncated?'partial':'read',verified:false};
  if(!['page_body','page_response'].includes(row.evidenceType))return {...entry,reason:'web_body_not_observed'};
  const start=excerpt.indexOf(ref.quote);
  return start<0?{...entry,reason:'web_quote_not_found'}:{...entry,verified:true,quote:excerpt.slice(start,start+ref.quote.length),offset:start};
}

export async function resolveClaimEvidence({claims,ops,projectId,signal,home}){
  signal?.throwIfAborted();
  if(!projectId)throw Error('unknown_evidence_read');
  const groups=new Map(),reads=new Map(),result=normalizeEvidenceClaims(claims).map(item=>({...item,citations:item.citations.map(ref=>{
    if(ref.observationId)return observationCitation(ops,projectId,ref);
    let row=reads.get(ref.readId);
    if(!row){
      try{row=ops.get(ref.readId);}catch(error){if(error.message!=='unknown_id')throw error;}
      if(!row||row.kind!=='tool'||row.operation!=='document_read'||row.status!=='completed'||!['partial','read'].includes(row.readStatus)||
        row.projectId!==projectId||row.source?.projectId!==projectId||row.source.contentOrigin!=='disk_saved_snapshot')throw Error('unknown_evidence_read');
      reads.set(ref.readId,row);
    }
    const source=row.source,scope=row.readScope??{mode:'whole_file'};
    const entry={readId:ref.readId,sourceId:source.sourceId,fileName:source.name,sha256:source.sha256,version:source.version,
      readStatus:row.readStatus,readScope:scope,verified:false};
    const ext=extensions.get(source.mime);
    if(ext==='.pdf'&&ref.page){entry.page=ref.page;
      if(scope.mode!=='whole_file'&&!(scope.mode==='pdf_pages'&&ref.page>=scope.startPage&&ref.page<=scope.endPage))return {...entry,reason:'page_outside_read_scope'};
    }else if(ext==='.docx'&&ref.locator?.paragraph||ext==='.xlsx'&&ref.locator?.sheet){entry.locator=ref.locator;}
    else return {...entry,reason:'unsupported_evidence_locator'};
    const key=source.sha256+ext;
    if(!groups.has(key))groups.set(key,{source,items:[],entries:[]});
    const group=groups.get(key);group.items.push(ref.page?{page:ref.page,quote:ref.quote}:{locator:ref.locator,quote:ref.quote});group.entries.push(entry);
    return entry;
  })}));
  if(groups.size>8)throw Error('too_many_evidence_versions');
  for(const {source,items,entries} of groups.values()){
    signal?.throwIfAborted();
    const pdf=source.mime==='application/pdf';
    const rangedSource=pdf&&entries.every(entry=>entry.readScope.mode==='pdf_pages');
    const maxBytes=rangedSource?MAX_RANGED_PDF_SOURCE_BYTES:MAX_NATIVE_FILE_BYTES;
    const bytes=await snapshot(source,signal,home,maxBytes);
    if(!bytes){for(const entry of entries)entry.reason='evidence_snapshot_unavailable';continue;}
    const hits=pdf?await verifyPdfQuotes({bytes,items,signal,rangedSource}):
      await (await import('../desktop/office-evidence.mjs')).verifyOfficeQuotes({bytes,mime:source.mime,items,signal});signal?.throwIfAborted();
    for(const [i,entry] of entries.entries()){
      const hit=hits[i];
      if(hit?.verified&&(!pdf||hit.page===entry.page)&&hit.quote){entry.verified=true;entry.quote=hit.quote;}
      else entry.reason=hit?.reason??'quote_not_verified';
    }
  }
  signal?.throwIfAborted();return result;
}
