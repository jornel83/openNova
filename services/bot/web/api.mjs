import {readEvents} from './events.mjs';
import {diagnosticHint,diagnosticText,errorEvent} from '../../agent/errors.mjs';
const voiceDeviceLabels={voice_device_settings_changed:'设备设置已在其他窗口更新，请刷新并核对后保存。',voice_device_not_available:'所选设备已断开或不支持这个方向，请刷新设备列表。',voice_control_unavailable:'音频正在准备，请稍后再操作。',voice_devices_unsupported:'设备选择目前支持 macOS，请使用系统声音设置。',voice_devices_build_failed:'音频设备组件准备失败，请检查终端中的提示后重试。',voice_devices_unavailable:'暂时无法读取设备列表，请确认设备连接后刷新。',voice_device_settings_save_failed:'设备选择保存失败，请检查本地数据目录后重试。',voice_device_settings_invalid:'已保存的设备设置无法读取，请检查本地配置。',invalid_voice_devices:'设备选择无效，请刷新后重新选择。'};
export const labels={
  invalid_project_edition:'这份成果引用无效，请重新打开原对话中的版本记录。',
  candidate_review_not_configured:'当前实例尚未登记候选版验收程序，请检查 Bot HOME 下的 candidate-review.json。',
  candidate_review_project_mismatch:'验收程序登记在另一个项目，请核对当前项目。',
  invalid_candidate_review_task:'候选验收需要使用独立代码工作树和可执行命令的权限。',
  invalid_candidate_review_profile:'候选验收配置无效，请核对项目、验证程序、回执目录和必测项。',
  candidate_command_missing:'本轮没有执行登记的候选验收命令。',
  candidate_final_command_failed:'最后一次候选验收命令执行失败。',
  candidate_patch_mismatch:'通过验证的补丁与本次提交的补丁不一致。',
  candidate_regression_missing_or_stale:'缺少针对最终补丁的成功回归记录。',
  candidate_workspace_mismatch:'回执中的源码基线或候选工作目录与本轮任务不符。',
  candidate_receipt_not_from_command:'回执时间与本轮验证命令不符。',
  candidate_chat_failed:'候选网页的文字回复未通过回显检查。',
  candidate_cleanup_unconfirmed:'候选服务端口的清理尚未得到确认。',
  candidate_evidence_unavailable:'候选回执或所需日志不可读取。',
  document_proposal_not_found:'当前项目找不到这份修改对照，请重新打开原对话。',invalid_document_proposal:'无法读取这份修改对照，请刷新后重试。',
  invalid_document_inputs:'请检查资料的类型和路径。通用模板最多 20 个文件，每个最多 20 MiB。文件研究最多 10 个文件，原生文档每个最多 20 MiB，文本每个最多 64 KiB。',
  ambiguous_task_input:'项目中有多个同名文件，请填写具体路径。',
  task_input_not_found:'项目中找不到这份研究资料，请核对文件名或路径。',
  task_input_search_incomplete:'项目文件较多，请填写资料的具体路径。',
  task_input_snapshot_corrupt:'启动时保存的资料副本无法核实，请检查任务记录。',
  current_file_required:'请先在 Nova 中关联一份文件，或输入文件名或路径。',
  task_document_input_output_conflict:'交付位置与输入文件相同，请为成品选择新文件名。',
  invalid_document_output:'请输入以 .docx 或 .pdf 结尾的新文件路径。',
  document_target_exists:'交付位置已有文件，请选择新的保存位置。',
  task_inputs_too_large:'研究资料超过大小限制，请减少输入文件。',
 task_summary_recovery_unavailable:'当前成果或执行状态已变化，不能仅补汇总。请刷新并核对原记录。',review_retry_unavailable:'当前验收已变化或暂不可恢复，请刷新后核对。',browser_disconnected:'浏览器扩展未连接。请打开已配对的 Chrome，再点击打开工作窗口；文字和本地文件仍可使用。',browser_not_enabled:'当前 Bot 未启用浏览器接入。结束当前任务后用 start.command --ui 重启服务。',browser_open_unknown:'开窗结果暂未确认。请查看 Chrome；再次点击只会补齐缺失窗口。',voice_unavailable:'语音进程未连接，请在终端启动语音。',stale_voice_control:'语音状态已变化，请重试当前操作。',voice_control_busy:'语音控制正在处理中，请稍候。',bot_busy:'OpenNova 正在处理另一条消息，请稍后再试。',file_conflict:'文件已被其他操作修改。请让 OpenNova 重新读取并提出修改。',
  approval_not_pending:'这项修改已经处理，请查看最新状态。',unknown_id:'没有找到这条记录。',host_stopping:'服务正在停止，请重新启动 Bot。',
  memory_match_changed:'原记忆已经变化，请重新提出修改。',invalid_request:'消息不能为空，且不能超过 8000 个字符。',
  cancelled:'回复已停止。',interrupted:'服务曾重启，这条回复未完成。',agent_timeout:'本轮回复超时，请重试。'};
