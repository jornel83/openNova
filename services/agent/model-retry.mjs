/** Only the native agent loop executes this provider-owned retry policy. */
export const MODEL_RETRY_POLICY=Object.freeze({
  mode:'normal',maxRetries:2,retryableCodes:Object.freeze(['model_service_unavailable']),
  initialDelayMs:1000,maxDelayMs:2000,jitterRatio:0,
});

export function modelRetryLabel(record){
  const r=record?.modelRetry;
  if(record?.status!=='running'||!['waiting','requesting'].includes(r?.status))return '';
  return `模型暂时繁忙，正在自动重试（${r.retry}/${r.maxRetries}）…`;
}
