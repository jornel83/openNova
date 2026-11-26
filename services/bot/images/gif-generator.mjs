import {createHash} from 'node:crypto';
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {dirname,extname,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ROOT} from '../../runtime/sources.mjs';
import {checkedMediaFile,mediaModelParameters,projectPath} from './generator.mjs';
import {runImageGenerator} from './runner.mjs';
import {resolveProjectCharacter} from './characters.mjs';

const schema=JSON.parse(readFileSync(join(ROOT,'tools/image/tool-definitions.json'),'utf8')).find(entry=>entry.function.name==='gif_generate').function.parameters;
const names={video:['source.mp4','mp4'],gif:['animation.gif','gif'],firstFrame:['first-frame.png','png']};
const resumable=new Set(['submitted','downloaded','publishing_video','exporting']);
const generationKeys=['status','provider','providerStatus','model','route','taskId','requestId','remoteCalls','reason','category','httpStatus','errorCode'];
const stills=new Set(['.png','.jpg','.jpeg','.webp']);
const limit=64*1024*1024;
const taskIdValid=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(id);
const code=value=>typeof value==='string'&&/^[a-z][a-z0-9_]{1,120}$/.test(value)?value:undefined;

export const GIF_GENERATION_INSTRUCTIONS='用户明确要求制作 GIF 时用 gif_generate。用户说“把这张做成动图”时省略 sourcePath，使用本轮项目里选定的静态图。outputDir 是项目里尚不存在的新子目录，其父目录须存在。默认 4 秒、10 fps，省略 model。仅在用户提供已准备好的文字透明层或动作参考时传相应项目路径。工具返回 pending 后告知正在生成，成果卡会更新。未知状态不要重提。';

export function createGifGenerateTool(generator){
  const parameters=mediaModelParameters(schema);
  delete parameters.sourcePath.required;
  parameters.characterId={type:'string',description:'从当前项目角色配置绑定身份；确认的作品静态图仍用 sourcePath 或当前图。'};
  return ['gif_generate',GIF_GENERATION_INSTRUCTIONS,parameters,(input,exec)=>generator.generate(input,exec)];
}

function prepare(input,request){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>key!=='characterId'&&!Object.hasOwn(schema.properties,key)))throw Error('invalid_gif_arguments');
  const {characterId,...toolArgs}=input;
  const binding=request.binding;
  const workspace=realpathSync(binding.cwd);
  const current=binding.context?.kind==='file'?binding.context.file:null;
  const args={...toolArgs,outputDir:projectPath(workspace,input.outputDir),sourcePath:input.sourcePath??current?.path};
  if(!args.sourcePath)throw Error('gif_reference_required');
  const character=characterId===undefined?undefined:resolveProjectCharacter(workspace,characterId);
  if(character){
    if(typeof args.motion!=='string')throw Error('invalid_gif_arguments');
    args.motion+=`\n已确认的角色视觉约束（只作身份参考）：${JSON.stringify(character.constraints)}`;
  }
  if(realpathSync(dirname(args.outputDir))!==dirname(args.outputDir))throw Error('invalid_project_media_path');
  const references=request.fileReferences??binding.projectContext?.references??[];
  const expectedReferenceHashes={};
  for(const key of ['sourcePath','fixedOverlayPath','motionReferencePath']){
    if(args[key]===undefined)continue;
    const path=projectPath(workspace,args[key]);
    if(!stills.has(extname(path).toLowerCase()))throw Error('invalid_gif_reference');
    const known=path===current?.path?current:references.find(reference=>reference.path===path)?.version;
    const actual=checkedMediaFile(path,20*1024*1024);
    if(known&&(known.projectId&&known.projectId!==binding.projectId||
        Object.entries(actual.version).some(([field,value])=>known[field]!==undefined&&known[field]!==value)||
        known.sha256&&known.sha256!==actual.sha256))throw Error('image_reference_changed');
    args[key]=path;
    expectedReferenceHashes[path]=actual.sha256;
  }
  return {args,workspace,expectedReferenceHashes,character};
}

