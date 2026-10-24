const phases={searching:'正在联网搜索',reading:'正在读取资料',summarizing:'正在整理回答'};
export function researchPhaseLabel(request){
 if(request?.phase==='tool'&&request.tool&&!['web_search','web_fetch','research_sources'].includes(request.tool))return null;
 return phases[request?.research?.phase]??null;
}
function time(value){if(!value||!Number.isFinite(Date.parse(value)))return '';return new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});}
export function sourceCards(sources=[]){
 return sources.flatMap(s=>{try{
  const url=new URL(s.url);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return [];
  return [{key:s.observationId||s.id||url.href,url:url.href,title:s.title||url.hostname,excerpt:s.excerpt?.slice(0,800),
   evidenceLabel:s.evidenceType==='page_body'?'已读取正文':'搜索摘要',truncated:!!s.truncated,
   retrievedLabel:s.retrievedAt?'获取：'+time(s.retrievedAt):'',
   publishedLabel:s.publishedAt?'发布：'+s.publishedAt:s.publishedAtRaw?'来源标注：'+s.publishedAtRaw:''}];
 }catch{return [];}});
}
