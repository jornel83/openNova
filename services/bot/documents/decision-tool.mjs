import {createHash} from 'node:crypto';
import {basename} from 'node:path';

// Give the topic router filenames and stable identifiers only. The recipe and the
// before/after values stay inside the bound project's document workflow.
export function documentReviewChoices(ops,state){
  if(state.focus!=='work'||!state.projectId)return [];
  return ops.db.prepare(`SELECT id,json_extract(body,'$.basePath') path,json_extract(body,'$.format') format
    FROM records WHERE kind='document_proposal' AND json_extract(body,'$.projectId')=?
    AND (json_extract(body,'$.status')='pending' OR (json_extract(body,'$.status')='conflict'
      AND json_extract(body,'$.conflict.replacementId') IS NULL
      AND json_extract(body,'$.conflict.rebaseError') IS NOT 'document_rebase_already_matches')) ORDER BY rowid DESC`).all(state.projectId)
    .map(({id,path,format})=>({id,name:basename(path),format}));
}

// Undo targets are the current edition of each document. An already restored
// head remains selectable so replaying a request can return its original receipt.
export function documentUndoChoices(ops,state,currentFile){
  if(state?.focus!=='work'||!state.projectId)return [];
  return ops.db.prepare(`WITH editions AS (
    SELECT id, COALESCE(json_extract(body,'$.rootArtifactId'),id) root,
           COALESCE(json_extract(body,'$.revision'),1) revision
    FROM records WHERE kind='document_artifact' AND json_extract(body,'$.projectId')=?
  ), heads AS (SELECT root, MAX(revision) revision FROM editions GROUP BY root)
    SELECT p.id, e.id headId, json_extract(p.body,'$.basePath') basePath, json_extract(p.body,'$.artifact.path') appliedPath,
      json_extract(p.body,'$.format') format, json_extract(p.body,'$.status') status
    FROM records p JOIN editions e ON e.id=COALESCE(json_extract(p.body,'$.undoArtifact.id'),json_extract(p.body,'$.artifact.id'))
    JOIN heads h ON e.root=h.root AND e.revision=h.revision
    WHERE p.kind='document_proposal' AND json_extract(p.body,'$.projectId')=?
      AND json_extract(p.body,'$.status') IN ('applied','undone') ORDER BY p.rowid DESC`).all(state.projectId,state.projectId)
    .map(({id,headId,basePath,appliedPath,format,status})=>({id,name:basename(basePath),appliedName:basename(appliedPath),format,status,
      ...(currentFile?.artifactId===headId?{selected:true}:{})}));
}

export function recentDocumentDecisions(ops,projectId){
  // A panel decision doesn't create a new chat message. Subsequent questions
  // still need its actual receipt even when no proposal remains open.
  return ops.db.prepare(`SELECT json_extract(body,'$.proposal.id') id,json_extract(body,'$.proposal.basePath') basePath,
    json_extract(body,'$.proposal.status') status,json_extract(body,'$.artifact.path') savedPath
    FROM records WHERE kind='tool' AND json_extract(body,'$.operation')='document_proposal_decide'
    AND json_extract(body,'$.projectId')=? AND json_extract(body,'$.phase') IN ('committed','discarded','undone')
    ORDER BY rowid DESC LIMIT 5`).all(projectId);
}

function matchesReference(choice,reference){
  const word=reference.trim().toLowerCase();
  return word.length>=2&&(choice.name.toLowerCase().includes(word)||choice.appliedName?.toLowerCase().includes(word)||
    (choice.format==='docx'&&word==='word')||choice.format===word||
    (word.length>=6&&choice.id.toLowerCase().endsWith(word))||
    (choice.selected&&['当前文件','当前文档','这份文件','这份文档','选中的文件','选中的文档','current file','current document'].includes(word)));
}

export function validateDocumentDecision(value,{projectId,context,text}){
  if(!value||!['confirm','discard','undo'].includes(value.action)||typeof value.quote!=='string'||
    !value.quote.trim()||value.quote.length>300||!text.includes(value.quote)||
    Object.keys(value).some(k=>!['action','id','quote','targetQuote'].includes(k))||
    context.focus!=='work'||context.projectId!==projectId)return null;
  const choices=(value.action==='undo'?context.documentUndos:context.documentReviews)??[],choice=choices.find(r=>r.id===value.id);
  if(!choice)return null;
  if(choices.length>1||value.targetQuote!==undefined){
    const ref=value.targetQuote;
    if(typeof ref!=='string'||!text.includes(ref)||choices.filter(r=>matchesReference(r,ref)).length!==1||!matchesReference(choice,ref))return null;
  }
  return {action:value.action,id:choice.id,quote:value.quote};
}

export function createDocumentDecisionTool({generator,getRequest,projects}){
  return ['document_proposal_decide','用户本轮已明确决定时，确认或放弃待处理的 Word/PDF 修改，或撤销最近一次已应用的修改并将旧内容另存为新版。只处理本轮宿主绑定的动作及修改编号。',{
    id:{type:'string',required:true,description:'宿主绑定的 documentDecision.id。'},
    action:{type:'string',enum:['confirm','discard','undo'],required:true,description:'与用户本轮的决定一致。undo 用于已应用的修改。'},
  },(input,exec)=>{
    const request=getRequest(),binding=request?.binding,decision=binding?.documentDecision;
    if(!decision||decision.action!==input.action||decision.id!==input.id)throw Error('document_decision_not_authorized');
    const isCurrent=()=>{
      const state=projects.state();
      return getRequest()===request&&!request.cancelled&&!request.projectChanged&&state.focus==='work'&&state.projectId===binding.projectId&&state.revision===binding.revision;
    };
    if(!isCurrent())throw Error('project_state_changed');
    const id='document-chat-decision-'+createHash('sha256').update(request.id+'\0'+decision.id+'\0'+decision.action).digest('hex');
    return generator.decide(input,{id,request,isCurrent,signal:exec?.signal??request.signal});
  }];
}