function bound(record,result){
  return result?.tool==='gif_generate'&&result.operationId===record.id&&result.binding?.projectId===record.projectId&&result.binding?.requestId===record.requestId;
}

function verifiedArtifacts(record,result){
  const artifacts={};
  for(const [role,[name,format]] of Object.entries(names)){
    const artifact=result.artifacts?.[role];
    if(!artifact&&result.status!=='completed')continue;
    const path=projectPath(record.workspace,join(record.outputDir,name));
    if(artifact?.path!==path||artifact.format!==format)throw Error('invalid_gif_executor_receipt');
    const actual=checkedMediaFile(path,limit);
    if(actual.sha256!==artifact.sha256||actual.version.size!==artifact.bytes)throw Error('gif_artifact_changed');
    artifacts[role]={...artifact,version:actual.version};
  }
  return artifacts;
}

export function createGifGenerator({home,ops,projects,getRequest,getRuntime,runner=runImageGenerator,retryDelayMs=3000}){
  const stateDir=join(realpathSync(home),'image-generations'),lifetime=new AbortController(),jobs=new Map(),submissions=new Set();

  function journal(record){
    try{
      if(!/^gif-[a-f0-9]{40}$/.test(record.id))return null;
      const path=join(stateDir,record.id,'operation.json');
      if(realpathSync(path)!==path||statSync(path).size>1024*1024)return null;
      const saved=JSON.parse(readFileSync(path,'utf8'));
      return bound(record,saved)?saved:null;
    }catch{return null;}
  }

  function save(record,result){
    if(!bound(record,result)||!['completed','failed','cancelled','unknown','pending','partial'].includes(result.status))throw Error('invalid_gif_executor_receipt');
    const generation=Object.fromEntries(generationKeys.filter(key=>result.generation?.[key]!==undefined).map(key=>[key,result.generation[key]]));
    if(generation.taskId!==undefined&&!taskIdValid(generation.taskId))throw Error('invalid_gif_task_id');
    const artifacts=verifiedArtifacts(record,result);
    if(result.status==='completed'&&(!generation.taskId||result.fileValidation?.status!=='passed'||result.firstFrameValidation?.status!=='passed'))throw Error('invalid_gif_executor_receipt');
    const waiting=['pending','partial'].includes(result.status)&&!result.terminalStatus;
    if(waiting&&!generation.taskId)throw Error('invalid_gif_task_id');
    return ops.put({...record,status:result.status,phase:result.stage,generation,artifacts,artifact:artifacts.gif,
      inputs:(result.inputs??[]).map(({originalPath,sha256,bytes})=>({path:originalPath,sha256,bytes})),
      runtime:result.runtime,fileValidation:result.fileValidation,animationValidation:result.animationValidation,firstFrameValidation:result.firstFrameValidation,
      visualReview:result.visualReview,terminalStatus:result.terminalStatus,error:code(result.error?.code),finishedAt:waiting?undefined:Date.now()});
  }

  function payload(record,argumentsValue,expectedReferenceHashes){
    return {tool:'gif_generate',arguments:argumentsValue,context:{operationId:record.id,workspace:record.workspace,stateDir,
      binding:{projectId:record.projectId,requestId:record.requestId},expectedReferenceHashes}};
  }

  function reconcile(record,error){
    const saved=journal(record);
    if(saved&&saved.status!=='running')return save(record,saved);
    const uncertain=saved?.stage==='submitting'||!saved&&['image_executor_receipt_missing','invalid_image_executor_receipt','image_executor_interrupted','image_executor_timeout'].includes(error?.message);
    return ops.put({...record,status:uncertain?'unknown':'failed',phase:saved?.stage??record.phase,
      error:uncertain?'gif_completion_unknown':code(error?.message)??'gif_generation_failed',finishedAt:Date.now()});
  }

  function follow(initial,envelope,snapshot){
    if(lifetime.signal.aborted||jobs.has(initial.id))return;
    const job=Promise.resolve().then(async()=>{
      let record=initial;
      while(!lifetime.signal.aborted&&['pending','partial'].includes(record.status)&&!record.terminalStatus){
        await delay(retryDelayMs,undefined,{signal:lifetime.signal});
        try{
          record=save(record,await runner(envelope,{signal:lifetime.signal,recoverOnly:true,snapshot}));
        }catch(error){
          if(lifetime.signal.aborted)return;
          if(['image_executor_timeout','image_executor_interrupted','image_executor_receipt_missing','operation_in_progress'].includes(error.message)){
            record=reconcile(record,error);
          }else{
            ops.put({...record,status:'interrupted',error:code(error.message)??'gif_recovery_requires_review',finishedAt:Date.now()});
            return;
          }
        }
      }
    }).catch(error=>{
      if(!lifetime.signal.aborted)ops.put({...ops.get(initial.id),status:'interrupted',error:code(error.message)??'gif_recovery_requires_review',finishedAt:Date.now()});
    }).finally(()=>jobs.delete(initial.id));
    jobs.set(initial.id,job);
  }

  function recover(){
    for(const record of ops.list('tool').filter(item=>item.operation==='gif_generate'&&['running','pending','partial','interrupted','unknown'].includes(item.status)&&!item.terminalStatus)){
      const saved=journal(record);
      try{
        const result=reconcile(record,Error(!saved?'image_executor_interrupted':'gif_recovery_not_submitted'));
        if(saved&&resumable.has(saved.stage)&&taskIdValid(saved.generation?.taskId)&&!result.terminalStatus)
          follow(result,payload(record,saved.request,saved.expectedReferenceHashes),record.skillVersion?getRuntime(record.skillVersion):undefined);
      }catch{ops.put({...record,status:'interrupted',error:'gif_recovery_requires_review',finishedAt:Date.now()});}
    }
  }

  async function generate(input,{callId,signal}={}){
    const request=getRequest(),binding=request?.binding,state=projects.state();
    if(lifetime.signal.aborted||!request?.id||request.cancelled||request.projectChanged||request.signal?.aborted||signal?.aborted||
        binding?.focus!=='work'||!binding.projectId||binding.projectId!==request.projectId||state.focus!=='work'||
        state.projectId!==binding.projectId||state.revision!==binding.revision)throw Error('project_work_request_required');
    if(typeof callId!=='string'||!callId||callId.length>256)throw Error('invalid_command_id');
    const existing=ops.list('tool').find(item=>item.operation==='gif_generate'&&item.requestId===request.id&&item.projectId===binding.projectId);
    if(existing)return existing;
    const {args,workspace,expectedReferenceHashes,character}=prepare(input,request);
    const snapshot=getRuntime?.();
    const id='gif-'+createHash('sha256').update(JSON.stringify([binding.projectId,request.id])).digest('hex').slice(0,40);
    const record={id,kind:'tool',operation:'gif_generate',operationId:id,requestId:request.id,projectId:binding.projectId,
      workspace,outputDir:args.outputDir,...(snapshot?{skillVersion:snapshot.version}:{}),...(character?{character}:{}),
      status:'running',phase:'submitting',description:'生成 GIF',createdAt:Date.now()};
    const envelope=payload(record,args,expectedReferenceHashes);
    ops.put(record);
    const submit=Promise.resolve().then(async()=>{
      let result;
      try{
        const signals=[lifetime.signal,request.signal,signal].filter(Boolean);
        result=save(record,await runner(envelope,{signal:AbortSignal.any(signals),snapshot}));
      }catch(error){result=reconcile(record,error);}
      if(['pending','partial'].includes(result.status)&&!result.terminalStatus)follow(result,envelope,snapshot);
      return result;
    });
    submissions.add(submit);
    try{return await submit;}finally{submissions.delete(submit);}
  }

  return {generate,recover,async close(){lifetime.abort();await Promise.allSettled([...submissions,...jobs.values()]);}};
}
