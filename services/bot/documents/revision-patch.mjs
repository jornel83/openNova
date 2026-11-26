import {normalizeDocumentSpec,MAX_SPEC_BYTES} from './spec.mjs';
import {resolveClaimEvidence,normalizeEvidenceClaims} from './claim-evidence.mjs';

const object=v=>v&&Object.getPrototypeOf(v)===Object.prototype;
const fields=(v,names)=>object(v)&&Object.keys(v).every(k=>names.includes(k));
const fail=()=>{throw Error('invalid_document_patch');};
const own=(v,k)=>Object.hasOwn(v,k);
const integer=(v,max)=>Number.isSafeInteger(v)&&v>=1&&v<=max;
function applyEdits(list,edits,key,convert){
  if(!Array.isArray(edits)||!edits.length||edits.length>128)fail();
  for(const e of edits){
    if(!object(e)||!integer(e.index,list.length+(e.op==='insert'?1:0)))fail();
    const pos=e.index-1;
    if(key==='block'&&['setCell','setSummaryCell'].includes(e.op)){
      const b=list[pos],summary=e.op==='setSummaryCell';
      if(!fields(e,['op','index','column','value','expectedValue',...(summary?[]:['row'])])||b.type!=='table'||!integer(e.column,b.columns.length)||
        (summary?!b.summary:!integer(e.row,b.rows.length))||typeof e.value!=='string'||own(e,'expectedValue')&&typeof e.expectedValue!=='string')fail();
      const cells=summary?b.summary:b.rows[e.row-1];
      if(own(e,'expectedValue')&&cells[e.column-1]!==e.expectedValue)throw Error('document_revision_cell_value_mismatch');
      cells[e.column-1]=e.value;
    }else if(e.op==='remove'&&fields(e,['op','index']))list.splice(pos,1);
    else if(['insert','replace'].includes(e.op)&&fields(e,['op','index',key])&&own(e,key))list.splice(pos,e.op==='replace'?1:0,convert(e[key]));
    else fail();
  }
}
// Keep resolved claims in a separate lane. The model can propose a new claim,
// but cannot promote a proposal to an inherited (already verified) receipt.
export async function patchDocument({base,patch,oldClaims,ops,home,projectId,signal}){
  if(!fields(patch,['title','subtitle','layout','edits','claimEdits'])||!Object.keys(patch).length||Buffer.byteLength(JSON.stringify(patch))>MAX_SPEC_BYTES)fail();
  const next=structuredClone(base);
  if(own(patch,'title')){
    if(next.layout.header===[...base.title].slice(0,80).join(''))delete next.layout.header;
    next.title=patch.title;
  }
  if(own(patch,'subtitle')){if(patch.subtitle===null)delete next.subtitle;else next.subtitle=patch.subtitle;}
  if(own(patch,'layout')){if(!fields(patch.layout,['pageSize','fontPreset','header','footer']))fail();Object.assign(next.layout,patch.layout);}
  if(own(patch,'edits'))applyEdits(next.blocks,patch.edits,'block',structuredClone);
  const slots=(oldClaims??[]).map((resolved,i)=>({resolved,proposal:base.claims[i]}));
  if(own(patch,'claimEdits'))applyEdits(slots,patch.claimEdits,'claim',proposal=>({proposal}));
  if(slots.length)next.claims=slots.map(s=>s.proposal);else delete next.claims;
  const spec=normalizeDocumentSpec(next);
  const changed=slots.filter(s=>!s.resolved);
  if(changed.length){
    const receipts=await resolveClaimEvidence({claims:changed.map(s=>s.proposal),ops,home,projectId,signal});
    changed.forEach((slot,i)=>{slot.resolved=receipts[i];});
  }
  const claims=slots.length?slots.map(s=>s.resolved):undefined;
  if(JSON.stringify(spec)===JSON.stringify(base)&&JSON.stringify(claims)===JSON.stringify(oldClaims))throw Error('document_revision_no_changes');
  return {spec,claims};
}

