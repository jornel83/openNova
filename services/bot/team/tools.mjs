import {createHash} from 'node:crypto';
export const TEAM_TOOLS=['team_list','team_member'];
export const TEAM_INSTRUCTIONS='团队工作：简单即时操作由你直接完成，保留操作记录；明确后台命令用 background_task_start，默认由你负责；多步骤工作先 team_list 查询员工，再用 background_agent_start 指定 assignedBotId。用户指定员工或要求你亲自处理优先，不得静默改派。派工成功后说明负责人和任务编号。workspaceMode=documents 用于指定项目内文本资料整理，inputFiles 明确指定输入，输出到任务目录；code 使用独立 Git 工作区。员工仅拥有列表中的任务类型，不能声称已开放浏览器或其他未接入能力。team_member 仅在用户要求创建或更新员工时使用。M1 成果由用户查看，自动总管验收尚未启用。';
export function teamTools(team,getRequest){return [
  ['team_list','查看团队员工的真实身份、职责、任务类型和状态。',{},()=>team.view()],
  ['team_member','按用户要求创建或更新员工。更新需使用 team_list 的 id 和 revision；有未完成任务的员工不能停用。',{
    action:{type:'string',enum:['create','update'],required:true},id:{type:'string'},revision:{type:'number'},name:{type:'string',required:true},role:{type:'string',required:true},instructions:{type:'string',required:true},taskTypes:{type:'array',items:{type:'string',enum:['code','documents','command']},required:true},enabled:{type:'boolean'}
  },a=>{const r=getRequest();if(!r||r.cancelled)throw Error('bridge_request_required');return team.mutate({...a,actionId:createHash('sha256').update(r.id+'\0'+JSON.stringify(a)).digest('hex')});}],
];}
