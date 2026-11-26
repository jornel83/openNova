import {diagnosticHint,errorEvent} from '../../agent/errors.mjs';
import {projectRoutingFailure} from '../projects/routing-failure.mjs';

/** Read-only presentation of current failures and older completed routing failures. */
export function requestFailure(message){
  if(!['failed','completed'].includes(message?.status))return null;
  const routing=projectRoutingFailure(message.routing);
  if(message.status==='completed'&&!routing)return null;
  const value=message.diagnostic??routing??{code:message.error||'agent_runtime_failed',stage:'conversation'};
  const diagnostic=errorEvent(value,value.stage??'conversation');
  const details=[`错误代码：${diagnostic.code}`,diagnostic.status&&`HTTP ${diagnostic.status}`,diagnostic.requestId&&`服务请求：${diagnostic.requestId}`].filter(Boolean).join(' · ');
  return {diagnostic,text:diagnosticHint(diagnostic),details};
}
