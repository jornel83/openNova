import React,{useRef,useState} from 'react';
import {errorText} from './api.mjs';
import {proposalStatusLabels} from './file-state.mjs';
import {Icon} from './icons.jsx';

function ChangeValue({value}){
  if(value==null)return <span className="comparison-empty">无</span>;
  if(value==='')return <span className="comparison-empty">空字符串</span>;
  return typeof value==='object'?JSON.stringify(value,null,2):String(value);
}

function sameProposal(result,preview){
  return result?.id===preview.id&&result.projectId===preview.projectId&&result.baseArtifactId===preview.baseArtifactId&&
    result.baseSha256===preview.baseSha256&&Object.hasOwn(proposalStatusLabels,result.status);
}

const cardId=id=>'review-'+id;

function ReviewLink({id,children}){
  function reveal(event){
    const target=document.getElementById(cardId(id));
    if(!target)return;
    event.preventDefault();
    for(let node=target;node;node=node.parentElement){
      if(node.tagName==='DETAILS')node.open=true;
    }
    target.querySelector('summary')?.focus();
    target.scrollIntoView?.({block:'nearest'});
  }
  return <a href={'#'+cardId(id)} onClick={reveal}>{children}</a>;
}

function ReviewOutcome({proposal:p,visibleReviewIds}){
  if(p.status==='undone')return <p role="status">
    已将应用前的内容恢复为第 {p.undoArtifact.revision} 版，原有版本已保留。
    <span className="operation-path">{p.undoArtifact.path}</span></p>;
  if(p.status==='applied')return <p role="status">
    {p.artifact?.revision?'已保存第 '+p.artifact.revision+' 版。':'修改已应用。'}
    {p.artifact?.path&&<span className="operation-path">{p.artifact.path}</span>}</p>;
  if(p.status==='discarded')return <p role="status">已放弃这份方案。原文件保留在原位置。</p>;
  if(p.status!=='conflict')return null;
  const conflict=p.conflict??{},replacement=conflict.replacementId;
  const reason=conflict.reason==='document_revision_source_missing'?conflict.reason:conflict.rebaseError||conflict.reason;
  return <div className="comparison-conflict" role="status">
    <p>确认时发现原文件有变化，原方案已保留。</p>
    {replacement?<p>已根据磁盘上的文件重新生成对照。
      {visibleReviewIds?.has(replacement)&&<ReviewLink id={replacement}>查看新对照</ReviewLink>}</p>:
      <p>{reason?errorText({message:reason}):'请核对原文件并重新提出修改。'}</p>}
  </div>;
}

