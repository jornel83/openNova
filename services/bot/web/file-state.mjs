/** A read receipt describes saved bytes; opening an app does not imply a read. */
function pageLabel(range,pageCount){
  if(!range||![range.startPage,range.endPage].every(page=>Number.isSafeInteger(page)&&page>0)||range.startPage>range.endPage||
    pageCount!=null&&(!Number.isSafeInteger(pageCount)||pageCount<range.endPage))return '';
  return `原文第 ${range.startPage===range.endPage?range.startPage:`${range.startPage}–${range.endPage}`} 页${pageCount!=null?`（共 ${pageCount} 页）`:''}`;
}
function pdfScopeLabel(scope){return scope?.mode==='pdf_pages'?pageLabel(scope,scope.pageCount):'';}
export function fileReadLabel(file={}) {
  if(file.invalid||file.diskStatus==='missing')return '文件已失效';
  if(file.artifactId&&file.diskStatus==='changed')return '磁盘版本与生成记录不同；继续修改前需核对';
  if(file.diskStatus==='changed')return '磁盘文件已更新，需重新读取';
  if(file.imageOperationId)return '继续改图时使用此版本';
  if(file.readStatus==='read'||file.readStatus==='partial'){
    const pages=pdfScopeLabel(file.readScope);
    if(pages)return `${pages} · ${file.readStatus==='partial'?'仅能确认部分内容':'已按本次问题读取'}`;
    return file.readStatus==='partial'?'已按本次问题读取部分内容':'已按本次问题读取保存版本';
  }
  if(file.artifactId&&file.generationStatus==='completed'){
    return Number.isSafeInteger(file.revision)&&file.revision>1?`已保存第 ${file.revision} 版 · 旧版保留在原位置`:'已保存生成的文档';
  }
  if(file.contentAccess==='native_file')return '正文可按需读取';
  if(file.contentAccess==='text_file')return '文本可另行读取磁盘保存版本';
  return '此格式正文尚未接入';
}

export const proposalStatusLabels={pending:'待确认',applied:'已应用',undone:'已撤销',discarded:'已放弃',conflict:'原文件有变化'};

export function documentProposal(row){
  const p=row?.proposal;
  return row?.operation==='document_generate'&&row.action==='revise'&&row.status==='completed'&&
    p?.id&&Object.hasOwn(proposalStatusLabels,p.status)&&['docx','pdf'].includes(p.format)?p:null;
}

/** Only a published artifact denotes a saved document; staging paths are not deliverables. */
export function generationView(row={}){
  const result={title:row.action==='revise'?'修订文档':row.action==='inspect'?'查看可修改内容':'生成文档'};
  const proposal=documentProposal(row);
  if(proposal)return {title:(proposal.format==='pdf'?'PDF':'Word')+' 修改对照',status:proposalStatusLabels[proposal.status],proposal};
  if(row.status==='completed'&&row.action==='inspect')return {...result,status:'已查看',summary:'已取得生成时保存的内容规格。'};
  if(row.status==='completed'&&row.artifact?.path){
    const a=row.artifact,revision=Number.isSafeInteger(a.revision)&&a.revision>1;
    return {...result,status:revision?`已保存第 ${a.revision} 版`:'已保存',path:a.path,previousPath:a.parentPath,
      summary:[row.contentValidation?.status==='passed'&&'内容核验通过',row.layoutValidation?.visual?.status==='not_checked'&&'未检查逐页外观'].filter(Boolean).join('；')};
  }
  if(row.error==='document_revision_source_changed')return {...result,status:'磁盘版本冲突',summary:'文件在 Nova 保存后已发生变化。本次未生成新版，磁盘文件未被覆盖。',sourcePath:row.errorDetails?.path};
  if(row.error==='document_revision_source_missing')return {...result,status:'找不到原文件',summary:'本次未生成新版。请核对原文件位置。',sourcePath:row.errorDetails?.path};
  if(row.error==='document_revision_not_latest')return {...result,status:'已有更新版本',summary:'当前引用的是旧版。本次未生成文件，请从最新版本继续修改。',latestPath:row.errorDetails?.latestPath};
  if(row.error==='document_target_exists')return {...result,status:'文件名冲突',summary:'目标位置已有文件，本次未覆盖。'};
  if(row.status==='running')return {...result,summary:row.action==='inspect'?'正在查找生成记录…':row.action==='revise'?'正在核对原件并整理修改对照…':'正在生成文档…'};
  return {...result,summary:row.status==='interrupted'?'操作已中断，请核对保存记录。':undefined};
}

export function readOperationReceipt(record){
  const pages=pdfScopeLabel(record.readScope),remaining=pageLabel(record.recovery?.remainingRange);
  const result=record.status==='completed'&&['read','partial'].includes(record.readStatus)?fileReadLabel({readStatus:record.readStatus,readScope:record.readScope}):
    [pages&&`本次范围：${pages}`,record.status==='running'?'等待读取结果':'未取得已确认的读取结果'].filter(Boolean).join(' · ');
  const window=record.source?.entry==='desktop_open'?(record.source.app||'桌面')+' 文档窗口':'';
  return [window,result,record.diskStatus==='changed'?'读取后磁盘版本已更新':record.diskStatus==='missing'?'磁盘原件已移除':'',remaining&&`可继续读取：${remaining}`].filter(Boolean).join(' · ');
}
