import React,{useState} from 'react';
import {Button,DiffBlock} from '@deepseek-ai/dsh-client-ui-primitives';
import {errorText} from './api.mjs';
import {taskMediaStatus} from './task-view.mjs';
import {Icon} from './icons.jsx';
import {fileReadLabel,readOperationReceipt,generationView} from './file-state.mjs';
import {DocumentComparison} from './document-comparison.jsx';
import {EditionLink} from './project-edition.jsx';
import {ExperimentReceipt} from './project-experiments.jsx';
import {citationLocation} from '../documents/citation-label.mjs';
const toolLabels={read:'读取文件',glob:'查找文件',grep:'搜索工程',edit:'修改文件',write:'写入文件',bash:'执行命令',shell:'执行命令',browser_open:'打开网页',browser_read:'读取网页',browser_click:'操作网页',browser_fill:'填写网页',browser_scroll:'浏览网页',browser_close:'关闭工作页面',nova_show:'打开 Nova 对话窗口',document_open:'打开文件',remember:'保存记忆',forget:'更新记忆',web_search:'联网搜索',web_fetch:'读取网页'};
Object.assign(toolLabels,{research_sources:'回查来源',web_request:'获取接口数据',research_exec:'运行研究脚本',research_derive:'记录脚本结果'});
toolLabels.document_read='读取文档';
toolLabels.document_proposal_decide='处理文档修改';
toolLabels.research_note='保存研究笔记';
toolLabels.image_generate='生成图片';
toolLabels.gif_generate='制作 GIF';
toolLabels.gif_review='抽帧审阅 GIF';
toolLabels.media_export='本地导出媒体';
Object.assign(toolLabels,{project_handoff:'开发任务交接',project_edition:'成果版本',project_experiment:'实验记录'});
toolLabels.web_fetch='后台读取资料';
export const operationLabel=record=>toolLabels[record.tool||record.operation]||({file:'修改文件',memory:'更新记忆',browser:'操作网页',shell:'执行命令',document_open:'打开文件'})[record.operation]||'处理任务';
export function OperationCard({record,disabled,onAction,api,project,offline,onRefresh,visibleReviewIds}){
 if(record.operation==='project_experiment'&&record.status==='completed'){
   if(!project||record.projectId!==project.projectId)return null;
   return <ExperimentReceipt key={record.id+'-'+project.revision} record={record} api={api} project={project}/>;
 }
 if(['project_handoff','project_edition'].includes(record.operation)&&record.status==='completed'){
   if(!project||record.projectId!==project.projectId||!record.sourceIds?.length)return null;
   return <section className="operation-card edition-card" aria-label={operationLabel(record)}>
     <strong>{operationLabel(record)}</strong>
     {record.sourceIds.map((id,i)=><EditionLink key={id+'-'+project.revision} sourceId={id} api={api} project={project} offline={offline}
       title={record.sources?.find(s=>s.sourceId===id)?.title||(record.sourceIds.length>1?'查看记录 '+(i+1):'查看固定版本')}/>)}
   </section>;
 }
 const doc=record.operation==='document_generate'?generationView(record):null;
 const proposal=doc?.proposal;
 if(proposal){
   if(proposal.projectId!==project?.projectId)return null;
   return <DocumentComparison key={JSON.stringify([proposal.id,project.projectId,project.revision])}
     operationId={record.id} preview={proposal} api={api} project={project} offline={offline} disabled={disabled} onRefresh={onRefresh} visibleReviewIds={visibleReviewIds}/>;
 }
 const status=doc?.status||(record.operation==='gif_generate'?gifStatus(record):record.operation==='image_generate'&&record.status==='pending'?taskMediaStatus(record):statusLabels[record.status])||'等待结果';
 return <details className="operation-card" data-operation-id={record.id}>
  <summary><Icon name="chevron"/><span className="operation-label">{doc?.title||operationLabel(record)}</span><span className={'status '+record.status}>{status}</span></summary>
  <OperationDetails item={record} disabled={disabled} onAction={onAction}/>
 </details>;
}
const statusLabels={cancelled:'已取消',pending:'旧方案未执行',applying:'正在保存',applied:'已保存',rejected:'已拒绝',conflict:'需要重新核对',needs_clarification:'待明确文件',failed:'执行失败',completed:'已完成',dispatched:'打开请求已发送',unknown:'结果待核对',running:'执行中',timed_out:'已超时',interrupted:'已中断'};
const gifPhases={preparing:'准备参考图',generating:'正在准备生成',submitting:'正在提交',polling:'正在生成视频',downloading:'正在下载视频',delivering:'正在导出 GIF'};
function gifStatus({phase,status,generation}){
  if(status==='running')return gifPhases[phase]||(generation?.taskId?'正在跟进 Seedance':'正在制作 GIF');
  if(status==='pending')return generation?.taskId?'正在跟进 Seedance':'待继续查询';
  if(status==='partial')return '部分文件已保存';
  return statusLabels[status];
}
const diffLabels={copy:'复制差异',copied:'已复制',codeLabel:'文件修改',wrapLabel:'自动换行',unwrapLabel:'取消换行',collapseAria:'收起差异',expandAria:n=>`展开剩余 ${n} 行`,collapse:'收起',expand:n=>`展开剩余 ${n} 行`};
function OperationDetails({item,disabled,onAction}) {
  const [error,setError]=useState(''),[working,setWorking]=useState(false);
  const recoverable=item.kind!=='tool'&&item.status==='applying'&&!disabled&&!working;
  async function retry(){setWorking(true);setError('');try{await onAction('approve',item.id);}catch(e){setError(errorText(e));}finally{setWorking(false);}}
  if(item.operation==='document_proposal_decide')return <div className="operation-detail" aria-label="文档修改操作">
    {item.error?<p className="error">{errorText({message:item.error})}</p>:
      <p className="subtle">{item.action==='discard'?'正在放弃修改…':item.action==='undo'?'正在核对并撤销文档修改…':'正在核对文档修改…'}</p>}
  </div>;
  if(item.operation==='document_generate'){
    const doc=generationView(item);
    return <div className="operation-detail" aria-label={doc.title+'记录'}>
      {doc.path&&<p className="operation-path">已保存：{doc.path}</p>}
      {doc.previousPath&&<p className="operation-path">保留的旧版：{doc.previousPath}</p>}
      {doc.sourcePath&&<p className="operation-path">原文件位置：{doc.sourcePath}</p>}
      {doc.latestPath&&<p className="operation-path">最新版本：{doc.latestPath}</p>}
      {doc.summary&&<p className={item.error?'error':'subtle'}>{doc.summary}</p>}
      {item.error&&!doc.summary&&<p className="error">{errorText({message:item.error})}</p>}
    </div>;
  }
  if(item.operation==='research_note')return <div className="operation-detail" aria-label="研究笔记记录">
    <strong>{item.title}</strong>{item.path&&<p className="operation-path">{item.path}</p>}
    {item.status==='completed'&&item.claims?.map((c,i)=><div key={i}><p>{i+1}. {c.claim}</p>
      {!c.citations.length&&<p className="subtle">未附可核对的出处。</p>}
      {c.citations.map((r,j)=><div key={j}><p className="subtle">{r.fileName} · {r.observationId?'网页观察':'版本'} {r.sha256?.slice(0,12)} · {r.verified?citationLocation(r):'摘录待核实'}{r.readStatus==='partial'?' · 原读取仅部分可确认':''}</p>
        {r.observationId&&<p className="subtle operation-path">{r.url}</p>}
        {r.verified&&<blockquote>{r.quote}</blockquote>}</div>)}</div>)}
    {item.error&&<p className="error">{errorText({message:item.error})}</p>}
  </div>;
  if(item.operation==='image_generate')return <div className="operation-detail" aria-label="图片生成记录">
    {item.artifact?.path&&<p className="operation-path">{item.artifact.path}</p>}
    {item.status==='running'&&<p>正在生成并保存图片…</p>}
    {item.error&&<p className="error">{errorText({message:item.error})}</p>}
    {item.generation?.provider==='spark'&&item.generation.taskId&&<p className="subtle operation-path">Minimax H3 Image · Spark 任务 {item.generation.taskId}</p>}
    {item.generation?.errorCode&&<p className="subtle">{item.generation.provider==='spark'?'Spark':'方舟'}错误码 {item.generation.errorCode}</p>}
    {item.error&&item.generation?.requestId&&<p className="subtle operation-path">请求编号 {item.generation.requestId}</p>}
  </div>;
  if(item.operation==='gif_generate')return <div className="operation-detail" aria-label="GIF 生成记录">
    {item.artifact?.path&&<p className="operation-path">{item.artifact.path}</p>}
    {item.generation?.taskId&&<p className="subtle operation-path">Seedance 任务 {item.generation.taskId}</p>}
    {item.visualReview?.checkedFrameIndices?.length>0&&<p className="subtle">抽帧审阅：{item.visualReview.checkedFrameIndices.length}/{item.visualReview.totalFrames} 帧 · {item.visualReview.reviewer?.model}</p>}
    {item.error&&<p className="error">{errorText({message:item.error})}</p>}
  </div>;
  if(item.operation==='gif_review')return <div className="operation-detail" aria-label="GIF 视觉审阅记录">
    {item.source?.path&&<p className="operation-path">{item.source.path} · {item.source.sha256.slice(0,12)}</p>}
    {item.visualReview?.checkedFrameIndices?.length>0&&<p className="subtle">实际检查 {item.visualReview.checkedFrameIndices.length}/{item.visualReview.totalFrames} 帧（索引 {item.visualReview.checkedFrameIndices.join('、')}） · {item.visualReview.reviewer?.model}</p>}
    {item.visualReview?.conclusion&&<p>{item.visualReview.conclusion}</p>}
    {item.visualReview?.limitation&&<p className="subtle">{item.visualReview.limitation}</p>}
    {item.error&&<p className="error">{errorText({message:item.error})}</p>}
  </div>;
  if(item.operation==='media_export')return <div className="operation-detail" aria-label="本地媒体导出记录">
    {item.artifact?.path&&<p className="operation-path">{item.artifact.path}</p>}
    {item.generation?.remoteCalls===0&&<p className="subtle">本地处理，未调用生成模型。</p>}
    {item.error&&<p className="error">{errorText({message:item.error})}</p>}
  </div>;
  if(item.kind==='tool'&&item.operation!=='file')return <div className="operation-detail" aria-label={'操作记录 '+item.tool}>
    <div className="approval-title"><strong>{item.description||item.tool}</strong><span className={'status '+item.status}>{statusLabels[item.status]||item.status}</span></div>
    {item.file&&item.operation!=='document_read'&&<p className="subtle operation-path">{item.file.path} · {fileReadLabel(item.file)}</p>}
    {item.operation==='document_read'&&<p className="subtle operation-path">{[item.source?.path??item.file?.path??item.path,readOperationReceipt(item),item.source?.sha256?.slice(0,12)].filter(Boolean).join(' · ')}</p>}
    {item.limitation&&<p className="subtle">{item.limitation}</p>}
    {item.http&&<p className="subtle">HTTP {item.http.statusCode} · {item.http.encoding||'未知编码'} · {item.http.retrievedAt}</p>}
    {item.httpFailures>0&&<p className="subtle">取数记录：{item.httpSuccesses??0} 次成功，{item.httpFailures} 次失败；失败请求保留在操作记录中。</p>}
    {item.command&&<pre className="tool-output">{item.command}</pre>}
    <p className="subtle operation-path">{item.cwd}</p>
    {(item.operation==='shell'||item.tool==='research_exec')&&<p className="subtle">退出码：{item.exitCode??'—'}{item.timeoutMs?' · 时限 '+Math.round(item.timeoutMs/1000)+' 秒':''}</p>}
    <div className="operation-output"><span className="subtle">执行输出</span><pre className="tool-output">{item.operation==='document_read'?item.content||item.output||(item.status==='running'?'等待读取结果…':'无读取输出'):['browser','document_open'].includes(item.operation)?item.output||'等待回执…':item.operation==='shell'?[item.stdout,item.stderr].filter(Boolean).join('\n')||item.output||'等待命令结束…':item.output||'执行中…'}</pre></div>
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
