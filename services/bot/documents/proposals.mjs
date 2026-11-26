/** Frozen revision candidates. Only the bounded comparison is copied into tool history. */
import {createHash} from 'node:crypto';
import {GENERATOR_VERSION,MAX_SPEC_BYTES} from './spec.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const equal=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
export const documentProposalId=operationId=>'document-proposal-'+hash(operationId).slice(0,40);

// A rebased or older proposal may have no applicable edit indices. Match equal
// items first, then pair replacements in the gaps. Document specs cap the lists.
function compareAligned(before,after,compare){
  const a=before.map(x=>JSON.stringify(x)),b=after.map(x=>JSON.stringify(x));
  const lengths=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
  for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)
    lengths[i][j]=a[i]===b[j]?lengths[i+1][j+1]+1:Math.max(lengths[i+1][j],lengths[i][j+1]);
  let startA=0,startB=0,i=0,j=0;
  function gap(endA,endB){
    const count=Math.max(endA-startA,endB-startB);
    for(let n=0;n<count;n++){
      const ai=startA+n<endA?startA+n:null,bi=startB+n<endB?startB+n:null;
      compare(ai===null?null:before[ai],bi===null?null:after[bi],ai===null?null:ai+1,bi===null?null:bi+1);
    }
  }
  while(i<a.length&&j<b.length){
    if(a[i]===b[j]){gap(i,j);startA=++i;startB=++j;}
    else if(lengths[i+1][j]>=lengths[i][j+1])i++;
    else j++;
  }
  gap(a.length,b.length);
}

// Patch indices refer to the sequence after the preceding edit. Track origins so
// inserting a paragraph does not make every subsequent paragraph look replaced.
function compareSequence(before,after,edits,compare){
  if(equal(before,after))return;
  if(!edits)return compareAligned(before,after,compare);
  const origins=before.map((_,index)=>index);
  for(const {op,index} of edits??[]){
    if(op==='insert')origins.splice(index-1,0,null);
    if(op==='remove')origins.splice(index-1,1);
  }
  // An agent can remove and reinsert the very same block. Unchanged ends of
  // each gap disappear, even when some other part of the document changed.
  let oldIndex=0,newIndex=0;
  function gap(oldEnd,newEnd){
    let oldLimit=oldEnd,newLimit=newEnd;
    while(oldIndex<oldLimit&&newIndex<newLimit&&equal(before[oldIndex],after[newIndex])){oldIndex++;newIndex++;}
    while(oldIndex<oldLimit&&newIndex<newLimit&&equal(before[oldLimit-1],after[newLimit-1])){oldLimit--;newLimit--;}
    for(let i=oldIndex;i<oldLimit;i++)compare(before[i],null,i+1,null);
    for(let i=newIndex;i<newLimit;i++)compare(null,after[i],null,i+1);
  }
  origins.forEach((origin,index)=>{
    if(origin===null)return;
    gap(origin,index);
    if(!equal(before[origin],after[index]))compare(before[origin],after[index],origin+1,index+1);
    oldIndex=origin+1;newIndex=index+1;
  });
  gap(before.length,after.length);
}

function compareTable(before,after,block,add){
  const label='表格（正文块 '+block+'）';
  const table=(kind,name,left,right)=>add(kind,label+' · '+name,left,right,{block});
  table('columns','表头',before.columns,after.columns);
  // A replacement may contain thousands of rows. Show a changed rectangular
  // range as one complete value if its dimensions change or it is a bulk rewrite.
  const sameWidth=before.columns.length===after.columns.length;
  let changes=0;
  if(sameWidth&&before.rows.length===after.rows.length){
    for(let r=0;r<after.rows.length&&changes<=128;r++)
      for(let c=0;c<after.columns.length;c++)if(before.rows[r][c]!==after.rows[r][c])changes++;
  }else changes=Infinity;
  const cell=(summary,row,column,left,right)=>{
    if(left===right)return;
    const columnName=after.columns[column-1],where=summary?(after.summary.includes('合计')?'汇总行（合计）':'汇总行'):'第 '+row+' 行';
    add(summary?'summaryCell':'cell',label+' · '+where+' · '+columnName+'（第 '+column+' 列）',left,right,
      {block,...(summary?{}:{row}),column,columnName});
  };
  if(changes>128)table('rows','数据行',before.rows,after.rows);
  else if(changes)after.rows.forEach((values,r)=>values.forEach((value,c)=>cell(false,r+1,c+1,before.rows[r][c],value)));
  if(sameWidth&&before.summary&&after.summary)
    after.summary.forEach((value,c)=>cell(true,null,c+1,before.summary[c],value));
  else table('summary','汇总行',before.summary??null,after.summary??null);
}

function claimViews(spec,receipts){
  return (spec.claims??[]).map((claim,i)=>({
    kind:claim.kind,claim:claim.claim,
    citations:(receipts?.[i]?.citations??[]).map((evidence,j)=>evidence.verified||claim.citations.length!==receipts[i].citations.length
      ?evidence:{...evidence,requestedCitation:claim.citations[j]}),
  }));
}

