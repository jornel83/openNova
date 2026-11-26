/** Foreground document generation with immutable input and no-clobber publication. */
import {createHash,randomUUID} from 'node:crypto';
import {constants,openSync,closeSync,readSync,fstatSync,statSync,lstatSync,realpathSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,linkSync,unlinkSync,rmSync,fsyncSync} from 'node:fs';
import {basename,dirname,extname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {normalizeDocumentSpec,MAX_SPEC_BYTES,GENERATOR_VERSION,DOCUMENT_SPEC_HELP,DOCUMENT_CLAIMS_HELP} from './spec.mjs';
import {runDocumentGenerator} from './runner.mjs';
import {resolveClaimEvidence} from './claim-evidence.mjs';
import {prepareDocumentRevision,assertRevisionBaseUnchanged,documentRevisionTarget} from './revisions.mjs';
import {buildDocumentProposal,documentProposalId,proposalReceipt,documentProposalRecord,proposalFingerprint} from './proposals.mjs';
import {candidateBase,startDecision,releaseDecision,decisionReceipt,markDecisionPublished,prepareDocumentUndo,recordBaseConflict,isDocumentBaseConflict} from './proposal-decisions.mjs';
import {editableBaseSpec,inspectDocument,patchDocument} from './revision-patch.mjs';

export const MAX_DOCUMENT_BYTES=64*1024*1024;
const hash=value=>createHash('sha256').update(value).digest('hex');
const version=s=>({size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs,ino:s.ino});
const same=(a,b)=>a&&b&&['size','mtimeMs','ctimeMs','ino'].every(key=>a[key]===b[key]);
const identity=c=>c?.kind==='file'?JSON.stringify({kind:'file',id:c.file?.id,path:c.file?.path,sourceId:c.file?.sourceId,size:c.file?.size,mtimeMs:c.file?.mtimeMs,ctimeMs:c.file?.ctimeMs,ino:c.file?.ino}):
  c?.kind==='browser'?JSON.stringify({kind:'browser',page:c.page,selection:c.selection}):'none';
const safeError=e=>['EACCES','EPERM','EROFS'].includes(e?.code)?'document_access_denied':e?.code==='ENOSPC'?'document_disk_full':e?.code==='EEXIST'?'document_target_exists':
  ['ENOENT','ENOTDIR'].includes(e?.code)?'document_path_not_found':/^[a-z][a-z0-9_]{2,100}$/.test(e?.message??'')?e.message:'document_generation_failed';
function localPath(raw,cwd){
  if(typeof raw!=='string'||!raw.trim()||raw.length>4096||raw.includes('\0')||/^[\w+.-]+:/.test(raw)||raw.startsWith('//'))throw Error('invalid_document_path');
  return resolve(cwd,raw.startsWith('~/')?join(homedir(),raw.slice(2)):raw);
}
function args(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('invalid_document_generate');
  const action=input.action??'create';
  if(action==='inspect'||action==='revise'){
    const allowed=action==='inspect'?['action','path','current','artifactId','startBlock','blockLimit','tableBlock','startRow','rowLimit']:['action','path','current','artifactId','patch'];
    if(Object.keys(input).some(k=>!allowed.includes(k))||['path','current','artifactId'].filter(k=>Object.hasOwn(input,k)).length!==1||
      Object.hasOwn(input,'current')&&input.current!==true||action==='revise'&&!input.patch)throw Error('invalid_document_revision');
    return input;
  }
  if(action!=='create'||Object.keys(input).some(k=>!['action','format','specPath','outputPath','expectedTarget'].includes(k)))throw Error('invalid_document_generate');
  if(!['docx','pdf'].includes(input.format))throw Error('unsupported_document_format');
  if(input.expectedTarget!==undefined&&input.expectedTarget!=='absent')throw Error('document_replace_not_supported');
  return {...input,action,expectedTarget:'absent'};
}
function bytesAt(path,limit){
  const fd=openSync(path,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
  try{
    const before=fstatSync(fd);if(!before.isFile())throw Error('document_file_required');if(!before.size||before.size>limit)throw Error('document_file_size_invalid');
    const buffer=Buffer.alloc(before.size+1);let offset=0;
    while(offset<buffer.length){const n=readSync(fd,buffer,offset,buffer.length-offset,null);if(!n)break;offset+=n;}
    if(offset!==before.size||!same(version(before),version(fstatSync(fd)))||!same(version(before),version(lstatSync(path))))throw Error('document_file_changed');
    return {bytes:buffer.subarray(0,offset),version:version(before)};
  }finally{closeSync(fd);}
}
export const readDocument=path=>bytesAt(path,MAX_DOCUMENT_BYTES);
function absent(path){try{lstatSync(path);}catch(e){if(e.code==='ENOENT')return;throw e;}throw Error('document_target_exists');}
function artifactFile(artifact){return {id:'file-'+hash(artifact.path),path:artifact.path,name:basename(artifact.path),extension:'.'+artifact.format,...artifact.version,
  projectId:artifact.projectId,artifactId:artifact.id,rootArtifactId:artifact.rootArtifactId,revision:artifact.revision,parentArtifactId:artifact.parentArtifactId,parentSha256:artifact.parentSha256,parentPath:artifact.parentPath,
  contentAccess:'native_file',generationStatus:'completed',diskStatus:'unchanged',invalid:false};}
function sourceEvidence(spec,ops,projectId){
  const files=ops.list('tool').filter(r=>r.operation==='document_read'&&r.status==='completed'&&r.source),web=ops.list('research_observation');
  return spec.sources.map(ref=>{
    const read=files.find(r=>r.source.sourceId===ref.sourceId&&r.projectId===projectId),observation=web.find(r=>r.id===ref.observationId&&r.sourceId===ref.sourceId&&r.projectId===projectId&&r.status==='completed');
    if(read){if(ref.sha256&&ref.sha256!==read.source.sha256||ref.observationId)throw Error('document_source_version_mismatch');
      return {...ref,sha256:read.source.sha256,version:read.source.version,sourceStatus:read.readStatus,identityVerified:true,locatorVerified:false};}
    if(observation){if(ref.sha256&&ref.sha256!==observation.artifactHash)throw Error('document_source_version_mismatch');
      return {...ref,...(observation.artifactHash?{sha256:observation.artifactHash}:{}),retrievedAt:observation.retrievedAt,identityVerified:true,locatorVerified:false};}
    throw Error('document_source_not_found');
  });
}
function cleanupStage(row){
  // Only our exact hidden staging sibling; do not trust an arbitrary journal path.
  if(row.stagePath&&row.targetPath&&dirname(row.stagePath)===dirname(row.targetPath)&&/^\.nova-document-[\w-]+$/.test(basename(row.stagePath)))
    try{if(!lstatSync(row.stagePath).isSymbolicLink())rmSync(row.stagePath,{recursive:true,force:true});}catch{}
}
// Only host-resolved claims reach the printable evidence section. Running the
// expanded blocks through the same validator also enforces final export limits.
export function printableResearchSpec(input,claims){
  const {claims:_proposals,...base}=input;
  const labels={fact:'资料事实',inference:'模型推断',decision:'用户决定',open_question:'待核实问题'};
  const blocks=[...base.blocks,{type:'heading',level:1,text:'关键结论与出处'}];
  if(claims.some(item=>item.citations.length))blocks.push({type:'paragraph',text:'“已核对原文”表示摘录与所列版本和位置相符；结论是否成立仍需结合上下文判断。'});
  for(const [i,entry] of claims.entries()){
    const supported=entry.citations.some(ref=>ref.verified);
    blocks.push({type:'heading',level:2,text:`${i+1}. ${labels[entry.kind]}${entry.kind==='fact'&&!supported?'（出处待核实）':''}`},{type:'paragraph',text:entry.claim});
    if(!entry.citations.length)blocks.push({type:'paragraph',text:'未附可核对的资料引文。'});
    for(const ref of entry.citations){
      const name=String(ref.fileName??ref.url??ref.observationId??'未记录来源名称').replace(/[\r\n\t]+/g,' ');
      const loc=ref.locator,pending=ref.verified?'':'请求核对：';
      const location=ref.page?`${pending}原文件物理页 ${ref.page}`:loc?.paragraph?`${pending}正文第 ${loc.paragraph} 段`:
        loc?.sheet&&loc.cell?`${pending}工作表「${loc.sheet}」· 单元格 ${loc.cell}`:null;
      const reason={page_outside_read_scope:'该页不在此前读取范围内。',unsupported_evidence_locator:'此格式尚不能核对此位置和原文。',pdf_no_text_layer:'该页没有可核对的文字层。',
        evidence_snapshot_unavailable:'原版本快照不可用。',pdf_quote_not_found:'未在指定页找到该摘录。'}[ref.reason]??'无法确认该位置的摘录。';
      blocks.push({type:'paragraph',text:[`来源：${name}`,ref.url&&ref.url!==name?ref.url:null,location,
          ref.observationId?`网页观察记录：${ref.observationId}`:null,ref.sha256?`${ref.observationId?'网页观察文本版本':'版本'} SHA-256：${ref.sha256}`:null,
          ref.readStatus==='partial'?'该次读取仅取得部分内容':null].filter(Boolean).join(' · ')},
        {type:'paragraph',text:ref.verified?`已核对原文：“${ref.quote}”`:'摘录待核实：'+reason});
    }
  }
  return normalizeDocumentSpec({...base,blocks});
}
export function createDocumentGenerator({home,ops,context,getRequest,runner=runDocumentGenerator,selectOutput=true}){
  const running=new Map(),snapshots=join(home,'document-generations');
  // Generic tool recovery may already have marked the row interrupted. A durable
  // commit candidate still lets us reconcile an atomic publication, never replay it.
  for(const row of ops.list('tool'))if(['document_generate','document_proposal_decide'].includes(row.operation)&&(['running','committing','interrupted'].includes(row.status)||row.operation==='document_proposal_decide'&&row.warning==='document_saved_bookkeeping_incomplete')){
    // Removing a staging hard link changes the target inode's ctime. Reconcile
    // only after that cleanup so the saved current-file version is stable.
    cleanupStage(row);
    let recovered=false;
    if(row.action==='revise'&&!row.commit){
      // A crash after the private candidate write can only recover its preview.
      let proposal;
      try{proposal=ops.get(documentProposalId(row.id));}catch(error){if(error.message!=='unknown_id')throw error;}
      if(proposal?.kind==='document_proposal'&&proposal.operationId===row.id&&proposal.projectId===row.projectId&&proposal.requestId===row.requestId){
        ops.put({...row,...proposalReceipt(proposal),recovered:true,error:undefined,finishedAt:Date.now()});recovered=true;
      }
    }
    if(row.commit?.artifact){try{
      const actual=bytesAt(row.commit.artifact.path,MAX_DOCUMENT_BYTES);
      const pub=row.commit.publication,stat=lstatSync(row.commit.artifact.path);
      if((pub?pub.dev===stat.dev&&pub.ino===stat.ino:!['revise','confirm','undo'].includes(row.action))&&hash(actual.bytes)===row.commit.artifact.sha256){
        const artifact={...row.commit.artifact,version:actual.version};
        ops.put({...artifact,kind:'document_artifact',createdAt:Date.now()});
        let review;
        if(row.operation==='document_proposal_decide'&&row.proposalId){
          const proposal=documentProposalRecord({ops,id:row.proposalId,projectId:row.projectId});
          review=decisionReceipt(ops,markDecisionPublished(ops,proposal,artifact,row.action,row.id));
          ops.put({...artifactFile(artifact),kind:'file',requestId:row.requestId,createdAt:Date.now()});
        }
        ops.put({...row,...row.commit.receipt,status:'completed',phase:'committed',...review,artifact,contextSelected:false,recovered:true,finishedAt:Date.now(),warning:undefined,error:undefined});recovered=true;
      }
    }catch{}}
    if(!recovered&&row.operation==='document_proposal_decide'&&row.proposalId){
      const proposal=documentProposalRecord({ops,id:row.proposalId,projectId:row.projectId});
      if(proposal.status!=='pending'&&(row.action==='undo'?proposal.undoOperationId===row.id:proposal.decisionOperationId===row.id&&proposal.status!=='undone')){
        ops.put({...row,...decisionReceipt(ops,proposal),recovered:true,finishedAt:Date.now(),error:undefined});recovered=true;
      }
    }
    if(row.proposalId)releaseDecision(ops,row);
    if(!recovered&&row.status!=='interrupted')ops.put({...row,status:'interrupted',error:'host_restarted_during_generation',finishedAt:Date.now()});
    cleanupStage(row);
  }
  function check(request,binding,signal,isCurrent){
    if(signal?.aborted||request.signal?.aborted||request.cancelled)throw Error('cancelled');
    if(!isCurrent()||request.binding!==binding||request.projectChanged||request.projectId!==binding.projectId)throw Error('project_request_mismatch');
  }
  function generate(input,options){return execute(input,options);}
  const deciding=new Map();
  function decide(input,options={}){
    if(!input||!['confirm','discard','undo'].includes(input.action)||typeof input.id!=='string'||Object.keys(input).some(k=>!['action','id'].includes(k)))return Promise.reject(Error('invalid_document_proposal'));
    const request=options.request??getRequest();
    // Validate scope before joining another caller's in-flight command.
    if(request?.binding?.focus!=='work'||request.projectId!==request.binding.projectId)return Promise.reject(Error('project_work_request_required'));
    let row;try{row=documentProposalRecord({ops,id:input.id,projectId:request.projectId});}catch(error){return Promise.reject(error);}
    if(request.id===row.requestId)return Promise.reject(Error('document_proposal_followup_required'));
    const active=deciding.get(row.id);
    if(active){
      if(active.action!==input.action)return Promise.reject(Error('document_proposal_busy'));
      return active.work.then(()=>execute(input,options,true));
    }
    const work=execute(input,options,true);
    deciding.set(row.id,{action:input.action,work});
    void work.finally(()=>deciding.delete(row.id)).catch(()=>{});
    return work;
  }
  function execute(input,{id=randomUUID(),signal,request=getRequest(),isCurrent=()=>getRequest()===request,edition}={},decision=false){
    if(typeof id!=='string'||!id||id.length>180)return Promise.reject(Error('invalid_command_id'));
    const binding=request?.binding;
    if(!request?.id||binding?.focus!=='work'||!binding.projectId||!binding.cwd)return Promise.reject(Error('project_work_request_required'));
    const operation=decision?'document_proposal_decide':'document_generate';
    // Only the host's fixed-edition exporter supplies this option. The ordinary
    // document tool takes a spec path and cannot assert a saved edition's identity.
    if(edition&&(decision||(input?.action??'create')!=='create'||edition.reference.projectId!==binding.projectId))return Promise.reject(Error('project_request_mismatch'));
    const inputKey=JSON.stringify({input,...(decision?{}:{requestId:request.id}),...(edition?{edition:edition.reference}:{}),projectId:binding.projectId,cwd:binding.cwd});
    const inputFingerprint=input?.action==='revise'?hash(inputKey):inputKey;
    let old;try{old=ops.get(id);}catch(e){if(e.message!=='unknown_id')return Promise.reject(e);}
    if(old){
      if(old.operation!==operation||(old.inputFingerprint!==inputFingerprint&&old.inputFingerprint!==inputKey))return Promise.reject(Error('command_id_conflict'));
      // An explicit retry can safely restart rendering before the journaled
      // publication intent. Never republish after an uncertain link outcome.
      if(!decision||old.status!=='interrupted'||old.commit)return running.get(id)??Promise.resolve(old);
    }
    const attempt=old?(old.attempt??0)+1:0;
    const generationKey=hash(attempt?id+'\0attempt-'+attempt:id);
    const description={revise:'文档修改对照',undo:'撤销已应用的文档修改',confirm:'确认应用文档修改',discard:'放弃文档修改'}[input?.action]??'生成文档';
    const record={id,operationId:id,kind:'tool',operation,tool:operation,...(decision?{proposalId:input.id}:{}),...(edition?{sourceEdition:edition.reference}:{}),description,requestId:request.id,projectId:binding.projectId,
      action:input?.action??'create',...(attempt?{attempt}:{}),inputFingerprint,status:'running',phase:'preparing',createdAt:Date.now(),generatorVersion:GENERATOR_VERSION};
    const contextBefore=identity(context.capture()),expectedContext=request.fileReaderContextIdentity??identity(binding.context);
    const finish=patch=>ops.put({...record,...patch,finishedAt:Date.now()});
    ops.put(record);
    // Yield before invoking the runner so every duplicate can join the registered promise.
    const promise=Promise.resolve().then(async()=>{
      let committed=false,completed,proposal,base;
      try{
        check(request,binding,signal,isCurrent);const normalized=decision?input:args(input);
        const signals=[signal,request.signal].filter(Boolean),effectiveSignal=signals.length>1?AbortSignal.any(signals):signals[0];
        let spec,sources,claims,origin,output,format,lineage,restore;
        if(decision)proposal=startDecision(ops,binding.projectId,normalized.id,normalized.action,id);
        if(decision&&normalized.action==='undo'){
          if(proposal.status==='undone')return finish(decisionReceipt(ops,proposal));
          restore=prepareDocumentUndo({ops,home,row:proposal,readFile:readDocument,printable:printableResearchSpec});
          ({spec,sources,claims,format,lineage,base,targetPath:output}=restore);
          origin={undoneProposalId:proposal.id,restoredFromArtifactId:lineage.restoredFromArtifactId,restoredFromSha256:lineage.restoredFromSha256};
        }else if(decision){
          if(normalized.action==='discard')return finish(decisionReceipt(ops,proposal));
          if(proposal.status==='conflict'&&!proposal.conflict?.replacementId&&proposal.conflict?.rebaseError!=='document_rebase_already_matches'){
            // Rechecking a conflicted review may only offer another comparison.
            // Even a file restored to its original bytes needs explicit approval again.
            assertRevisionBaseUnchanged({ops,base:candidateBase(ops,proposal,printableResearchSpec,home,readDocument)});
            throw Error('document_revision_source_changed');
          }
          if(proposal.status!=='pending')return finish(decisionReceipt(ops,proposal));
          base=candidateBase(ops,proposal,printableResearchSpec,home,readDocument);
          assertRevisionBaseUnchanged({ops,base});
          const revision=documentRevisionTarget(ops,base);
          ({spec,sources,claims,format}=proposal);output=revision.targetPath;
          lineage={...revision.lineage,parentPath:base.path,proposalId:proposal.id,...(proposal.supersedesId?{parentSnapshotPath:proposal.manualSnapshotPath}:{})};
          origin={proposalId:proposal.id,parentArtifactId:base.id};
        }else if(normalized.action==='create'){
          if(edition){
            spec=normalizeDocumentSpec(edition.spec);origin={sourceEdition:edition.reference};
          }else{
            const specPath=realpathSync(localPath(normalized.specPath,binding.cwd)),source=bytesAt(specPath,MAX_SPEC_BYTES);
            let decoded;try{decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(source.bytes));}catch{throw Error('invalid_document_spec_json');}
            spec=normalizeDocumentSpec(decoded);origin={path:specPath,sourceSha256:hash(source.bytes),version:source.version};
          }
          sources=sourceEvidence(spec,ops,binding.projectId);
          format=normalized.format;output=localPath(normalized.outputPath,binding.cwd);
          if(extname(output)!=='.'+format)throw Error('document_extension_mismatch');
          absent(output);
          claims=spec.claims?await resolveClaimEvidence({claims:spec.claims,ops,home,projectId:binding.projectId,signal:effectiveSignal}):undefined;
        }else{
          const current=binding.context?.kind==='file'?binding.context.file:null;
          if(normalized.current&&!current?.path)throw Error('current_file_required');
          const selector=normalized.current?(current.artifactId?{artifactId:current.artifactId}:{path:current.path}):normalized.artifactId?{artifactId:normalized.artifactId}:{path:normalized.path};
          const revision=prepareDocumentRevision({home,ops,projectId:binding.projectId,cwd:binding.cwd,...selector});
          const base=editableBaseSpec(revision,printableResearchSpec);
          if(normalized.action==='inspect')return finish({status:'completed',phase:'inspected',inspection:inspectDocument(base,revision.base,normalized),output:'已核对原件与保存版本，只读查看了可修改的内容；没有生成新文件。'});
          ({spec,claims}=await patchDocument({base,patch:normalized.patch,oldClaims:revision.base.claims,ops,home,projectId:binding.projectId,signal:effectiveSignal}));
          sources=revision.base.sources??ops.list('tool').find(r=>r.projectId===binding.projectId&&r.operation==='document_generate'&&r.status==='completed'&&r.artifact?.id===revision.base.id)?.sources??sourceEvidence(spec,ops,binding.projectId);
          const proposal=buildDocumentProposal({operation:record,revision,base,spec,claims,sources,patch:normalized.patch,printable:printableResearchSpec});
          // Evidence resolution may have yielded while a user edited the file
          // or another version was published. Pin the base again before saving.
          check(request,binding,signal,isCurrent);assertRevisionBaseUnchanged({ops,base:revision.base});
          proposal.fingerprint=proposalFingerprint(proposal);ops.put(proposal);
          return finish(proposalReceipt(proposal));
        }
        check(request,binding,signal,isCurrent);
        mkdirSync(dirname(output),{recursive:true});const parent=realpathSync(dirname(output)),parentStat=statSync(parent),targetPath=join(parent,basename(output));absent(targetPath);
        const specBytes=Buffer.from(JSON.stringify(claims?printableResearchSpec(spec,claims):spec)),specSha256=hash(specBytes);
        const editableBytes=Buffer.from(JSON.stringify(spec)),editableSpecSha256=hash(editableBytes);
        if(specBytes.length>MAX_SPEC_BYTES||editableBytes.length>MAX_SPEC_BYTES)throw Error('document_spec_too_large');
        if(decision&&!restore&&(specSha256!==proposal.specSha256||editableSpecSha256!==proposal.editableSpecSha256))throw Error('document_proposal_invalid');
        const snapshotDir=join(snapshots,generationKey);mkdirSync(snapshotDir,{recursive:true,mode:0o700});
        const snapshotPath=join(snapshotDir,'spec.json');writeFileSync(snapshotPath,specBytes,{flag:'wx',mode:0o600});
        const editableSpecSnapshotPath=join(snapshotDir,'editable-spec.json');writeFileSync(editableSpecSnapshotPath,editableBytes,{flag:'wx',mode:0o600});
        const stagePath=mkdtempSync(join(parent,'.nova-document-'));
        Object.assign(record,{format,spec:{...origin,sha256:specSha256,snapshotPath},sources,...(claims?{claims}:{}),targetPath,stagePath,
          fingerprint:hash(JSON.stringify({inputFingerprint,specSha256,generatorVersion:GENERATOR_VERSION})),phase:'generating'});ops.put(record);
        const stagedFile=join(stagePath,'result.'+format);
        check(request,binding,signal,isCurrent);
        const receipt=restore?{restoration:{status:'completed',sha256:lineage.restoredFromSha256},contentValidation:{status:'passed',method:'snapshot_sha256'},
          layoutValidation:{visual:{status:'not_checked'}}}:await runner({format,specPath:snapshotPath,outputPath:stagedFile,workdir:stagePath,signal:effectiveSignal});
        check(request,binding,signal,isCurrent);
        if(hash(readFileSync(snapshotPath))!==specSha256||hash(readFileSync(editableSpecSnapshotPath))!==editableSpecSha256)throw Error('document_spec_changed');
        if(!restore&&(receipt?.generation?.status!=='completed'||receipt?.contentValidation?.status!=='passed'||!receipt.layoutValidation||receipt.layoutValidation.visual?.status!=='not_checked'))throw Error('invalid_document_generator_receipt');
        const result=restore??bytesAt(stagedFile,MAX_DOCUMENT_BYTES);
        if(format==='pdf'?!result.bytes.subarray(0,8).toString('ascii').startsWith('%PDF-'):!result.bytes.subarray(0,4).equals(Buffer.from('504b0304','hex'))||!result.bytes.includes(Buffer.from('word/document.xml')))throw Error('invalid_document_output');
        const sha256=hash(result.bytes),snapshotArtifact=join(snapshotDir,'artifact.'+format);
        writeFileSync(snapshotArtifact,result.bytes,{flag:'wx',mode:0o600});
        const artifactId='document-artifact-'+generationKey.slice(0,40);
        const artifact={id:artifactId,path:targetPath,format,size:result.bytes.length,sha256,projectId:binding.projectId,
          revision:1,rootArtifactId:artifactId,...lineage,editableSpecSnapshotPath,editableSpecSha256,sources,...(edition?{sourceEdition:edition.reference}:{}),
          requestId:request.id,specSha256,specSnapshotPath:snapshotPath,snapshotPath:snapshotArtifact,...(claims?{claims}:{}),generatorVersion:receipt.generatorVersion??GENERATOR_VERSION,
          ...(receipt.implementationSha256?{implementationSha256:receipt.implementationSha256}:{})};
        // The intent is durable before publication. Publish a service-owned copy
        // of the checked bytes, never a path the runner could have replaced.
        const publication=join(stagePath,'publish-'+randomUUID()),fd=openSync(publication,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
        let publishedIdentity;
        try{writeFileSync(fd,result.bytes);fsyncSync(fd);const s=fstatSync(fd);publishedIdentity={dev:s.dev,ino:s.ino};}finally{closeSync(fd);}
        record.commit={artifact,receipt,publication:publishedIdentity};record.phase='committing';ops.put(record);
        const now=statSync(parent);if(realpathSync(parent)!==parent||now.dev!==parentStat.dev||now.ino!==parentStat.ino)throw Error('document_output_directory_changed');
        check(request,binding,signal,isCurrent);
        // No await or event callbacks between the final cancellation check and
        // atomic no-clobber link. The staging sibling is on the same filesystem.
        if(decision){
          const current=documentProposalRecord({ops,projectId:binding.projectId,id:proposal.id});
          if(current.status!==(restore?'applied':'pending')||current.applyingOperationId!==id||proposalFingerprint(current)!==proposalFingerprint(proposal))throw Error('document_proposal_changed');
          if(restore){
            if(current.artifact?.id!==base.id||current.artifact.sha256!==base.sha256)throw Error('document_proposal_changed');
          }else candidateBase(ops,current,printableResearchSpec,home,readDocument);
          assertRevisionBaseUnchanged({ops,base});
        }
        linkSync(publication,targetPath);committed=true;unlinkSync(publication);
        artifact.version=version(statSync(targetPath));
        const canSelect=()=>selectOutput&&!signal?.aborted&&!request.signal?.aborted&&!request.cancelled&&!request.projectChanged&&isCurrent()&&request.binding===binding&&
          (!decision||binding.context?.kind==='none'||binding.context?.kind==='file'&&binding.context.file.path===base.path)&&
          contextBefore===expectedContext&&identity(context.capture())===contextBefore;
        completed={...receipt,status:'completed',phase:'committed',artifact,contextSelected:false,
          ...(signal?.aborted||request.signal?.aborted||request.cancelled?{cancelledAfterCommit:true}:{}),output:'已保存最终文件；内容基础核验通过，实际渲染/视觉状态见 layoutValidation。'};
        // The durable completion marker must come last: if killed between these
        // writes, recovery can still reconcile the pending commit and its artifact.
        ops.put({...artifact,kind:'document_artifact',createdAt:Date.now()});
        if(decision){
          proposal=markDecisionPublished(ops,proposal,artifact,record.action,id);
          completed={...completed,...decisionReceipt(ops,proposal),artifact};
        }
        finish(completed);
        const file=artifactFile(artifact);ops.put({...file,kind:'file',requestId:request.id,createdAt:Date.now()});
        request.objectReads??=new Map();request.objectReads.set(targetPath,artifact.version);
        // Journaling publishes synchronous events; a user's new selection or a
        // cancellation from one of those events must win before activation.
        if(canSelect()){context.selectFile(file);request.fileReaderContextIdentity=identity({kind:'file',file});completed.contextSelected=true;}
        if(signal?.aborted||request.signal?.aborted||request.cancelled)completed.cancelledAfterCommit=true;
        return finish(completed);
      }catch(error){
        if(committed){
          // Publication already succeeded. A transient journal failure must not
          // leave the source card actionable or cause another render on retry.
          const artifact=completed?.artifact??record.commit.artifact;
          if(decision)try{
            cleanupStage(record);
            const actual=bytesAt(artifact.path,MAX_DOCUMENT_BYTES),stat=lstatSync(artifact.path),pub=record.commit.publication;
            if(stat.ino!==pub.ino||stat.dev!==pub.dev||hash(actual.bytes)!==artifact.sha256)throw Error('document_file_changed');
            artifact.version=actual.version;
            ops.put({...artifact,kind:'document_artifact',createdAt:Date.now()});
            const applied=markDecisionPublished(ops,documentProposalRecord({ops,id:record.proposalId,projectId:record.projectId}),artifact,record.action,id);
            ops.put({...artifactFile(artifact),kind:'file',requestId:request.id,createdAt:Date.now()});
            return finish({...record.commit.receipt,...decisionReceipt(ops,applied),artifact,contextSelected:false});
          }catch{/* Startup reconciles the original published inode and frozen bytes. */}
          return finish({...record.commit.receipt,...completed,status:'completed',phase:record.action==='undo'?'undone':'committed',artifact,contextSelected:false,warning:'document_saved_bookkeeping_incomplete'});
        }
        if(record.action==='confirm'&&proposal&&['pending','conflict'].includes(proposal.status)&&isDocumentBaseConflict(error)){
          try{
            const result=await recordBaseConflict({ops,home,row:proposal,error,decision:record,signal,
              check:()=>check(request,binding,signal,isCurrent),readFile:readDocument,printable:printableResearchSpec});
            return finish(result);
          }catch(failure){error=failure;}
        }
        const cancelled=signal?.aborted||request.signal?.aborted||request.cancelled||error.message==='cancelled';
        return finish({status:cancelled?'cancelled':'failed',error:cancelled?'cancelled':safeError(error),
          ...(error.details?{errorDetails:error.details}:{}),phase:'not_committed'});
      }finally{cleanupStage(record);if(decision&&proposal&&!committed)releaseDecision(ops,record);}
    });
    running.set(id,promise);void promise.finally(()=>running.delete(id)).catch(()=>{});return promise;
  }
  return {generate,decide};
}

export const DOCUMENT_GENERATION_INSTRUCTIONS='新建 Word/DOCX 或 PDF：用 write 准备 JSON spec，再 document_generate。继续修改 Nova 自己生成的 Word/PDF：用同一个 document_generate，必要时先 action=inspect 查看底稿索引，再 action=revise 对指定版本作局部修改。已关联当前文件用 current=true；同轮刚生成或查看的成果用回执 artifactId。一次只选 artifactId、path、current 之一。revise 只保存等待确认的修改对照。用 proposal.changes 的实际位置和修改前后值向用户说明；truncated=true 表示界面可查看完整对照。不得为修订调用 create 或用 write、bash、edit 另存或覆盖文件。发现用户外部修改、原件缺失或版本不是最新，说明实际原因及未保存，不要自行重建、改绑版本或改其他文件。inspect 只读；phase=proposed 时告知尚未生成新版，不给新版下载链接。后续用户明确确认应用、放弃待确认方案或撤销已经应用的修改时使用 document_proposal_decide。撤销对应 undo；沿用宿主绑定的修改编号，依据回执给出恢复版路径。现版本有手改、缺失或已有后续版本时停止，说明具体文件及原因，禁止用 write、bash 手工还原或复制另存。多份方案时先确定目标。不得在同一轮自行确认刚提出的修改或因原件变化而新出的对照。对照与原件冲突时说明保留情况与新方案编号。只有 completed 且有 artifact 的生成回执才可报告文件已保存。visual=not_checked 不能称逐页验过。内部 spec、临时文件不激活为用户当前成果，无需为验证生成成功再次 document_read 全文。用户要在后台研究文件时，用 background_agent_start 提交文件研究任务，设置 documentResearch=true，并传入 inputFiles 或 currentFile。明确指定的项目交付路径填写 documentOutputPath。';
export function createDocumentGenerateTool({generator,getRequest}){
  return ['document_generate','新建 Word/PDF 或预览 Nova 生成文档的修改。create：从 JSON spec 新建；inspect：检查已有成果、列出可修改正文块与结论；revise：核对保存版本，返回等待确认的修改前后值，原件如已外改则停止。不会生成新版。以下 specPath 说明只适用于 create。'+DOCUMENT_SPEC_HELP+DOCUMENT_CLAIMS_HELP,{
    action:{type:'string',enum:['create','inspect','revise'],description:'默认 create 新建；inspect 只读查看保存的底稿，revise 生成待确认的修改对照。'},
    format:{type:'string',enum:['docx','pdf'],description:'仅 create 必填。'},specPath:{type:'string',description:'仅 create 必填，本轮内容 JSON 的本机路径。'},
    outputPath:{type:'string',description:'仅 create 必填，实际成品路径，以 .docx 或 .pdf 结尾。修改对照不接受输出路径。'},
    expectedTarget:{type:'string',enum:['absent'],description:'仅支持 absent（默认），已存在文件返回冲突。'},
    artifactId:{type:'string',description:'inspect/revise 选择已有成果：项目内历史生成回执的 artifact.id，配合 patch 修改。'},
    path:{type:'string',description:'inspect/revise 按实际成品路径选取项目内已有成果。'},
    current:{type:'boolean',description:'inspect/revise 引用本轮发送时的当前文件，传 true；artifactId/path/current 只选一个。'},
    startBlock:{type:'integer',description:'inspect 从第几块开始（1 起）。'},blockLimit:{type:'integer',description:'inspect 返回块数，默认12，最多24。'},
    tableBlock:{type:'integer',description:'inspect 表格时传表格正文块号，返回表头、总行数、实际行号、指定行内容和汇总行。'},
    startRow:{type:'integer',description:'配 tableBlock，表格从第几行数据开始（不含表头，默认1），可用 nextRow 接续。'},
    rowLimit:{type:'integer',description:'配 tableBlock，最多返回几行数据，默认10，上限20。'},
    patch:{type:'object',additionalProperties:false,description:'仅 revise 必填。只传本次改动；未改内容及来源沿用原版。',properties:{
      title:{type:'string'},subtitle:{oneOf:[{type:'string'},{type:'null'}],description:'设为 null 可移除副标题。'},layout:{type:'object',additionalProperties:true,description:'可局部设置 pageSize/fontPreset/header/footer。'},
      edits:{type:'array',description:'按序处理：replace/insert 需要完整 block；insert 在 index 前插，length+1 为末尾。remove 删除；表内用 setCell(row,column) 改正文值，用 setSummaryCell(column) 改已有汇总值。读旧表时 inspect 用 tableBlock/startRow；expectedValue 可核对原值。index,row,column 从 1 开始。',items:{type:'object',additionalProperties:false,properties:{
        op:{type:'string',enum:['replace','insert','remove','setCell','setSummaryCell']},index:{type:'integer'},block:{type:'object',additionalProperties:true,description:'同 spec.blocks 中的一个 heading/paragraph/list/table。'},row:{type:'integer'},column:{type:'integer'},value:{type:'string'},expectedValue:{type:'string',description:'仅单元格修改，原值必须精确相同，否则整次修订停止。'}}}},
      claimEdits:{type:'array',description:'修改关键结论（含出处）用此项，不修改自动排印的引文段。replace/insert 提供完整 claim 对象；remove 仅需索引。新提议引文重新核验。',items:{type:'object',additionalProperties:false,properties:{
        op:{type:'string',enum:['replace','insert','remove']},index:{type:'integer'},claim:{type:'object',additionalProperties:true,description:'结构同 spec.claims 中的一个结论。'}}}},
    }},
  },(input,exec)=>{const request=getRequest();if(!request?.id)throw Error('bridge_request_required');
    return generator.generate(input,{id:exec?.callId?'document-generate-'+hash(request.id+'\0'+exec.callId).slice(0,40):randomUUID(),signal:exec?.signal??request.signal});}];
}
