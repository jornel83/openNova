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
]);
const stages = new Set(['authorization', 'model_catalog', 'harness_start', 'conversation']);

export function errorEvent(error, stage) {
  let code = codes.has(error?.code) ? error.code
    : codes.has(error?.message) ? error.message : 'agent_runtime_failed';
  if (stage === 'harness_start' && error?.name === 'TransportClosedError') code = 'harness_connection_closed';
  if (stage === 'harness_start' && error?.code === 'ERR_MODULE_NOT_FOUND') code = 'harness_dependency_missing';
  const status = error?.status;
  return {type:'error', code, stage:stages.has(stage) ? stage : 'agent',
    ...(Number.isInteger(status) && status >= 400 && status <= 599 ? {status} : {})};
}
