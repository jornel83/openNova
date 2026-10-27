/** Content availability only; callers must still check the requested facts and dates. */
export function assessContent({body,statusCode=200,replacementCount=0}) {
 if(statusCode<200||statusCode>=300)return {state:'blocked',reason:`http_${statusCode}`};
 const text=body?.content??'';
 if(replacementCount>2&&replacementCount/Math.max(text.length,1)>.005)return {state:'encoding_error'};
 if(!text.trim())return {state:'empty'};
 if(body.kind==='html'){
  const visible=text.replace(/<(head|script|style|nav)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi,'').replace(/<[^>]*>/g,'').replace(/&(?:nbsp|#160);/g,' ').trim();
  if(!visible)return {state:/<title\b/i.test(text)?'title_only':'empty'};
 }
 return {state:'usable'};
}
