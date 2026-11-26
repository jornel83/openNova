/** Keep actionable SDK metadata; never forward arbitrary messages, stderr or tokens. */
const authorizationCodes = new Set([
  'sign_in_required', 'chatgpt_authorization_required', 'invalid_grant',
  'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
  'refresh_token_invalidated', 'refresh_token_reused',
]);
const codes = new Set([
  ...authorizationCodes,
  'api_error', 'network_error', 'connection_error', 'cancelled', 'secure_storage_unavailable',
  'gpt_6_1_sol_unavailable', 'invalid_agent_configuration', 'invalid_token', 'invalid_api_key',
  'subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable',
  'subscription_sharing_user_not_eligible', 'subscription_sharing_unsupported_capability',
  'chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context',
  'invalid_client', 'model_not_found', 'stream_interrupted', 'incomplete_agent_turn',
  'routing_timeout','invalid_route_response','response_incomplete','invalid_stream',
  'harness_connection_closed','harness_dependency_missing',
  'input_too_large', 'invalid_request', 'unsupported_model',
  'web_api_key_missing','deepseek_api_key_missing','invalid_web_configuration','siwc_tools_extension_missing','siwc_build_missing',
  'model_budget_exceeded','tool_budget_exceeded','agent_timeout','web_time_budget',
  'response_too_large','invalid_speech_text','invalid_tool_call','invalid_tool_arguments',
  'agent_runtime_failed','incomplete_model_response','bridge_request_required','bot_model_not_allowed','model_service_unavailable',
]);
const stages = new Set(['authorization', 'model_catalog', 'harness_start', 'routing', 'conversation','context_maintenance']);
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

export function requiresChatGPTAuthorization(value){
  return authorizationCodes.has(errorEvent(value,value?.stage).code);
}

/** User-facing copy shared by the conversation view and the spoken error notice. */
export function diagnosticHint(value){
  const d=errorEvent(value,value?.stage);
  const networkHint='无法连接 ChatGPT，请检查网络或 OpenNova 的代理设置后重试。';
  const hint=authorizationCodes.has(d.code)?'需要重新完成 OpenNova 的 ChatGPT 授权。':{
    network_error:networkHint,
    connection_error:networkHint,
    stream_interrupted:'ChatGPT 连接在回复完成前中断，请稍后重试。',
    routing_timeout:'等待 ChatGPT 判断话题超时，请稍后重试。',
    invalid_route_response:'ChatGPT 返回的话题识别结果无法使用，请重新提交这句话。',
    response_incomplete:'ChatGPT 提前结束了回复，请稍后重试。',
    invalid_stream:'ChatGPT 返回的回复格式异常，请稍后重试。',
    incomplete_agent_turn:'本轮模型回复未完整完成，已执行的操作可在记录中查看。',
    incomplete_model_response:'模型没有返回完整的回答，请稍后重试。',
    model_service_unavailable:'ChatGPT 服务暂时不可用，请稍后重试。',
    subscription_sharing_usage_limit_exceeded:'ChatGPT 共享用量已达上限。',
    agent_timeout:'本轮处理超时，已执行的操作可在记录中查看。',
    cancelled:'请求已取消。',
  }[d.code]??({400:'ChatGPT 未接受请求格式，请检查模型配置。',401:'ChatGPT 拒绝了当前凭据，请检查授权。',403:'ChatGPT 拒绝了这次请求，请检查账号或应用的访问权限。',407:'代理要求身份验证，请检查代理设置后重试。',429:'ChatGPT 请求受限，请检查用量并稍后重试。'}[d.status]??(d.status>=500?'ChatGPT 服务暂时异常，请稍后重试。':'模型调用未完成，请查看 OpenNova 的运行日志。'));
  return d.stage==='routing'?'话题识别失败。'+hint+'当前项目保持不变。':hint;
}

export function diagnosticText(value){
  const d=errorEvent(value,value?.stage);
  return diagnosticHint(d)+' ['+[d.code,...d.status?[`HTTP ${d.status}`]:[],...d.requestId?[`服务请求 ${d.requestId}`]:[]].join(' · ')+']';
}
