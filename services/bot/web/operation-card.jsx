import React,{useState} from 'react';
import {Button,DiffBlock} from '@deepseek-ai/dsh-client-ui-primitives';
import {errorText} from './api.mjs';
import {Icon} from './icons.jsx';
const toolLabels={read:'读取文件',glob:'查找文件',grep:'搜索工程',edit:'修改文件',write:'写入文件',bash:'执行命令',shell:'执行命令',browser_open:'打开网页',browser_read:'读取网页',browser_click:'操作网页',browser_fill:'填写网页',browser_scroll:'浏览网页',document_open:'打开文件',remember:'保存记忆',forget:'更新记忆',web_search:'联网搜索',web_fetch:'读取网页'};
export const operationLabel=record=>toolLabels[record.tool]||({file:'修改文件',memory:'更新记忆',browser:'操作网页',shell:'执行命令',document_open:'打开文件'})[record.operation]||'处理任务';
export function OperationCard({record,disabled,onAction}){
 return <details className="operation-card" data-operation-id={record.id}>
  <summary><Icon name="chevron"/><span className="operation-label">{operationLabel(record)}</span><span className={'status '+record.status}>{statusLabels[record.status]||'等待结果'}</span></summary>
  <OperationDetails item={record} disabled={disabled} onAction={onAction}/>
 </details>;
}
const statusLabels={cancelled:'已取消',pending:'旧方案未执行',applying:'正在保存',applied:'已保存',rejected:'已拒绝',conflict:'需要重新核对',failed:'执行失败',completed:'已完成',dispatched:'打开请求已发送',unknown:'结果待核对',running:'执行中',timed_out:'已超时',interrupted:'已中断'};
const diffLabels={copy:'复制差异',copied:'已复制',codeLabel:'文件修改',wrapLabel:'自动换行',unwrapLabel:'取消换行',collapseAria:'收起差异',expandAria:n=>`展开剩余 ${n} 行`,collapse:'收起',expand:n=>`展开剩余 ${n} 行`};
function OperationDetails({item,disabled,onAction}) {
  const [error,setError]=useState(''),[working,setWorking]=useState(false);
  const recoverable=item.kind!=='tool'&&item.status==='applying'&&!disabled&&!working;
  async function retry(){setWorking(true);setError('');try{await onAction('approve',item.id);}catch(e){setError(errorText(e));}finally{setWorking(false);}}
  if(item.kind==='tool'&&item.operation!=='file')return <div className="operation-detail" aria-label={'操作记录 '+item.tool}>
    <div className="approval-title"><strong>{item.description||item.tool}</strong><span className={'status '+item.status}>{statusLabels[item.status]||item.status}</span></div>
    {item.file&&<p className="subtle operation-path">{item.file.path} · {item.file.contentAccess==='not_connected'?'正文未接入':'文本可另行读取'}</p>}
    {item.command&&<pre className="tool-output">{item.command}</pre>}
    <p className="subtle operation-path">{item.cwd}</p>
    {item.operation==='shell'&&<p className="subtle">退出码：{item.exitCode??'—'}{item.timeoutMs?' · 时限 '+Math.round(item.timeoutMs/1000)+' 秒':''}</p>}
    <div className="operation-output"><span className="subtle">执行输出</span><pre className="tool-output">{['browser','document_open'].includes(item.operation)?item.output||'等待回执…':item.operation==='shell'?[item.stdout,item.stderr].filter(Boolean).join('\n')||item.output||'等待命令结束…':item.output||'执行中…'}</pre></div>
    {(item.stdoutPath||item.stderrPath)&&<p className="subtle operation-path">完整日志：{item.stdoutPath||item.stderrPath}</p>}
    {item.error&&<p className="error">{item.error}</p>}
  </div>;
  return <div className="operation-detail" aria-label={'操作记录 '+(item.path||'记忆')}>
    <div className="approval-title"><strong>{item.path||'记忆修改'}</strong><span className={'status '+item.status}>{recoverable?'保存状态待核对':item.tool==='forget'&&item.status==='applied'?'已删除':statusLabels[item.status]||item.status}</span></div>
    {item.operation==='file'?item.previewValid?<DiffBlock diffs={item.diffs||[{path:item.path,oldText:item.beforeContent,newText:item.content}]} labels={diffLabels} maxLines={18}/>:<p role="alert">当前记录没有可用差异预览，请读取文件核对。</p>:
      <div className="memory-change">{(item.target?.text||item.args?.entry)&&<p><span>原记录</span>{item.target?.text||item.args.entry}</p>}{item.tool==='forget'?<p>{item.status==='applied'?'已删除这条有效记忆。':'删除记忆的操作记录。'}</p>:<p><span>保存内容</span>{item.args?.text}</p>}</div>}
    {item.previewTruncated&&<p className="subtle">差异预览已截断；完整文件已保存。</p>}
    {item.status==='pending'&&<p className="subtle">这是旧版本未执行的方案；需要执行时可直接告诉 OpenNova。</p>}
    {item.error&&<p className="error">{errorText({message:item.error})}</p>}
    {recoverable&&<p className="subtle">上次保存未完成，可重试并核对实际结果。</p>}
    {error&&<p role="alert" className="error">{error}</p>}
    {recoverable&&<Button className="nova-primary" disabled={item.previewValid===false} onClick={retry}>重试保存</Button>}
  </div>;
}
