/** Skills share the original dialogue channel and never create their own employee identity. */
import {createHash} from 'node:crypto';
export const SKILL_TOOLS=['skill','skill_list','skill_extract','skill_manage'];
export const SKILL_INSTRUCTIONS='技能：先 skill_list 查看当前技能、版本及员工绑定；明确匹配技能时先用 skill 加载完整说明。派工可用 skillNames 指定已绑定技能，空数组表示不使用；技能内容与资源按执行轮固定。技能仅提供工作方法，不扩大原任务范围、执行权限、预算或验收要求。用户要求保存做法时先查询已验收任务生成的候选，再用 skill_manage promote；尚无候选或提炼失败时，先查询任务详情取得当前 taskId/runId/reportId/reviewId，用 skill_extract 在后台只读整理，完成后再保存。提炼成功只代表草稿已准备好，不代表已启用；更新、停用、回退和员工绑定均遵从用户要求。不要把一次成功说成通用可靠能力；私有资料、凭据和具体用户事实不写入共享技能。视频生成通过使用 video-production 的后台任务完成；优先用 video_generate 接受提示词或首帧，宿主按原任务编号跟进，收到 MP4 回执后交付。';
export function skillTools(skills,getRequest){
  const actionId=(name,args)=>{
    const request=getRequest();if(!request||request.cancelled||request.signal?.aborted)throw Error('bridge_request_required');
    return createHash('sha256').update(request.id+'\0'+name+'\0'+JSON.stringify(args)).digest('hex');
  };
  return [
    ['skill_list','查询可用技能、版本、待保存经验及员工技能绑定。',{botId:{type:'string'},includeDisabled:{type:'boolean'}},args=>skills.catalog(args)],
    ['skill_extract','从指定已验收成果后台整理技能草稿；不重新执行原任务。先查询任务详情取得当前来源标识。',{
      taskId:{type:'string',required:true},runId:{type:'string',required:true},reportId:{type:'string',required:true},reviewId:{type:'string',required:true},
    },args=>skills.candidate({...args,actionId:actionId('extract',args)})],
    ['skill_manage','按用户要求保存或启用技能、停用、回退、配置员工技能或自动沉淀规则。先查询当前 revision 和候选来源。',{
      action:{type:'string',required:true,enum:['save','promote','enable','disable','rollback','assign','policy']},
      name:{type:'string'},description:{type:'string'},content:{type:'string'},revision:{type:'number',description:'更新技能时填目标正式技能的 revision；保存全新名称时省略或填 0，不使用候选 revision。assign 使用员工 assignment.revision，policy 使用 policy.revision。'},candidateId:{type:'string'},
      version:{type:'string'},botId:{type:'string'},names:{type:'array',items:{type:'string'}},autoCandidate:{type:'boolean'},autoEnable:{type:'boolean'},
    },args=>skills.mutate({...args,actionId:actionId('manage',args)})],
  ];
}
