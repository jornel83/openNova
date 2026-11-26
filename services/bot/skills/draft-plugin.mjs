/** A read-only learning session can return a draft, never change the enabled library. */
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readJson,saveJson,readSteps} from '../tasks/agent-files.mjs';
import {skillDocument,SKILL_FIELD_RULES} from './bundle.mjs';
export const name='opennova-skill-draft';
export const inject=['tools'];
export const DRAFT_INSTRUCTIONS='你是 OpenNova 总管的经验整理会话。读取 report.json 的真实任务目标、用户答复、工具步骤和检查证据，再按需要读取成果。提炼能在新输入上复用的方法：说明适用场景、输入参数、步骤顺序、实际有效的检查和已观察到的失败边界。具体人名、活动名、日期、机器目录和输入数据改成参数；不复制密钥、账号、原始私有资料或完整日志。不能仅罗列工具名或写万能模板，也不能把一次成功泛化成所有场景可靠。只调用 skill_draft 提交草稿，不执行原任务、不创建外部请求、不自行启用技能。name '+SKILL_FIELD_RULES.name+'中文标题与说明写入 description/content。若 skill_draft 返回字段校验错误，按提示修正字段，在当前会话再次调用 skill_draft；只有收到 submitted:true 才算草稿已提交。';
export async function apply(ctx,config){
  const {defineTool}=await import(pathToFileURL(join(config.harnessRoot,'packages/core/tools/lib/index.js')));
  const source=config.managementReview,path=join(config.runDir,'skill-draft.json');
  if(source?.kind!=='skill-extraction')throw Error('skill_extraction_required');
  ctx.effect(()=>ctx.tools.register(defineTool({name:'skill_draft',description:'提交从已验收证据提炼的技能草稿；包括适用条件、参数化步骤、验证方法及适用边界。',
    parameters:{name:{type:'string',required:true,description:SKILL_FIELD_RULES.name,examples:['csv-amount-summary']},
      description:{type:'string',required:true,description:SKILL_FIELD_RULES.description},content:{type:'string',required:true,description:SKILL_FIELD_RULES.content}},
    output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},execute:async draft=>{
      try{skillDocument(draft.name,draft.description,draft.content);}
      catch(error){
        if(!error.issues)throw error;
        throw Error('invalid_skill: '+error.issues.map(issue=>issue.field+': '+issue.message).join('；')+' 请修正上述字段后在当前会话再次调用 skill_draft；只有返回 submitted:true 才算提交成功。');
      }
      const previous=readJson(path);if(previous){if(JSON.stringify(previous.draft)!==JSON.stringify(draft))throw Error('skill_draft_already_submitted');return JSON.stringify({submitted:true});}
      const inspected=readSteps(config.runDir).some(step=>step.tool==='read'&&step.status==='completed'&&typeof step.arguments?.file_path==='string'&&resolve(config.workspace,step.arguments.file_path)===join(config.workspace,'report.json'));
      if(!inspected)throw Error('skill_source_not_inspected');
      saveJson(path,{...source,managementRunId:config.runId,draft,createdAt:Date.now()});return JSON.stringify({submitted:true,candidateId:source.candidateId});
    },
  })));
}
