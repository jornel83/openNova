import {createHash} from 'node:crypto';
export const TEAM_TOOLS=['team_list','team_member'];
export const TEAM_INSTRUCTIONS='团队工作：简单即时操作由你直接完成，保留操作记录；明确后台命令用 background_task_start，默认由你负责；多步骤工作先 team_list 查询员工，再用 background_agent_start 指定 assignedBotId。员工职责与 taskTypes 擅长方向只用于分工，不限制任务场景和工具权限；未选擅长方向表示通用员工。用户指定员工或要求你亲自处理优先，不得静默改派。派工成功后说明负责人和任务编号。新任务默认 permission=full，可使用已经接入并获授权的工具；只有用户明确要求只读、不写任何文件时才选择 read-only。任务模板只决定工作目录和输入：workspaceMode=general 是默认通用独立目录，inputFiles 可选；documents 复制明确指定的项目内文本资料，code 使用独立 Git 工作区。生成文件不等于修改原资料，交付成果保存在任务目录。是否可运行命令、联网或操作浏览器由执行权限和实际工具接入决定，不能依据模板名称判断。工具未接入、账号未授权或浏览器未连接时如实说明，不声称已完成。team_member 仅在用户要求创建或更新员工时使用。M1 成果由用户查看，自动总管验收尚未启用。';
export function teamTools(team,getRequest){return [
  ['team_list','查看团队员工的真实身份、职责、擅长方向和状态。擅长方向不限制任务类型或执行权限。',{},()=>team.view()],
  ['team_member','按用户要求创建或更新员工。更新需使用 team_list 的 id 和 revision；有未完成任务的员工不能停用。',{
    action:{type:'string',enum:['create','update'],required:true},id:{type:'string'},revision:{type:'number'},name:{type:'string',required:true},role:{type:'string',required:true},instructions:{type:'string',required:true},taskTypes:{type:'array',items:{type:'string',enum:['code','documents','command']},description:'可选擅长方向，仅用于分工，不限制权限。创建时省略或空数组表示通用；更新时省略保留原值。'},enabled:{type:'boolean'}
  },a=>{const r=getRequest();if(!r||r.cancelled)throw Error('bridge_request_required');return team.mutate({...a,actionId:createHash('sha256').update(r.id+'\0'+JSON.stringify(a)).digest('hex')});}],
];}