function compareDocument(base,spec,oldClaims,claims,patch){
  const changes=[];
  const add=(kind,label,before,after,location={})=>{
    if(!equal(before,after))changes.push({kind,label,...location,before,after});
  };
  add('title','文档标题',base.title,spec.title);
  add('subtitle','副标题',base.subtitle??null,spec.subtitle??null);
  for(const [key,label] of Object.entries({pageSize:'纸张尺寸',fontPreset:'字体',header:'页眉',footer:'页码'}))
    add('layout',label,base.layout[key],spec.layout[key],{field:key});
  compareSequence(base.blocks,spec.blocks,patch.edits,(before,after,baseBlock,afterBlock)=>{
    const block=afterBlock??baseBlock,label='正文块 '+block,at={block,baseBlock,afterBlock};
    if(before?.type==='table'&&after?.type==='table')return compareTable(before,after,block,(kind,name,a,b,loc)=>add(kind,name,a,b,{...at,...loc}));
    if(before&&after&&before.type===after.type){
      for(const [key,name] of Object.entries({text:'文字',level:'标题级别',ordered:'有序列表',items:'列表项'}))
        if(Object.hasOwn(before,key))add('block',label+' · '+name,before[key],after[key],{...at,field:key});
    }else add('block',label+(before&&after?' · 替换':before?' · 删除':' · 新增'),before,after,at);
  });
  compareSequence(claimViews(base,oldClaims),claimViews(spec,claims),patch.claimEdits,(before,after,baseClaim,afterClaim)=>{
    const claim=afterClaim??baseClaim,label='关键结论 '+claim,at={claim,baseClaim,afterClaim};
    if(before&&after){
      add('claim',label+' · 内容',before.claim,after.claim,at);
      add('claim',label+' · 类型',before.kind,after.kind,at);
      add('citations',label+' · 出处与核验',before.citations,after.citations,at);
    }else add('claim',label+(before?' · 删除':' · 新增'),before,after,at);
  });
  return changes;
}

export function buildDocumentProposal({operation,revision,base,spec,claims,sources,patch,printable}){
  const artifact=revision.base,editable=JSON.stringify(spec),renderable=claims?JSON.stringify(printable(spec,claims)):editable;
  if(Buffer.byteLength(renderable)>MAX_SPEC_BYTES||Buffer.byteLength(editable)>MAX_SPEC_BYTES)throw Error('document_spec_too_large');
  const changes=compareDocument(base,spec,artifact.claims,claims,patch);
  if(!changes.length)throw Error('document_revision_no_changes');
  return {id:documentProposalId(operation.id),kind:'document_proposal',status:'pending',operationId:operation.id,
    projectId:operation.projectId,requestId:operation.requestId,createdAt:Date.now(),format:artifact.format,
    baseArtifactId:artifact.id,basePath:artifact.path,baseRevision:artifact.revision??1,baseSha256:artifact.sha256,baseVersion:artifact.version,
    rootArtifactId:revision.lineage.rootArtifactId,baseSpecSha256:artifact.editableSpecSha256??artifact.specSha256,
    spec,editableSpecSha256:hash(editable),specSha256:hash(renderable),sources,...(claims?{claims}:{}),generatorVersion:GENERATOR_VERSION,
    patch,changes};
}

// Exclude lifecycle fields so the fingerprint is stable through confirmation.
export function proposalFingerprint(row){
  const {id,projectId,format,baseArtifactId,basePath,baseRevision,baseSha256,baseSpecSha256,baseVersion,
    rootArtifactId,editableSpecSha256,specSha256,sources,claims,changes,patch,supersedesId}=row;
  return hash(JSON.stringify({id,projectId,format,baseArtifactId,basePath,baseRevision,baseSha256,baseSpecSha256,baseVersion,
    rootArtifactId,editableSpecSha256,specSha256,sources,claims,changes,patch,supersedesId}));
}

function view(row,changes,truncated){
  const {id,status,operationId,projectId,requestId,createdAt,format,baseArtifactId,basePath,baseRevision,baseSha256}=row;
  return {id,status,operationId,projectId,requestId,createdAt,format,baseArtifactId,basePath,baseRevision,baseSha256,...(row.artifact?{artifact:row.artifact}:{}),...(row.undoArtifact?{undoArtifact:row.undoArtifact}:{}),...(row.conflict?{conflict:row.conflict}:{}),...(row.supersedesId?{supersedesId:row.supersedesId}:{}),changeCount:row.changes.length,changes,truncated};
}
function previewChange(change){
  const result={...change};
  for(const key of ['label','columnName','before','after']){
    if(!Object.hasOwn(change,key))continue;
    const value=change[key],text=typeof value==='string'?value:JSON.stringify(value);
    if(text.length>360){
      result[key]=text.slice(0,360).replace(/[\uD800-\uDBFF]$/u,'')+'…';
      result.truncated=true;
    }
  }
  return result;
}

export function proposalReceipt(row){
  const changes=[];let size=0;
  for(const change of row.changes.slice(0,20)){
    const shown=previewChange(change),cost=Buffer.byteLength(JSON.stringify(shown));
    if(changes.length&&size+cost>8000)break;
    changes.push(shown);size+=cost;
  }
  return {status:'completed',phase:'proposed',proposal:view(row,changes,changes.length<row.changes.length||changes.some(c=>c.truncated)),
    output:({pending:'已保存修改对照，等待确认。',applied:'已确认修改并保存新版。',undone:'已撤销这次修改，恢复的内容已另存为新版。',discarded:'已放弃这份修改方案。',conflict:'基准文件已变化，原方案已保留。'})[row.status]};
}

export function documentProposalRecord({ops,projectId,id}){
  let row;
  if(projectId&&typeof id==='string'&&/^document-proposal-[a-f0-9]{40}$/.test(id)){
    try{row=ops.get(id);}catch(error){if(error.message!=='unknown_id')throw error;}
  }
  if(row?.kind!=='document_proposal'||row.projectId!==projectId)throw Error('document_proposal_not_found');
  return row;
}

export function readDocumentProposal(input){
  const row=documentProposalRecord(input);
  return view(row,row.changes,false);
}