Object.assign(labels,{timeout:'本次检索超时，已保留取得的资料。',budget_exhausted:'本轮检索预算已用尽，正在整理已有资料。',empty:'未取得可用的搜索结果或正文。',blocked:'网站暂时无法读取。',rate_limited:'搜索服务暂时限流。',auth:'搜索账号权限或额度不可用。',read_failures:'连续读取失败，已停止继续读取。',duplicate_research_call:'本轮已查询过该内容。'});
Object.assign(labels,voiceDeviceLabels);
Object.assign(labels,{image_artifact_changed:'这版文件已被移动或修改。请重新选择项目文件。',image_preview_unavailable:'找不到这版生成文件。',project_state_changed:'当前项目已切换，请刷新后再试。'});
Object.assign(labels,{
  edit_reference_required:'请先选择要修改的图片。',image_reference_changed:'参考图已更新，请重新选择版本。',
  image_credential_missing:'尚未配置图片生成所需的方舟凭据。',media_target_exists:'同名文件已经存在，请使用新版本文件名。',
  ark_request_rejected:'方舟拒绝了这次生成请求。',generation_completion_unknown:'图片生成请求的结果待核对，请先查看生成记录。',
  image_completion_unknown:'图片生成请求的结果待核对，请先查看生成记录。',
  spark_image_submit_unconfirmed:'Spark 的提交结果待确认，OpenNova 会查询原任务。',
  spark_image_status_unavailable:'暂时无法连接 Spark，恢复连接后将继续跟进原任务。',
  spark_image_download_pending:'正在从 Spark 取回同一任务的图片。',
  unsupported_spark_image_size:'Spark 文生图和方图编辑原生输出 2048×2048，竖图编辑原生输出 864×1536。可用 width 和 height 指定交付尺寸。',
  unsupported_spark_reference_aspect_ratio:'Minimax H3 Image 编辑需要一张方图或 9:16 竖图。',
  spark_reference_size_mismatch:'size 和参考图比例不匹配。可省略 size，让 Spark 按参考图选择原生尺寸。',
  invalid_spark_image_reference_count:'Minimax H3 Image 编辑需要一张参考图；文生图无需参考图。',
  spark_image_gpu_reserved:'Spark GPU 正在执行另一项独占任务。',
  spark_image_deployment_unavailable:'Spark 图片模型服务暂时不可用。',
  image_snapshot_model_unavailable:'当前版本的图片制作技能缺少该模型，请核对技能版本。'
});
Object.assign(labels,{
  gif_reference_required:'请先选中要做成动图的静态图。',
  gif_credential_missing:'尚未配置 GIF 生成所需的方舟凭据。',
  gif_credential_invalid:'GIF 生成所用的方舟凭据不可用。',
  gif_submission_unknown:'方舟提交结果待核对，请查看操作记录。',
  gif_completion_unknown:'方舟任务结果待核对，请查看操作记录。',
  gif_status_query_pending:'暂时无法查询 Seedance，OpenNova 会继续跟进同一任务。',
  gif_download_pending:'视频暂时无法下载，OpenNova 会继续取回同一任务的视频。'
});
Object.assign(labels,{
  invalid_task_media:'请核对任务的媒体操作、角色和项目路径。',
  task_media_permission_denied:'当前任务权限不允许媒体操作。',
  task_media_skill_required:'请先为任务负责人绑定 image-production 技能。',
  image_production_skill_required:'当前执行轮未绑定 image-production 技能。',
  task_media_receipt_unavailable:'没有找到已完成的媒体回执。请查看执行记录。',
  task_media_submission_unknown:'生成提交结果待核对。请先核对远端记录，避免重复提交。',
  task_media_follow_timeout:'等待远端结果已超时。请先查询原任务。',
  task_media_prior_operation_requires_review:'本任务已有生成尝试。请先核对原操作记录。',
  task_media_input_changed:'项目素材在任务提交后已变化，请核对原素材版本。',
  task_media_project_changed:'任务绑定的项目或目录已变化，请核对后处理。',
});
Object.assign(labels,{network_error:'无法连接 ChatGPT，请检查当前网络或代理后重试。',connection_error:'无法连接 ChatGPT，请检查当前网络或代理后重试。',stream_interrupted:'ChatGPT 连接在回复完成前中断，请稍后重试。',incomplete_agent_turn:'本轮模型回复未完整完成，请重试；已执行的操作可在记录中查看。'});
Object.assign(labels,{title_only:'页面只有标题，没有可用正文。',encoding_error:'来源编码异常，未作为有效证据。',invalid_json:'接口响应不是有效 JSON。',http_failed:'脚本中的取数未完成，请查看 HTTP 记录。',script_failed:'研究脚本未成功完成。',input_artifact_changed:'输入文件已变化，请重新核对。'});
Object.assign(labels,{
  project_state_changed:'当前项目或话题已变化，请刷新并核对项目后重新提交。',
  project_task_mismatch:'该任务属于其他项目，请切换到任务所属项目后再操作。',
  project_object_changed_read_again:'当前引用文件已变化，请重新读取最新内容后再修改。',
  task_inputs_changed:'输入资料在排队期间已变化，请核对最新内容后重新提交任务。',
  project_work_request_required:'请从项目入口选择或接续工作项目后再创建任务。',
  project_required:'请先选择要使用的项目。',
  project_archived:'这个项目已归档，请恢复项目或选择其他项目后再操作。',
  invalid_project_directory:'项目目录不存在或无法使用，请选择已有目录，也可以留空。',
  project_directory_unavailable:'项目目录暂时不可用，请在项目概览修正目录；原项目和后台任务记录仍保留。',
});
export function errorText(error){
  if(error?.diagnostic)return diagnosticText(error.diagnostic);
  const diagnostic=errorEvent(error,error?.stage);
  if(diagnostic.stage!=='agent')return diagnosticText(diagnostic);
  const label=labels[error?.code]||labels[error?.message];
  if(label)return label;
  if(diagnostic.code!=='agent_runtime_failed'||[error?.code,error?.message].includes('agent_runtime_failed'))return diagnosticHint(diagnostic);
  return '操作未完成：'+(error?.message||'请检查 Bot 服务后重试。');
}
Object.assign(labels,{invalid_task_closure:'任务关闭信息不完整，请刷新后重试。',task_closed:'任务正在关闭或已关闭；请先恢复到任务列表，再决定是否执行。',task_reopen_unavailable:'任务尚未完成关闭，请等待清理完成后再恢复。',task_assignment_changed:'任务负责人已变化，请刷新后核对。'});
Object.assign(labels,{task_dependency_closed:'前置任务已关闭，请先恢复该任务，或重新选择前置成果。',event_source_closed:'事件来源任务已关闭，请选择仍开放的来源。'});
Object.assign(labels,{invalid_team_overview:'团队查询条件无效，请刷新后重试。',invalid_watch_page:'值守提醒查询条件无效。',invalid_watch_policy:'值守设置无效；时间须为 0（停用）或 1 秒至 7 天。',watch_policy_changed:'值守设置已被更新，请刷新后重新修改。',watch_action_conflict:'这次操作编号已被使用，请刷新后重新操作。',watch_alert_stale:'提醒对应的任务或执行轮已变化，请查看最新状态。',unknown_watch_alert:'未找到这条值守提醒，请刷新。',invalid_watch_ack:'提醒信息不完整，请刷新后重试。'});
Object.assign(labels,{unknown_skill:'未找到这项技能，请刷新技能库。',unknown_skill_version:'未找到这个技能版本，请刷新版本记录。',skill_changed:'技能已被更新，已重新读取，请核对后再操作。',skill_assignment_changed:'员工技能配置已变化，请刷新后重新选择。',skill_policy_changed:'经验沉淀设置已变化，请刷新后重新保存。',skill_action_conflict:'这次操作与已保存请求不一致，请刷新后重试。',invalid_skill_name:'技能名称须为小写字母、数字及短横线，最多 32 个字符。',invalid_skill:'请填写有效的技能名称、适用场景和工作方法。',invalid_skill_selection:'技能选择无效，请重新选择。',skill_not_available:'这项技能未启用或尚未分配给当前负责人，请检查员工技能配置。',skill_content_unavailable:'技能正文暂不可读取，请刷新版本记录。',skill_source_not_accepted:'来源成果尚未验收通过，请查看当前成果。',skill_source_changed:'来源成果或验收已变化，请核对最新版本后重新整理。',skill_candidate_already_promoted:'这份经验已保存为技能，请刷新查看。',unknown_skill_candidate:'未找到这份经验候选，请刷新后重试。',skill_candidate_not_ready:'工作方法仍在整理中，完成后才能保存为技能。',skill_extraction_failed:'工作方法未能整理完成，可以重新整理。',skill_snapshot_changed:'本轮技能文件已有变化，请核对技能版本后再接续。',video_credentials_unavailable:'尚未配置视频服务凭据，请在本机配置后重试。',video_skill_required:'当前任务尚未使用视频制作技能。',video_submission_not_confirmed:'视频提交结果尚未确认，请先核对原远端任务，避免重复提交。',video_actor_stale:'任务执行轮已变化，请查看最新进度。',video_permission_denied:'当前任务的执行权限不允许这项视频操作。'});
// browserHandler rejects these credentials before dispatching any operation. A
// different tab may already have refreshed the shared cookie after a restart,
// leaving this tab's CSRF stale; other 403 errors must never replay an operation.
const sessionExpired=(response,value)=>response.status===401||(response.status===403&&value?.error==='unauthorized');
Object.assign(labels,{unsupported_file_type:'当前文件类型暂不支持直接打开，请按结果路径查看。',open_failed:'本机应用未能打开文件，请检查文件类型与默认应用。',open_timeout:'打开请求暂未确认，请检查本机应用。'});
Object.assign(labels,{
  invalid_document_revision_source:'请指定当前项目中由 Nova 生成的 Word 或 PDF。',
  document_proposal_action_failed:'暂时无法核对操作结果，请刷新对话后重试。',
  document_proposal_closed:'这份方案已处理，请查看对照卡上的最新状态。',
  document_proposal_busy:'这份方案正在处理，请稍后查看结果。',
  document_undo_source_changed:'当前版本已在磁盘上被修改，本次撤销已停止。请保留手改文件并核对内容。',
  document_undo_not_latest:'这次修改之后已有新版，请到最新一次修改的卡片查看。',
  document_undo_snapshot_unavailable:'无法核对应用前的文档快照，本次撤销已停止。',
  document_proposal_not_applied:'请打开最新一次已应用的文档修改。',
  document_proposal_changed:'修改方案已变化，请重新核对对照。',
  document_proposal_invalid:'暂时无法核对这份方案保存的内容，请重新提出修改。',
  document_rebase_already_matches:'磁盘文件已包含方案中的全部修改，无需生成新版。',
  document_rebase_unavailable:'暂时无法从当前文件可靠地生成对照。请核对文件内容，保存后可再次核对。',
  document_revision_source_changed:'文件内容或版本已变化。请核对当前文件后重新提出修改。',
  document_revision_source_missing:'原位置已找不到文件。请核对文件位置或恢复原件后重新提出修改。',
  document_revision_not_latest:'已有更新版本。请基于最新版本重新提出修改。',
  document_revision_artifact_not_found:'当前项目中没有找到这份文件的生成记录。',
  document_revision_ambiguous_source:'这个位置对应多个生成记录，请指定要编辑的成果编号。',
  document_revision_spec_unavailable:'无法核对生成时保存的内容规格，本次未修订。',
  document_revision_lineage_unavailable:'无法确认成果版本的来历，本次未修订。',
});
Object.assign(labels,{
  gif_review_animation_required:'这份 GIF 只有一帧，无法抽帧审阅动作。',gif_review_source_unavailable:'找不到这个项目里的 GIF，请核对文件路径。',
  gif_review_source_changed:'GIF 文件已变化，请重新选择要审阅的版本。',gif_review_unreadable:'未能确认检查页的画面内容；没有记录为通过。',
  gif_review_invalid_model_receipt:'读取器没有给出可核对的帧索引，本次审阅未完成。',gif_review_limit_exceeded:'这份 GIF 超过抽帧审阅的帧数或画面大小限制。',
});

