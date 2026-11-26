/** Durable state for a document review. Publishing the frozen candidate is handled by the normal generator. */
import {createHash} from 'node:crypto';
import {lstatSync,mkdirSync,realpathSync,writeFileSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {editableBaseSpec} from './revision-patch.mjs';
import {buildDocumentProposal,documentProposalRecord,proposalFingerprint,proposalReceipt} from './proposals.mjs';
import {assertLatestEdition,assertRevisionBaseUnchanged,documentRevisionTarget,savedDocumentSpec} from './revisions.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const baseErrors=new Set(['document_revision_source_changed','document_revision_source_missing','document_revision_not_latest']);
export const isDocumentBaseConflict=error=>baseErrors.has(error.message);

function transaction(ops,run){
  if(ops.db.isTransaction)return run();
  ops.db.exec('BEGIN IMMEDIATE');
  try{const value=run();ops.db.exec('COMMIT');return value;}
  catch(error){ops.db.exec('ROLLBACK');throw error;}
}

function setProposalState(ops,row,update){
  return transaction(ops,()=>{
    const origin=ops.get(row.operationId);
    if(origin.operation!=='document_generate'||origin.projectId!==row.projectId||origin.requestId!==row.requestId)throw Error('document_proposal_invalid');
    const next=ops.put({...row,...update,applyingOperationId:undefined});
    ops.put({...origin,...proposalReceipt(next)});
    return next;
  });
}

export function startDecision(ops,projectId,id,action,operationId){
  return transaction(ops,()=>{
    const row=documentProposalRecord({ops,projectId,id});
    if(row.applyingOperationId&&row.applyingOperationId!==operationId)throw Error('document_proposal_busy');
    if(action==='undo'){
      if(row.status==='undone')return row;
      if(row.status!=='applied')throw Error('document_proposal_not_applied');
      return ops.put({...row,applyingOperationId:operationId});
    }
    if(row.status==='undone')throw Error('document_proposal_closed');
    if(action==='discard'){
      if(row.status==='applied')throw Error('document_proposal_closed');
      return row.status==='discarded'?row:setProposalState(ops,row,{status:'discarded',decisionOperationId:operationId});
    }
    if(row.status==='discarded')throw Error('document_proposal_closed');
    return row.status==='pending'||row.status==='conflict'&&!row.conflict?.replacementId&&row.conflict?.rebaseError!=='document_rebase_already_matches'
      ?ops.put({...row,applyingOperationId:operationId}):row;
  });
}

export function releaseDecision(ops,row){
  const proposal=documentProposalRecord({ops,id:row.proposalId,projectId:row.projectId});
  if(proposal.applyingOperationId===row.id)ops.put({...proposal,applyingOperationId:undefined});
}

function compactArtifact(artifact){
  const {id,path,format,revision,sha256,parentPath,parentArtifactId,parentSha256,restoredFromArtifactId,restoredFromSha256,restoredFromRevision,undoneProposalId}=artifact;
  return {id,path,format,revision,sha256,parentPath,parentArtifactId,parentSha256,
    ...(undoneProposalId?{restoredFromArtifactId,restoredFromSha256,restoredFromRevision,undoneProposalId}:{})};
}

export function markDecisionPublished(ops,row,artifact,action,operationId){
  if(action==='undo'){
    if(row.status==='undone'&&row.undoArtifact?.id===artifact.id)return row;
    if(row.status!=='applied'||row.artifact?.id!==artifact.parentArtifactId||row.id!==artifact.undoneProposalId)throw Error('document_proposal_changed');
    return setProposalState(ops,row,{status:'undone',undoArtifact:compactArtifact(artifact),undoOperationId:operationId});
  }
  if(row.status==='applied'&&row.artifact?.id===artifact.id)return row;
  if(row.status!=='pending')throw Error('document_proposal_changed');
  return setProposalState(ops,row,{status:'applied',decisionOperationId:operationId,artifact:compactArtifact(artifact)});
}

export function decisionReceipt(ops,row){
  const proposal=proposalReceipt(row).proposal;
  if(row.status==='undone')return {status:'completed',phase:'undone',proposal,artifact:row.undoArtifact,output:'已撤销这次修改，按应用前的内容另存了恢复版。'};
  if(row.status==='applied')return {status:'completed',phase:'committed',proposal,artifact:row.artifact,output:'已确认应用，原版本保留在原路径。'};
  if(row.status==='discarded')return {status:'completed',phase:'discarded',proposal,output:'已放弃这份修改方案。'};
  const replacement=row.conflict?.replacementId?documentProposalRecord({ops,id:row.conflict.replacementId,projectId:row.projectId}):null;
  return {status:'completed',phase:'conflict',proposal,...(replacement?{replacementProposal:proposalReceipt(replacement).proposal}:{}),
    output:replacement?'原文件已经改变；已按当前原件生成新的修改对照，需重新确认。':row.conflict?.rebaseError==='document_rebase_already_matches'?'原文件已包含方案中的全部修改，无需生成新版。':'暂时无法在原文件上重新核对，已保留原件和方案。'};
}

function effectiveBase(ops,row){
  const recorded=ops.get(row.baseArtifactId);
  if(recorded.kind!=='document_artifact'||recorded.projectId!==row.projectId||recorded.path!==row.basePath||
      recorded.format!==row.format||(recorded.revision??1)!==row.baseRevision||(recorded.rootArtifactId??recorded.id)!==row.rootArtifactId)
    throw Error('document_proposal_invalid');
  if(row.supersedesId)return {...recorded,version:row.baseVersion,size:row.baseVersion.size,sha256:row.baseSha256,snapshotPath:row.manualSnapshotPath};
  if(recorded.sha256!==row.baseSha256||(recorded.editableSpecSha256??recorded.specSha256)!==row.baseSpecSha256)throw Error('document_proposal_invalid');
  return recorded;
}

export function candidateBase(ops,row,printable,home,readFile){
  if(row.fingerprint&&proposalFingerprint(row)!==row.fingerprint)throw Error('document_proposal_invalid');
  const editable=JSON.stringify(row.spec),renderable=row.claims?JSON.stringify(printable(row.spec,row.claims)):editable;
  if(hash(editable)!==row.editableSpecSha256||hash(renderable)!==row.specSha256)throw Error('document_proposal_invalid');
  const base=effectiveBase(ops,row);
  originalSpec(home,base,row,printable);
  if(row.supersedesId){
    const snapshot=join(realpathSync(home),'document-proposal-bases',row.baseSha256+'.'+base.format);
    if(row.manualSnapshotPath!==snapshot||realpathSync(snapshot)!==snapshot||hash(readFile(snapshot).bytes)!==row.baseSha256)
      throw Error('document_proposal_invalid');
  }
  return base;
}

function originalSpec(home,base,row,printable){
  if(row.supersedesId){
    if(!row.manualBaseSpec||hash(JSON.stringify(row.manualBaseSpec))!==row.baseSpecSha256)throw Error('document_proposal_invalid');
    return row.manualBaseSpec;
  }
  return editableBaseSpec({base,spec:savedDocumentSpec(home,base)},printable);
}

// Restore the bytes and recipe of the actual approved base. A user's rebased
// Word/PDF can differ from the generated edition that first occupied its path.
export function prepareDocumentUndo({ops,home,row,readFile,printable}){
  const applied=ops.get(row.artifact.id),prior=effectiveBase(ops,row);
  if(applied.kind!=='document_artifact'||applied.projectId!==row.projectId||applied.proposalId!==row.id||
      applied.sha256!==row.artifact.sha256||applied.rootArtifactId!==row.rootArtifactId||applied.format!==row.format||
      applied.parentArtifactId!==prior.id||applied.parentSha256!==row.baseSha256||applied.revision!==row.baseRevision+1||
      applied.specSha256!==row.specSha256||applied.editableSpecSha256!==row.editableSpecSha256||
      row.fingerprint&&proposalFingerprint(row)!==row.fingerprint)throw Error('document_proposal_invalid');
  assertRevisionBaseUnchanged({ops,base:applied});
  const root=realpathSync(home);
  let saved,spec;
  try{
    let expected;
    if(row.supersedesId){
      expected=join(root,'document-proposal-bases',prior.sha256+'.'+prior.format);
      if(applied.parentSnapshotPath!==expected)throw Error('invalid_manual_snapshot');
    }else{
      const key=basename(dirname(prior.snapshotPath));
      if(!/^[a-f0-9]{64}$/.test(key)||prior.id!=='document-artifact-'+key.slice(0,40))throw Error('invalid_snapshot');
      expected=join(root,'document-generations',key,'artifact.'+prior.format);
    }
    if(realpathSync(prior.snapshotPath)!==expected||realpathSync(dirname(prior.snapshotPath))!==dirname(expected)||
        basename(prior.snapshotPath)!==basename(expected))throw Error('invalid_snapshot');
    saved=readFile(prior.snapshotPath);
    if(saved.bytes.length!==prior.size||hash(saved.bytes)!==prior.sha256)throw Error('invalid_snapshot');
    spec=originalSpec(home,prior,row,printable);
  }catch{throw Error('document_undo_snapshot_unavailable');}
  const {lineage,targetPath}=documentRevisionTarget(ops,applied);
  return {bytes:saved.bytes,spec,sources:prior.sources??row.sources,claims:prior.claims,format:prior.format,base:applied,targetPath,
    lineage:{...lineage,parentPath:applied.path,restoredFromArtifactId:prior.id,restoredFromRevision:row.baseRevision,restoredFromSha256:prior.sha256,undoneProposalId:row.id}};
}

function snapshotManual(home,format,bytes,readFile){
  const root=join(realpathSync(home),'document-proposal-bases');
  mkdirSync(root,{recursive:true,mode:0o700});
  if(realpathSync(root)!==root)throw Error('document_rebase_unavailable');
  const dest=join(root,hash(bytes)+'.'+format);
  try{writeFileSync(dest,bytes,{flag:'wx',mode:0o600});}
  catch(error){if(error.code!=='EEXIST')throw error;}
  if(realpathSync(dest)!==dest||!lstatSync(dest).isFile()||hash(readFile(dest).bytes)!==hash(bytes))throw Error('document_rebase_unavailable');
  return dest;
}

export async function recordBaseConflict({ops,home,row,error,decision,check,readFile,printable,signal}){
  const conflict={reason:error.message};
  let replacement,operation;
  try{
    const base=candidateBase(ops,row,printable,home,readFile);
    const latest=error.message==='document_revision_not_latest'?ops.get(error.details.latestArtifactId):ops.get(base.id);
    if(latest.projectId!==base.projectId||(latest.rootArtifactId??latest.id)!==row.rootArtifactId)throw Error('document_rebase_unavailable');
    assertLatestEdition(ops,latest);
    if(realpathSync(dirname(latest.path))!==dirname(latest.path))throw Error('document_rebase_unavailable');
    if(latest.id!==base.id&&(JSON.stringify(latest.claims)!==JSON.stringify(base.claims)||JSON.stringify(latest.sources)!==JSON.stringify(base.sources)))
      throw Error('document_rebase_unavailable');
    const current=readFile(latest.path);
    const currentSha=hash(current.bytes);
    const latestPath=snapshotManual(home,latest.format,current.bytes,readFile);
    const root=realpathSync(home),key=basename(dirname(base.snapshotPath));
    const originalPath=row.supersedesId?join(root,'document-proposal-bases',row.baseSha256+'.'+base.format):join(root,'document-generations',key,'artifact.'+base.format);
    if(!row.supersedesId&&(!/^[a-f0-9]{64}$/.test(key)||base.id!=='document-artifact-'+key.slice(0,40))||
        originalPath!==base.snapshotPath||realpathSync(originalPath)!==originalPath||hash(readFile(originalPath).bytes)!==row.baseSha256)throw Error('document_rebase_unavailable');
    const baseSpec=originalSpec(home,base,row,printable);
    const {rebaseDocumentCandidate}=await import('./rebase.mjs');
    const merged=currentSha===base.sha256?{baseSpec,spec:row.spec}:await rebaseDocumentCandidate({baseSpec,basePrintableSpec:base.claims?printable(baseSpec,base.claims):baseSpec,candidateSpec:row.spec,format:row.format,originalPath:base.snapshotPath,latestPath,signal});
    const nextBase={...latest,version:current.version,size:current.bytes.length,sha256:currentSha};
    const revision={...documentRevisionTarget(ops,nextBase),base:nextBase};
    const operationId='document-recompare-'+hash(row.id+'\0'+latest.id+'\0'+currentSha+'\0'+JSON.stringify(current.version)).slice(0,40);
    operation={id:operationId,kind:'tool',tool:'document_generate',operation:'document_generate',action:'revise',description:'重新核对文档修改',
      projectId:row.projectId,requestId:decision.requestId,createdAt:Date.now(),finishedAt:Date.now()};
    check();assertRevisionBaseUnchanged({ops,base:nextBase});
    const next=buildDocumentProposal({operation,revision,base:merged.baseSpec,spec:merged.spec,claims:row.claims,sources:row.sources,
      patch:{},printable});
    Object.assign(next,{supersedesId:row.id,manualBaseSpec:merged.baseSpec,manualSnapshotPath:latestPath,baseSpecSha256:hash(JSON.stringify(merged.baseSpec))});
    next.fingerprint=proposalFingerprint(next);
    replacement=next;
  }catch(failure){
    check();
    if(failure.message==='document_proposal_invalid')throw failure;
    conflict.rebaseError=failure.message==='document_revision_no_changes'?'document_rebase_already_matches':'document_rebase_unavailable';
    if(/^[a-z_]{1,100}$/.test(failure.details?.reason??''))conflict.detail=failure.details.reason;
  }
  // Persist the two review cards and the link as one change. A failed journal
  // write cannot leave a link to a candidate that does not exist.
  const result=transaction(ops,()=>{
    if(replacement){
      ops.put(replacement);ops.put({...operation,...proposalReceipt(replacement)});
      conflict.replacementId=replacement.id;
    }
    return setProposalState(ops,row,{status:'conflict',conflict,decisionOperationId:decision.id});
  });
  return decisionReceipt(ops,result);
}