export function editableBaseSpec({spec,base},printable){
  if(!base.claims?.length)return spec;
  if(base.editableSpecSnapshotPath){
    if(spec.claims?.length!==base.claims.length)throw Error('document_revision_spec_invalid');
    return spec;
  }
  // Older artifacts have only the printable spec. Strip the evidence appendix
  // only if it exactly matches an independently reconstructed host appendix.
  const appendix=printable({...spec,blocks:[]},base.claims).blocks;
  if(JSON.stringify(spec.blocks.slice(-appendix.length))!==JSON.stringify(appendix))throw Error('document_revision_spec_invalid');
  // Failed candidate quotations were intentionally discarded. Preserve their
  // stored negative receipts; do not fabricate candidates when migrating them.
  const claims=base.claims.map(c=>({kind:c.kind,claim:c.claim,citations:c.citations.filter(r=>r.verified).map(r=>
    r.observationId?{observationId:r.observationId,quote:r.quote}:r.page?{readId:r.readId,page:r.page,quote:r.quote}:{readId:r.readId,locator:r.locator,quote:r.quote})}));
  return normalizeDocumentSpec({...spec,blocks:spec.blocks.slice(0,-appendix.length),claims:normalizeEvidenceClaims(claims)});
}

export function inspectDocument(spec,artifact,{startBlock:start=1,blockLimit:limit=12,tableBlock,startRow,rowLimit}={}){
  const header={artifactId:artifact.id,path:artifact.path,format:artifact.format,revision:artifact.revision??1,sha256:artifact.sha256,title:spec.title};
  if(tableBlock!==undefined||startRow!==undefined||rowLimit!==undefined){
    const b=spec.blocks[tableBlock-1],first=startRow??1,count=rowLimit??10;
    if(!integer(tableBlock,spec.blocks.length)||b?.type!=='table'||!integer(first,b.rows.length)||!integer(count,20))throw Error('invalid_document_table_window');
    // Explicitly tag oversized cell previews. A shortened value cannot be
    // mistaken for a complete value in a compare-and-set edit.
    const shown=s=>s.length<=200?s:{preview:s.slice(0,200),length:s.length,truncated:true};
    const rows=[];let size=0;
    for(let n=first;n<=b.rows.length&&rows.length<count;n++){
      const row={row:n,cells:b.rows[n-1].map(shown)},cost=JSON.stringify(row).length;
      if(rows.length&&size+cost>8000)break;rows.push(row);size+=cost;
    }
    return {...header,table:{index:tableBlock,rowCount:b.rows.length,columns:b.columns.map(shown),rows,summary:b.summary?.map(shown),
      ...(first+rows.length<=b.rows.length?{nextRow:first+rows.length}:{})}};
  }
  if(!integer(start,Math.max(1,spec.blocks.length))||!integer(limit,24))throw Error('invalid_document_inspection');
  const blocks=spec.blocks.slice(start-1,start-1+limit).map((block,i)=>{
    // Large tables can be edited directly by row and column; do not send a
    // misleading partial block that an agent might replace as if it were whole.
    if(JSON.stringify(block).length>1400)return {index:start+i,type:block.type,preview:JSON.stringify(block).slice(0,900),truncated:true,
      ...(block.type==='table'?{rows:block.rows.length,columns:block.columns.map(s=>s.slice(0,70))}:{} )};
    return {index:start+i,block};
  });
  return {...header,
    subtitle:spec.subtitle,layout:spec.layout,blockCount:spec.blocks.length,blocks,...(start-1+blocks.length<spec.blocks.length?{nextBlock:start+blocks.length}:{}),
    claims:(artifact.claims??[]).map((c,i)=>({index:i+1,kind:c.kind,claim:c.claim.slice(0,500),citationCount:c.citations.length}))};
}