Object.assign(labels,{invalid_task_command:'请填写任务名称和命令。',invalid_task_workdir:'请选择当前项目内存在的目录。',invalid_task_timeout:'运行时限应在 1 秒到 2 小时之间。',invalid_task_artifacts:'结果文件请使用项目内相对路径，最多 20 项。',task_id_conflict:'这次提交与已有任务不一致，请查看原任务。',task_run_changed:'任务已经开始新的执行，请刷新后操作。',task_retry_unavailable:'当前任务尚不能重试，请先核对是否已停止。',task_queue_full:'待处理任务已达上限，请先完成或取消部分任务。',unknown_task:'没有找到这项任务。',task_artifact_missing:'结果文件尚未生成或不可读取。',task_artifact_changed:'结果文件已发生变化，请重新核对后打开。'});
Object.assign(labels,{invalid_skill_candidate:'经验整理请求不完整，请刷新成果后重试。',skill_candidate_changed:'经验候选已有更新，请刷新后核对。',skill_candidate_source_changed:'经验来源已变化，请重新核对当前成果。',skill_candidate_private_literal:'工作方法中仍包含个人路径或凭据内容，请调整后重新整理。',video_followup_retry:'暂时未能刷新远端进度，后台会继续查询同一个任务。'});

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
    if(!response.ok){
      const value=await response.json();
      if(retry&&sessionExpired(response,value)){await this.session();return this.events(cursor,onEvent,{signal,retry:false});}
      throw Error(value.error||'event_stream_failed');
    }
    return readEvents(response,onEvent,{cursor,signal});
  }
  async call(name,body={},retry=true){
    if(!this.csrf)await this.session();
    let response;
    try{response=await fetch(this.base+'/web/api/'+name,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-OpenNova-Web':'1','X-OpenNova-CSRF':this.csrf},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});}
    catch{throw Object.assign(Error('连接中断，请检查 Bot 服务；重新连接后可以继续查看结果。'),{code:'network'});}
    if(response.ok&&['background-video-preview','image-preview','project-edition-file','experiment-evidence'].includes(name))return response.blob();
    const value=await response.json();
    if(retry&&sessionExpired(response,value)){await this.session();return this.call(name,body,false);}
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
Object.assign(labels,{
  invalid_acceptance_criteria:'验收标准应为不超过 8000 字的文字。',invalid_management_budget:'请检查总管跟进预算，自动返工次数应为 0–5 次。',invalid_management_policy:'请检查总管跟进设置与预算范围。',
  team_supervisor_unavailable:'总管跟进服务尚未就绪，请检查服务版本。',management_budget_exhausted:'总管跟进额度已用尽，请查看成果并决定下一步。',management_task_not_configurable:'内部检查任务由总管统一管理，请操作原员工任务。',
  invalid_review_action:'请选择验收通过、返工或补充回答。',invalid_review_summary:'请填写处理说明（最多 4000 字）。',review_instruction_required:'请说明返工要求或补充回答。',review_action_conflict:'本次处理与之前提交不同，请核对最新成果。',
  review_stale:'成果或任务已更新，请查看最新版本后处理。',team_report_stale:'当前成果已不是最新版本，请刷新后核对。',unknown_team_report:'没有找到这版成果，请刷新任务。',team_report_artifact_changed:'成果文件或原件已有变化，请核对后形成新成果再处理。',
  report_not_ready_for_acceptance:'当前成果尚不具备验收条件，请核对执行状态、退出码和交付文件。',report_has_no_question:'本版成果没有待回答的问题；如需调整，请填写返工要求。',review_cleanup_unconfirmed:'原作业是否停止尚未确认，暂不能接续或返工。',
  review_paused_requires_explicit_decision:'总管检查曾暂停，请查看成果后明确下一步。',review_evidence_changed:'验收证据文件已有变化，请重新核对成果。',
  invalid_task_dependencies:'请选择最多 20 项有效前置任务，并检查优先级与截止时间。',task_dependency_cycle:'前置任务不能形成循环依赖，请调整选择。',task_dependencies_locked:'任务已开始执行，当前不能修改前置任务。',task_dependencies_require_agent:'前置成果依赖只适用于 Agent 工作任务。',
  invalid_task_handoff:'请选另一位可用员工并填写交接说明（最多 4000 字）；正在交接的任务请等待完成。',
  accepted_report_evidence_changed:'已验收成果的文件或证据发生变化，请重新核对。',management_review_incomplete:'总管检查未完整完成，请查看成果并决定下一步。',review_verification_incomplete:'命令或检查尚未全部通过，请核对执行证据后返工。',review_requires_concrete_evidence:'总管需要实际成果或执行证据，不能只凭完成摘要验收。',review_artifact_not_readable:'当前成果格式无法由总管自动核验，请人工查看后决定。',
});
