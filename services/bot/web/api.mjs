import {readEvents} from './events.mjs';
export const labels={browser_disconnected:'浏览器扩展未连接。请打开已配对的 Chrome，再点击打开工作窗口；文字和本地文件仍可使用。',browser_not_enabled:'当前 Bot 未启用浏览器接入。结束当前任务后用 start.command --ui 重启服务。',browser_open_unknown:'开窗结果暂未确认。请查看 Chrome；再次点击只会补齐缺失窗口。',voice_unavailable:'语音进程未连接，请在终端启动语音。',stale_voice_control:'语音状态已变化，请重试当前操作。',voice_control_busy:'语音控制正在处理中，请稍候。',bot_busy:'OpenNova 正在处理另一条消息，请稍后再试。',file_conflict:'文件已被其他操作修改。请让 OpenNova 重新读取并提出修改。',
  approval_not_pending:'这项修改已经处理，请查看最新状态。',unknown_id:'没有找到这条记录。',host_stopping:'服务正在停止，请重新启动 Bot。',
  memory_match_changed:'原记忆已经变化，请重新提出修改。',invalid_request:'消息不能为空，且不能超过 8000 个字符。',
  cancelled:'回复已停止。',interrupted:'服务曾重启，这条回复未完成。',agent_timeout:'本轮回复超时，请重试。'};
Object.assign(labels,{timeout:'本次检索超时，已保留取得的资料。',budget_exhausted:'本轮检索预算已用尽，正在整理已有资料。',empty:'未取得可用的搜索结果或正文。',blocked:'网站暂时无法读取。',rate_limited:'搜索服务暂时限流。',auth:'搜索账号权限或额度不可用。',read_failures:'连续读取失败，已停止继续读取。',duplicate_research_call:'本轮已查询过该内容。'});
export const errorText=error=>labels[error?.code||error?.message]||'操作未完成：'+(error?.message||'请检查 Bot 服务后重试。');

export class WebApi {
  constructor(base=''){this.base=base;}
  async session(){
    const response=await fetch(this.base+'/web/session',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-OpenNova-Web':'1'},body:'{}',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('无法连接网页会话，请使用启动脚本显示的本机地址。');
    this.csrf=(await response.json()).csrf;
  }
  async events(cursor,onEvent,{signal,retry=true}={}){
    if(!this.csrf)await this.session();signal?.throwIfAborted();
    const response=await fetch(this.base+'/web/events',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-OpenNova-Web':'1','X-OpenNova-CSRF':this.csrf},body:JSON.stringify({cursor}),signal});
    if(response.status===401&&retry){await this.session();return this.events(cursor,onEvent,{signal,retry:false});}
    if(!response.ok)throw Error((await response.json()).error||'event_stream_failed');
    return readEvents(response,onEvent,{cursor,signal});
  }
  async call(name,body={},retry=true){
    if(!this.csrf)await this.session();
    let response;
    try{response=await fetch(this.base+'/web/api/'+name,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-OpenNova-Web':'1','X-OpenNova-CSRF':this.csrf},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});}
    catch{throw Object.assign(Error('连接中断，请检查 Bot 服务；重新连接后可以继续查看结果。'),{code:'network'});}
    if(response.status===401&&retry){await this.session();return this.call(name,body,false);}
    const value=await response.json();
    if(!response.ok)throw Object.assign(Error(value.error||'请求失败'),{code:value.error||'request_failed'});
    return value;
  }
}
