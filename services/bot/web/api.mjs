import {readEvents} from './events.mjs';
import {diagnosticText} from '../../agent/errors.mjs';
export const labels={browser_disconnected:'浏览器扩展未连接。请打开已配对的 Chrome，再点击打开工作窗口；文字和本地文件仍可使用。',browser_not_enabled:'当前 Bot 未启用浏览器接入。结束当前任务后用 start.command --ui 重启服务。',browser_open_unknown:'开窗结果暂未确认。请查看 Chrome；再次点击只会补齐缺失窗口。',voice_unavailable:'语音进程未连接，请在终端启动语音。',stale_voice_control:'语音状态已变化，请重试当前操作。',voice_control_busy:'语音控制正在处理中，请稍候。',bot_busy:'OpenNova 正在处理另一条消息，请稍后再试。',file_conflict:'文件已被其他操作修改。请让 OpenNova 重新读取并提出修改。',
  approval_not_pending:'这项修改已经处理，请查看最新状态。',unknown_id:'没有找到这条记录。',host_stopping:'服务正在停止，请重新启动 Bot。',
  memory_match_changed:'原记忆已经变化，请重新提出修改。',invalid_request:'消息不能为空，且不能超过 8000 个字符。',
  cancelled:'回复已停止。',interrupted:'服务曾重启，这条回复未完成。',agent_timeout:'本轮回复超时，请重试。'};
Object.assign(labels,{timeout:'本次检索超时，已保留取得的资料。',budget_exhausted:'本轮检索预算已用尽，正在整理已有资料。',empty:'未取得可用的搜索结果或正文。',blocked:'网站暂时无法读取。',rate_limited:'搜索服务暂时限流。',auth:'搜索账号权限或额度不可用。',read_failures:'连续读取失败，已停止继续读取。',duplicate_research_call:'本轮已查询过该内容。'});
Object.assign(labels,{network_error:'无法连接 ChatGPT，请检查当前网络或代理后重试。',connection_error:'无法连接 ChatGPT，请检查当前网络或代理后重试。',stream_interrupted:'ChatGPT 连接在回复完成前中断，请稍后重试。',incomplete_agent_turn:'本轮模型回复未完整完成，请重试；已执行的操作可在记录中查看。'});
Object.assign(labels,{title_only:'页面只有标题，没有可用正文。',encoding_error:'来源编码异常，未作为有效证据。',invalid_json:'接口响应不是有效 JSON。',http_failed:'脚本中的取数未完成，请查看 HTTP 记录。',script_failed:'研究脚本未成功完成。',input_artifact_changed:'输入文件已变化，请重新核对。'});
export const errorText=error=>error?.diagnostic?diagnosticText(error.diagnostic):(labels[error?.code]||labels[error?.message]||'操作未完成：'+(error?.message||'请检查 Bot 服务后重试。'));
Object.assign(labels,{unsupported_file_type:'当前文件类型暂不支持直接打开，请按结果路径查看。',open_failed:'本机应用未能打开文件，请检查文件类型与默认应用。',open_timeout:'打开请求暂未确认，请检查本机应用。'});

Object.assign(labels,{invalid_task_command:'请填写任务名称和命令。',invalid_task_workdir:'请选择当前项目内存在的目录。',invalid_task_timeout:'运行时限应在 1 秒到 2 小时之间。',invalid_task_artifacts:'结果文件请使用项目内相对路径，最多 20 项。',task_id_conflict:'这次提交与已有任务不一致，请查看原任务。',task_run_changed:'任务已经开始新的执行，请刷新后操作。',task_retry_unavailable:'当前任务尚不能重试，请先核对是否已停止。',task_queue_full:'待处理任务已达上限，请先完成或取消部分任务。',unknown_task:'没有找到这项任务。',task_artifact_missing:'结果文件尚未生成或不可读取。',task_artifact_changed:'结果文件已发生变化，请重新核对后打开。'});

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

