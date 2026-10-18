import React from 'react';
import {Icon} from './icons.jsx';
const applications={'com.apple.TextEdit':'文本编辑','com.apple.Preview':'预览','com.microsoft.VSCode':'Visual Studio Code','com.kingsoft.wpsoffice.mac':'WPS Office'};
export function ContextChip({context,onClear,onOpenFile,disabled=false}) {
 if(!context||context.kind==='none')return null;
 const file=context.kind==='file'?context.file:null,page=context.page;
 return <section className="context-chip" aria-label={file?'当前关联文件':'当前工作网页'}>
  <div className="context-heading"><Icon name={file?'file':'link'}/><span>{file?(context.historical?'上次关联文件':'关联文件'):'工作网页'}{context.selection?' · 已引用选区':''}</span>
   {context.selection&&<button type="button" className="icon-button" aria-label="清除选区引用" title="清除选区引用，保留工作网页" onClick={onClear} disabled={disabled}><Icon name="close"/></button>}
  </div>
  <div className="context-title"><strong title={file?.path||page?.url}>{file?.name||page?.title||'工作网页'}</strong>
   {file&&<button type="button" className="text-button" disabled={disabled||file.invalid} onClick={()=>onOpenFile(file.id)}>重新打开 <Icon name="open"/></button>}
  </div>
  <small className="context-location" title={file?.path||page?.url}>{file?file.path?.slice(0,file.path.lastIndexOf('/')):page?.url}</small>
  {context.selection&&<blockquote>{context.selection.text}{context.selection.truncated?'（选区已截断）':''}</blockquote>}
  <small className="context-receipt">{file?<>{file.applicationId?applications[file.applicationId]||file.applicationId:'系统默认应用'} · {context.historical?'历史打开记录':'打开请求已发送'}<br/>{file.contentAccess==='text_file'?'文本可另行读取磁盘保存版本':'正文未接入'}{file.diskStatus==='changed'?' · 磁盘文件已更新':''}{file.invalid?' · 文件已失效':''}</>:page?.readable?'发送时关联此页；正文按需读取':'页面未接入，请检查扩展权限'}</small>
 </section>;
}
