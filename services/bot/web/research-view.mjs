const phases={searching:'正在联网搜索',reading:'正在读取资料',summarizing:'正在整理回答',requesting:'正在获取数据',processing:'正在处理数据',verifying:'正在核对结果'};
export function researchPhaseLabel(request){
 if(request?.phase==='tool'&&request.tool&&!['web_search','web_fetch','research_sources','web_request','research_exec','research_derive'].includes(request.tool))return null;
 return phases[request?.research?.phase]??null;
}
function time(value){if(!value||!Number.isFinite(Date.parse(value)))return '';return new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});}
export function sourceCards(sources=[]){
 return sources.flatMap(s=>{try{
  const url=new URL(s.url);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return [];
  return [{key:s.observationId||s.id||url.href,url:url.href,title:s.title||url.hostname,excerpt:s.excerpt?.slice(0,800),
   evidenceLabel:({api_response:'接口响应',page_body:'已读取正文',page_response:'网页响应',search_link:'搜索链接'})[s.evidenceType]||'搜索摘要',httpLabel:s.statusCode?'HTTP '+s.statusCode+(s.encoding?' · '+s.encoding:''):'',truncated:!!s.truncated,
   retrievedLabel:s.retrievedAt?'获取：'+time(s.retrievedAt):'',
   publishedLabel:s.publishedAt?'发布：'+s.publishedAt:s.publishedAtRaw?'来源标注：'+s.publishedAtRaw:''}];
 }catch{return [];}});
}

export function derivationCards(rows=[]){return rows.map(r=>({key:r.id,evidenceLabel:'脚本处理结果',summary:r.summary,artifactPath:r.artifactPath,inputObservationIds:r.inputObservationIds??[],
 warning:r.artifactChanged||r.inputArtifactsChanged?'输入或输出文件已变化，原记录保留':r.hasObservedInputs?'记录了输入与输出关联，未自动核验算法':'无受记录的 HTTP 输入，结果尚未核验'}));}