Object.assign(labels,{task_step_budget_exhausted:"本轮步骤预算已用尽，已保留进度；核对结果后可接续任务。",task_token_budget_exhausted:"本轮 Token 预算不足，已停止进一步调用；核对已有结果后可接续。",task_policy_not_ready:"任务规则未能加载，本轮未启动。请检查构建与任务日志。",unknown_task_step:"没有找到该命令步骤，请核对任务与执行记录。",invalid_agent_task:"请填写任务名称、目标和有效约束。",invalid_agent_budget:"请检查执行模式、步骤和 Token 预算。",invalid_task_message:"请填写有效的补充说明（最多 4000 字）。",task_message_limit:"补充记录已达上限。",task_workspace_busy:"请等待当前作业停止后再操作工作目录。",task_apply_conflict:"原工程中的文件已经变化，无法直接应用。请保留修改并手动核对。",task_diff_changed:"文件差异已变化，请重新查看差异后再应用。",task_diff_empty:"没有待应用的修改。",task_apply_unknown:"上次应用结果尚未确认，请先检查原工程文件。",task_apply_unsupported_file:"此修改包含符号链接或特殊文件，请在工作目录中手动审阅处理。",task_workspace_not_ready:"独立工作目录尚未准备完成。",workspace_preparation_interrupted:"工作目录准备曾中断，请核对目录与任务日志。"});

Object.assign(labels,{invalid_event_rule:'请填写有效的事件来源和处理要求。',invalid_event_budget:'接续次数应为 1–5 次，有效期应为 1–168 小时。',invalid_event_source:'请选择其他后台命令的明确执行记录。',invalid_event_paths:'请填写最多 10 个项目内普通文件，排除凭据、配置与构建目录。',event_rule_limit:'接续规则数量已达上限，请先关闭不用的规则。',event_check_rule_exists:'此任务已有启用的测试接续规则。',event_rule_changed:'规则已变化，请核对最新状态后重试。',event_rule_exhausted:'规则已过期或额度用尽。如需继续，请明确添加新规则。',event_path_outside_workspace:'监听路径不在项目内，或不是普通文件。',event_file_too_large:'监听文件超过 64 KB，请缩小到明确的文本文件。',event_source_limit:'此来源已达到 200 条事件上限，请核对后重新配置。',event_source_unavailable:'事件来源暂时不可读取，请检查路径或网络。',github_auth_required:'GitHub 授权不可用，请检查仓库外的只读凭据。',github_rate_limited:'GitHub 暂时限制读取频率，将稍后重试。',github_poll_failed:'GitHub 读取失败，请检查仓库、编号和读取权限。',github_token_must_be_external:'GitHub 授权文件必须保存在工程目录外。',invalid_github_token:'GitHub 授权文件格式不正确。',github_backlog_too_large:'GitHub 待检查评论超过读取上限，请关闭再重新启用规则以建立新起点。',invalid_github_source:'请填写 owner/repo 格式仓库和有效编号。',invalid_github_authors:'请填写允许触发接续的 GitHub 用户名。'});

Object.assign(labels,{
  team_disabled:'团队派工已关闭，总管仍可处理任务。',unknown_team_member:'员工不存在，请重新选择。',
  member_task_type_unavailable:'该员工未开放此类工作，请调整工作类型或负责人。',team_member_disabled:'员工已停用，请选择其他负责人。',
  team_member_changed:'员工资料已变化，请关闭编辑后重新打开。',team_name_taken:'员工姓名已存在，请选择其他姓名。',
  member_has_unfinished_tasks:'员工仍有未完成任务，请完成或取消后再停用。',team_has_unfinished_tasks:'团队仍有未完成任务，请处理后再关闭团队派工。',
  invalid_document_inputs:'请检查项目内输入路径。通用模板最多20个文件、每个20 MiB；文本资料模板最多10个文本文件、每个64 KiB。凭据、隐藏路径和符号链接不可作为输入。',
  invalid_team_member:'请填写有效的姓名、职责和工作要求；擅长方向可以不选。',actor_denied:'当前执行身份无权进行此操作。',
  documents_no_git_diff:'通用与资料任务的交付文件在结果区域查看，不应用到原工程。',
  invalid_task_permission:'请选择“完整执行”或“只读”权限。',conflicting_task_permission:'提交的执行权限与旧模式不一致，请刷新页面后重新创建任务。',
  invalid_workspace_mode:'请选择通用工作、代码工程或文本资料整理模板。',
  task_tool_denied:'当前任务未获准使用此工具。',task_host_tool_denied:'此任务的执行权限不包含该桌面工具。',
  task_runtime_unauthorized:'任务运行凭据无效，请核对当前执行记录。',task_runtime_stale:'任务已停止或开始了新的执行，本轮工具调用未继续。',
  actor_stale:'执行身份已过期，请刷新后核对当前任务。',actor_disabled:'该员工或团队已停用，任务不能继续执行。',
  task_tool_action_conflict:'这次工具请求与原操作不一致，请核对执行记录。',
  background_window_close_unavailable:'后台员工只能关闭本任务的标签页；共享工作窗口请交由总管处理。',
});
