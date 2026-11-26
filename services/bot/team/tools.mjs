import {createHash} from 'node:crypto';
export const TEAM_TOOLS=['team_list','team_member','team_overview','team_watch_policy','team_watch_ack'];
export const TEAM_INSTRUCTIONS='团队工作：简单即时操作由你直接完成，保留操作记录；明确后台命令用 background_task_start，默认由你负责；多步骤工作先 team_list 查询员工，再用 background_agent_start 指定 assignedBotId。员工职责与 taskTypes 擅长方向只用于分工，不限制任务场景和工具权限；未选擅长方向表示通用员工。用户指定员工或要求你亲自处理优先，不得静默改派。派工成功后说明负责人和任务编号。新任务默认 permission=full（Full Access），可使用已经接入并获授权的工具，并访问当前系统用户有权访问的任意本机目录；不需要仅因路径在任务目录外而再次授权。只有用户明确要求只读、不写任何文件时才选择 read-only；只读文件访问仍限任务目录。Full Access 不覆盖用户明确的任务限制，例如不改原工程、不重启服务。任务模板只决定工作目录和输入：workspaceMode=general 是默认通用独立目录，inputFiles 可选；documents 复制明确指定的项目内文本资料，code 使用独立 Git 工作区。生成文件不等于修改原资料，交付成果默认保存在任务目录；用户指定其他交付路径时按其要求保存。原工程及日志可直接按实际路径读取，inputFiles 只接受项目内相对路径用于复制输入，不是 Full Access 的访问白名单。任务需要外部文件时，将绝对路径写入 goal 或 constraints 交给员工直接读取，不把外部路径塞入 inputFiles。是否可运行命令、联网或操作浏览器由执行权限和实际工具接入决定，不能依据模板名称判断。工具未接入、账号未授权或浏览器未连接时如实说明，不声称已完成。team_member 仅在用户要求创建或更新员工时使用。新后台业务任务无论由员工还是总管亲自执行，都默认由独立只读后台验收会话检查，可有限返工；任务执行完成与成果验收通过分开。acceptanceCriteria 应从用户目标提取明确交付要求，不能凭空增加工作。总管亲自执行的成果也必须经过独立验收会话读取成果与执行证据，不能在执行回复中自行宣布已验收。验收通过自动记录，只在证据不足或需要用户判断时交给用户；用户明确关闭自动检查时保留手动验收。用户要求改派或设置前置任务时使用相应工具，改派先停旧执行，依赖等待已验收成果。后台总管不会占用或冒充当前语音对话。';
export const TEAM_WATCH_INSTRUCTIONS='用户询问团队进度、今天完成什么、谁在忙、哪些事需要处理时，先调用 team_overview 获取全量统计，不得用 background_task_list 的第一页推断全部。period=today 只限定完成和验收记录的日期，进行中和待处理始终是当前状态；分清执行完成与验收通过。accepted 是当前轮的持久化验收记录数，不代表所有历史文件刚刚重新核验；近期成果 reviewStatus=stale 时说明成果有变化。值守只是基于状态的提醒，长时间无进展不等于失败。只有用户明确要求才修改 team_watch_policy 或确认提醒 team_watch_ack；先查当前 revision/提醒绑定。不因提醒自行重跑、改派、提升权限或扩大预算。';
export function teamTools(team,getRequest){
  const action=(label,args)=>{const request=getRequest();if(!request||request.cancelled)throw Error('bridge_request_required');if(request.actor&&request.actor.kind!=='user')throw Error('actor_denied');return createHash('sha256').update(request.id+'\0'+label+'\0'+JSON.stringify(args)).digest('hex');};
  return [
  ['team_list','查看团队员工的真实身份、职责、擅长方向和状态。擅长方向不限制任务类型或执行权限。',{},()=>team.view()],
  ['team_overview','查询团队全量任务统计、进行中、待处理、近期成果和总管值守提醒。汇总范围不受任务列表分页限制；已验收数是当前轮验收记录，详情中的 stale 表示成果已变化。',{
    ownerId:{type:'string',description:'可选员工ID，省略为全团队。'},period:{type:'string',enum:['all','today'],description:'默认all；today以本机时区统计当前轮今天完成/验收的任务。'},limit:{type:'integer',description:'各分组明细条数1–50，默认6；统计总数不受限制。'}
  },a=>team.overview.view(a)],
  ['team_watch_policy','仅按用户明确要求调整总管值守规则。先 team_overview 查看policy.revision；默认只提醒，可显式开启逾期排队任务提优先级。时间单位毫秒，不改变执行预算。',{
    revision:{type:'integer',required:true},enabled:{type:'boolean'},dueSoonMs:{type:'integer'},blockedMs:{type:'integer'},inactiveMs:{type:'integer'},raiseQueuedPriority:{type:'boolean'}
  },a=>team.tasks.watch.configure({...a,actionId:action('watch-policy',a)})],
  ['team_watch_ack','用户表示已知晓某条值守提醒时，确认当前版本提醒；只消除该条未确认提醒，不完成、取消或继续任务。先查询提醒的精确绑定。',{
    id:{type:'string',required:true},taskId:{type:'string',required:true},runId:{type:'string',required:true},assignmentVersion:{type:'integer',required:true}
  },a=>team.tasks.watch.acknowledge({...a,actionId:action('watch-ack',a)})],
  ['team_member','按用户要求创建或更新员工。更新需使用 team_list 的 id 和 revision；有未完成任务的员工不能停用。',{
    action:{type:'string',enum:['create','update'],required:true},id:{type:'string'},revision:{type:'number'},name:{type:'string',required:true},role:{type:'string',required:true},instructions:{type:'string',required:true},taskTypes:{type:'array',items:{type:'string',enum:['code','documents','command']},description:'可选擅长方向，仅用于分工，不限制权限。创建时省略或空数组表示通用；更新时省略保留原值。'},enabled:{type:'boolean'}
  },a=>{const r=getRequest();if(!r||r.cancelled)throw Error('bridge_request_required');return team.mutate({...a,actionId:createHash('sha256').update(r.id+'\0'+JSON.stringify(a)).digest('hex')});}],
];}
