/** Read-only compatibility for routing failures previously saved as completed clarifications. */
import {errorEvent} from '../../agent/errors.mjs';

const genericQuestion='你希望继续哪个项目，还是先聊聊日常？';
const legacy=new Map([
  ['route_unavailable',{code:'agent_runtime_failed',questions:[
    '话题识别服务暂时不可用，当前项目保持不变，请稍后重试。',
    '话题识别无法连接 ChatGPT，请检查当前网络或代理后重试。当前项目保持不变。',
  ]}],
  ['route_authorization_required',{code:'chatgpt_authorization_required',questions:['OpenNova 需要重新完成 ChatGPT 授权，请重新登录授权后再试。当前项目保持不变。']}],
  ['route_timeout',{code:'routing_timeout',questions:['话题识别暂时超时，当前项目保持不变，请稍后重试。']}],
  ['route_incomplete',{code:'incomplete_model_response',questions:['话题识别回复未完整完成，当前项目保持不变，请稍后重试。']}],
  ...['invalid_route','invalid_route_json','invalid_management_route','unknown_project','route_too_large','router_tool_call_rejected']
    .map(reason=>[reason,{code:'invalid_route_response',questions:[genericQuestion]}]),
]);

export function projectRoutingFailure(route){
  if(!route||typeof route!=='object'||route.focus!=='clarify'||route.projectId!==null)return;
  // New successful clarifications explicitly use null, even after a recovered
  // network attempt. A model's free-form reason is never a failure marker.
  if(Object.hasOwn(route,'failure'))return route.failure&&typeof route.failure==='object'?errorEvent(route.failure,'routing'):undefined;
  const spec=legacy.get(route.reason);if(!spec)return;
  const diagnostics=route.diagnostics,last=Array.isArray(diagnostics?.failures)?diagnostics.failures.at(-1):undefined;
  if(diagnostics?.recovered===true)return;
  const terminal=diagnostics?.recovered===false&&Number.isInteger(diagnostics.attempts)&&diagnostics.attempts>=1&&diagnostics.attempts<=2&&
    last?.attempt===diagnostics.attempts&&last.reason===route.reason&&last.diagnostic?.type==='error';
  if(!terminal&&!spec.questions.includes(route.question))return;
  // Timeout and protocol checks belong to the host; an earlier transport
  // failure must not replace the actual terminal result.
  const diagnostic=terminal&&!['routing_timeout','invalid_route_response'].includes(spec.code)?last.diagnostic:{code:spec.code};
  return errorEvent(diagnostic,'routing');
}
