/** Advertise only the schema saved with the Run's image-production skill. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {verifySkillSnapshot} from '../skills/bundle.mjs';
import {allowedTaskMediaTools} from './execution.mjs';

const schemaPath='tools/image/tool-definitions.json';
const stringField=description=>({type:'string',description});
const operationInstructions={
  image_generate:'按本任务冻结的项目参考图和角色，生成一张新的图片，默认使用 Seedream。图片模式、提示词和输出路径须属于本任务；有角色或已有确认图时使用 edit。',
  gif_generate:'使用本任务冻结的确认稿，生成源 MP4、循环 GIF 和实际首帧。返回等待后结束本轮；宿主会查询同一任务，不能重新提交。',
  media_export:'只对本任务的素材在本地处理、转换或提取首帧，不调用模型生成。',
};
const utilityDefinitions=[
  ['project_media_characters','查询此任务冻结的角色版本。不读取其他项目或工作区的实时资料。',{}],
  ['task_media_status','读取本任务媒体回执（不重新生成）。仅在手动接续已知但未结束的远端操作时，才可设置 follow=true，由宿主继续跟进原远端编号。',{
    operationId:stringField('已有的媒体操作编号；省略时查询此任务已有的回执。'),
    follow:{type:'boolean',description:'显式接续时跟进已知任务；从不重新提交。'},
  }],
  ['gif_review','抽帧审阅此任务生成的 GIF 或绑定的 GIF 输入。回执区分已检查样本帧和未检查帧；不改变前台选中的文件。',{
    operationId:stringField('当前任务拥有的 GIF 生成操作编号。'),
    path:stringField('本任务已冻结的 GIF 输入路径；与 operationId 二选一。'),
    question:stringField('要核对的人物、动作或构图。'),
  }],
];

function parameters(schema){
  return Object.fromEntries(Object.entries(schema.properties??{}).map(([key,field])=>[key,{
    ...parameter(field),...schema.required?.includes(key)?{required:true}:{},
  }]));
}
function parameter(field){
  const annotations=typeof field.description==='string'?{description:field.description}:{};
  if(field.type==='object')return {...annotations,type:'object',additionalProperties:false,properties:parameters(field)};
  if(field.type==='array')return {...annotations,type:'array',...(field.items?{items:parameter(field.items)}:{})};
  if(!['string','integer','number','boolean'].includes(field.type))throw Error('task_media_schema_invalid');
  return {...annotations,type:field.type,...(field.enum?{enum:field.enum}:{})};
}

export function taskMediaDefinitions(config){
  const allowed=new Set(allowedTaskMediaTools(config));
  if(!config.bridge?.scoped||!allowed.size)return [];
  const snapshot=verifySkillSnapshot(config.skills.find(skill=>skill.name==='image-production'));
  if(!snapshot.resources.some(r=>r.path===schemaPath))throw Error('task_media_schema_unavailable');
  const entries=JSON.parse(readFileSync(join(snapshot.archiveRoot,schemaPath),'utf8'));
  const tools=[];
  for(const [name,description] of Object.entries(operationInstructions)){
    if(!allowed.has(name))continue;
    const schema=entries.find(entry=>entry.function?.name===name)?.function?.parameters;
    if(schema?.type!=='object'||!schema.properties)throw Error('task_media_schema_unavailable');
    const fields=parameters(schema);
    fields.outputScope={type:'string',enum:['task','project'],description:'默认保存到任务工作区；仅当本任务已获准使用确切项目输出位置时选 project。'};
    if(name==='image_generate'||name==='gif_generate')fields.characterId=stringField('来自本任务冻结名单的角色标识。');
    const spark=name==='image_generate'&&schema.properties.provider?.enum?.includes('spark');
    const guide=spark?'在 Spark 上使用 Minimax H3 Image 时选 model=minimax-h3-image。支持方形文生图，或用一张方图、9:16 竖图编辑。返回 waitingForMedia 后结束本轮，宿主会跟进原任务。':'';
    tools.push([name,description+guide,fields]);
  }
  return tools.concat(utilityDefinitions.filter(([name])=>allowed.has(name)));
}

export const taskMediaInstructions='媒体操作以本轮冻结的授权为准。只需要提示词时直接给提示词。已有确认稿时原样用作 GIF 的来源；不随意重做静态图。只要渲染或压缩不发起生成。使用正式媒体工具，不用脚本或已有 video-production 工具代替。收到 waitingForMedia 后结束本轮，宿主跟进同一个生成任务。接续时先用 task_media_status 查询原回执；如果远端提交结果未知，保留未知状态，不重新提交、换模型或换目录规避。只有工具已交付的实际路径才可报告；仅做抽帧时显式说明覆盖范围。';
