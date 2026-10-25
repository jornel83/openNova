/** Keep actionable SDK metadata; never forward arbitrary messages, stderr or tokens. */
const codes = new Set([
  'api_error', 'network_error', 'connection_error', 'cancelled', 'secure_storage_unavailable',
  'chatgpt_authorization_required', 'gpt_6_1_sol_unavailable', 'invalid_agent_configuration',
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
  'refresh_token_invalidated', 'refresh_token_reused', 'invalid_token', 'invalid_api_key',
  'subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable',
  'subscription_sharing_user_not_eligible', 'subscription_sharing_unsupported_capability',
  'chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context',
  'invalid_client', 'model_not_found', 'stream_interrupted', 'incomplete_agent_turn',
  'input_too_large', 'invalid_request', 'unsupported_model',
  'web_api_key_missing','deepseek_api_key_missing','invalid_web_configuration','siwc_tools_extension_missing',
  'model_budget_exceeded','tool_budget_exceeded','agent_timeout','web_time_budget',
  'response_too_large','invalid_speech_text','invalid_tool_call','invalid_tool_arguments',
  'agent_runtime_failed','incomplete_model_response','bridge_request_required','bot_model_not_allowed','model_service_unavailable',
]);
const stages = new Set(['authorization', 'model_catalog', 'harness_start', 'conversation','context_maintenance']);
const requestIdOf=value=>typeof value==='string'&&/^(?:req_[A-Za-z0-9_-]{1,120}|[a-fA-F0-9]{16,64}(?:-[A-Z]{3})?|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$/.test(value)?value:undefined;

export function errorEvent(error, stage) {
  let code = codes.has(error?.code) ? error.code
    : codes.has(error?.message) ? error.message : 'agent_runtime_failed';
  if (stage === 'harness_start' && error?.name === 'TransportClosedError') code = 'harness_connection_closed';
  if (stage === 'harness_start' && error?.code === 'ERR_MODULE_NOT_FOUND') code = 'harness_dependency_missing';
  const status = error?.status;
  const requestId=requestIdOf(error?.requestId);
  return {type:'error', code, stage:stages.has(stage) ? stage : 'agent',
    ...(Number.isInteger(status) && status >= 400 && status <= 599 ? {status} : {}),
    ...(requestId?{requestId}:{})};
}

export function safeError(error,stage='conversation'){
  const {type,...facts}=errorEvent(error,stage);
  return Object.assign(new Error(facts.code),facts);
}

export function diagnosticText(value){
  const d=errorEvent(value,value?.stage),hint={
    network_error:'无法连接 ChatGPT，请检查当前网络或代理后重试。',
    connection_error:'无法连接 ChatGPT，请检查当前网络或代理后重试。',
    stream_interrupted:'ChatGPT 连接在回复完成前中断，请稍后重试。',
    incomplete_agent_turn:'本轮模型回复未完整完成，已执行的操作可在记录中查看。',
    incomplete_model_response:'模型返回不完整，已执行的操作可在记录中查看。',
    chatgpt_authorization_required:'需要重新完成 OpenNova 的 ChatGPT 授权。',
    subscription_sharing_usage_limit_exceeded:'ChatGPT 共享用量已达上限。',
    agent_timeout:'本轮处理超时，已执行的操作可在记录中查看。',
    cancelled:'请求已取消。',
  }[d.code]??({400:'ChatGPT 未接受请求格式，请查看错误码并检查模型适配。',401:'ChatGPT 拒绝了当前凭据，请检查授权。',403:'ChatGPT 请求被拒绝，请检查网络及账号或应用的访问权限。',429:'ChatGPT 请求受限，请检查用量并稍后重试。'}[d.status]??(d.status>=500?'ChatGPT 服务暂时异常，请稍后重试。':'模型调用未完成，请结合请求编号检查服务日志。'));
  return hint+' ['+[d.code,...d.status?[`HTTP ${d.status}`]:[],...d.requestId?[`服务请求 ${d.requestId}`]:[]].join(' · ')+']';
}