export function DocumentComparison({operationId,preview,project,api,offline,disabled,onRefresh,visibleReviewIds}){
  const [full,setFull]=useState(null),[decision,setDecision]=useState(null);
  const [loading,setLoading]=useState(false),[working,setWorking]=useState(''),[error,setError]=useState('');
  const lock=useRef(false),actionIds=useRef({});
  // A confirmed receipt can arrive before the next snapshot. A newer snapshot always wins.
  const snapshotState=JSON.stringify([preview.status,preview.conflict,preview.artifact?.id,preview.undoArtifact?.id,preview.undoAvailable]);
  const proposal=decision?.previous===snapshotState?decision.next:preview;
  const changes=full?.changes??proposal.changes;
  async function loadFull(){
    setLoading(true);setError('');
    try{
      const result=await api.call('document-proposal',{id:preview.id,expectedProject:project});
      if(!sameProposal(result,preview)||result.truncated||!Array.isArray(result.changes)||
        result.changes.length!==preview.changeCount)throw Error('invalid_document_proposal');
      setFull(result);
    }catch(e){setError(errorText(e));}
    finally{setLoading(false);}
  }
  async function decide(action){
    if(lock.current||disabled||offline)return;
    lock.current=true;setWorking(action);setError('');
    try{
      const actionId=actionIds.current[action]??=crypto.randomUUID();
      const result=await api.call('document-proposal-action',{id:preview.id,action,expectedProject:project,actionId});
      if(result.status==='failed'){
        delete actionIds.current[action]; // This attempt has a terminal, journaled outcome.
        if(action==='undo'&&result.error==='document_revision_source_changed')throw Error('document_undo_source_changed');
        if(action==='undo'&&result.error==='document_revision_not_latest')throw Error('document_undo_not_latest');
        throw Error(result.error||'document_proposal_action_failed');
      }
      if(result.status!=='completed')throw Error(result.error||'document_proposal_action_failed');
      const next=result.proposal;
      if(!sameProposal(next,preview)||!(action==='undo'?next.status==='undone':['applied','discarded','conflict'].includes(next.status))||
        (next.status==='undone'&&(!next.undoArtifact?.path||!Number.isSafeInteger(next.undoArtifact.revision)))||
        (next.status==='applied'&&(!next.artifact?.path||!Number.isSafeInteger(next.artifact.revision))))throw Error('invalid_document_proposal');
      delete actionIds.current[action]; // A later explicit recheck is a new attempt.
      setDecision({previous:snapshotState,next});
    }catch(e){setError(errorText(e));}
    finally{
      lock.current=false;setWorking('');
      if(onRefresh)void onRefresh().catch(()=>{});
    }
  }

  const pending=proposal.status==='pending',conflict=proposal.status==='conflict';
  const undoable=proposal.status==='applied'&&proposal.undoAvailable!==false;
  const recheck=conflict&&!proposal.conflict?.replacementId&&proposal.conflict?.rebaseError!=='document_rebase_already_matches';
  const type=proposal.format==='pdf'?'PDF':'Word';
  return <details id={cardId(proposal.id)} className="operation-card" data-operation-id={operationId} open>
    <summary><Icon name="chevron"/><span className="operation-label">{type} 修改对照</span>
      <span className={'status '+(pending?'proposal-pending':proposal.status)}>{proposalStatusLabels[proposal.status]}</span></summary>
    <section className="operation-detail document-comparison" aria-label={type+' 文档修改对照'}>
      <strong className="comparison-file">{proposal.basePath.split(/[/\\]/).at(-1)}</strong>
      <p className="comparison-meta">基准第 {proposal.baseRevision} 版{proposal.supersedesId?'（重新核对）':''} · 共 {proposal.changeCount} 处修改{pending?' · 尚未生成新版':''}</p>
      {proposal.supersedesId&&<p className="comparison-context">此对照以重新读取的磁盘内容为准。
        {visibleReviewIds?.has(proposal.supersedesId)&&<ReviewLink id={proposal.supersedesId}>查看原方案</ReviewLink>}</p>}
      <ReviewOutcome proposal={proposal} visibleReviewIds={visibleReviewIds}/>
      <ol className="comparison-changes">
        {changes.map((change,index)=><li key={index}>
          <strong>{change.label}</strong>
          <dl className="comparison-values">
            <div><dt>修改前</dt><dd><ChangeValue value={change.before}/></dd></div>
            <div><dt>修改后</dt><dd><ChangeValue value={change.after}/></dd></div>
          </dl>
          {change.truncated&&<small>此处内容仅显示摘录</small>}
        </li>)}
      </ol>
      {!full&&proposal.truncated&&<div className="comparison-more">
        <span>当前预览 {changes.length} / {proposal.changeCount} 处</span>
        <button type="button" disabled={loading||offline} onClick={loadFull}>{loading?'正在读取…':'查看完整对照'}</button>
      </div>}
      {error&&<p className="error" role="alert">{error}</p>}
      {undoable&&<div className="comparison-actions">
        <button type="button" className="nova-secondary" disabled={disabled||offline||!!working} onClick={()=>decide('undo')}>
          {working==='undo'?'正在核对并撤销…':'撤销这次修改'}</button>
      </div>}
      {(pending||conflict)&&<div className="comparison-actions">
        {pending&&<button type="button" className="nova-primary" disabled={disabled||offline||!!working} onClick={()=>decide('confirm')}>
          {working==='confirm'?'正在核对并应用…':proposal.truncated&&!full?'确认应用全部 '+proposal.changeCount+' 处修改':'确认应用'}</button>}
        {recheck&&<button type="button" className="nova-secondary" disabled={disabled||offline||!!working} onClick={()=>decide('confirm')}>
          {working==='confirm'?'正在重新核对…':'重新核对原文件'}</button>}
        <button type="button" className="nova-secondary" disabled={disabled||offline||!!working} onClick={()=>decide('discard')}>
          {working==='discard'?'正在放弃…':'放弃修改'}</button>
      </div>}
      <details className="comparison-source"><summary>基准文件与修改编号</summary>
        <dl><dt>基准路径</dt><dd>{proposal.basePath}</dd>
          <dt>基准 SHA-256</dt><dd>{proposal.baseSha256}</dd>
          <dt>修改编号</dt><dd>{proposal.id}</dd></dl>
      </details>
    </section>
  </details>;
}
