import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {dirname,join,extname} from 'node:path';
import {ROOT} from '../../runtime/sources.mjs';
import {checkedMediaFile,mediaModelParameters,projectPath} from './generator.mjs';
import {runImageGenerator} from './runner.mjs';

const schema=JSON.parse(readFileSync(join(ROOT,'tools/image/tool-definitions.json'),'utf8')).find(x=>x.function.name==='media_export').function.parameters;
const formats=new Map([['.png','png'],['.jpeg','jpeg'],['.jpg','jpeg'],['.gif','gif'],['.webp','webp']]);
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const safeCode=e=>/^[a-z][a-z0-9_]{1,120}$/.test(e?.message??'')?e.message:'media_export_failed';

export function createMediaExportTool({home,ops,projects,getRequest,getRuntime,runner=runImageGenerator}){
  const parameters=mediaModelParameters(schema);
  delete parameters.frames;
  parameters.action.enum=parameters.action.enum.filter(action=>action!=='assemble_frames');
  const stateDir=join(realpathSync(home),'image-generations');
  return ['media_export','仅在本地处理项目素材：提取首帧、压缩 GIF、调整尺寸、转换静态格式或用已有视频导出 GIF。不调用远端生成；默认取当前文件，使用项目内新文件名。',parameters,async(input,{signal,callId}={})=>{
    const request=getRequest(),binding=request?.binding,state=projects.state();
    if(!binding||binding.focus!=='work'||state.focus!=='work'||binding.projectId!==request.projectId||
        state.projectId!==binding.projectId||state.revision!==binding.revision||
        request.cancelled||request.projectChanged||request.signal?.aborted||signal?.aborted)throw Error('project_work_request_required');
    if(typeof callId!=='string'||!callId||callId.length>256)throw Error('invalid_command_id');
    if(!input||Object.keys(input).some(key=>!Object.hasOwn(parameters,key))||!parameters.action.enum.includes(input.action))throw Error('invalid_media_arguments');
    const id='export-'+digest([binding.projectId,request.id,callId]).slice(0,40),signature=digest(input);
    let old;try{old=ops.get(id);}catch(error){if(error.message!=='unknown_id')throw error;}
    if(old){if(old.inputFingerprint!==signature)throw Error('command_id_conflict');return old;}
    const workspace=realpathSync(binding.cwd),current=binding.context?.kind==='file'?binding.context.file:null;
    const args={...input,outputPath:projectPath(workspace,input.outputPath),sourcePath:projectPath(workspace,input.sourcePath??current?.path)};
    const format=formats.get(extname(args.outputPath).toLowerCase());
    if(!format)throw Error('invalid_image_output_type');
    if(realpathSync(dirname(args.outputPath))!==dirname(args.outputPath))throw Error('invalid_project_media_path');
    if(args.fixedOverlayPath!==undefined)args.fixedOverlayPath=projectPath(workspace,args.fixedOverlayPath);
    const expectedReferenceHashes={};
    for(const path of new Set([args.sourcePath,args.fixedOverlayPath].filter(Boolean))){
      const actual=checkedMediaFile(path,20*1024*1024);
      const known=path===current?.path?current:(request.fileReferences??binding.projectContext?.references??[]).find(ref=>ref.path===path)?.version;
      if(known&&(known.projectId&&known.projectId!==binding.projectId||
          known.sha256&&known.sha256!==actual.sha256||Object.entries(actual.version).some(([key,v])=>known[key]!==undefined&&known[key]!==v)))throw Error('image_reference_changed');
      expectedReferenceHashes[path]=actual.sha256;
    }
    const runtime=getRuntime?.();
    const record={id,kind:'tool',operation:'media_export',operationId:id,projectId:binding.projectId,requestId:request.id,status:'running',
      inputFingerprint:signature,description:'导出媒体',...(runtime?{skillVersion:runtime.version}:{}),createdAt:Date.now()};
    ops.put(record);
    try{
      const signals=[request.signal,signal].filter(Boolean);
      const result=await runner({tool:'media_export',arguments:args,context:{operationId:id,workspace,stateDir,
        binding:{projectId:binding.projectId,requestId:request.id},expectedReferenceHashes}},
        {signal:signals.length?AbortSignal.any(signals):undefined,snapshot:runtime});
      if(result.binding?.projectId!==record.projectId||result.binding?.requestId!==record.requestId||result.tool!==record.operation||
          result.operationId!==id||result.generation?.remoteCalls!==0)throw Error('invalid_image_executor_receipt');
      if(result.status!=='completed')return ops.put({...record,status:result.status,error:safeCode({message:result.error?.code}),finishedAt:Date.now()});
      const artifact=result.artifact,actual=checkedMediaFile(args.outputPath,64*1024*1024);
      if(artifact.path!==args.outputPath||artifact.sha256!==actual.sha256||artifact.bytes!==actual.version.size||artifact.format!==format||
          result.fileValidation?.status!=='passed')throw Error('invalid_image_executor_receipt');
      return ops.put({...record,status:'completed',artifact:{...artifact,version:actual.version},runtime:result.runtime,
        generation:{status:'not_applicable',remoteCalls:0},fileValidation:result.fileValidation,animationValidation:result.animationValidation,finishedAt:Date.now()});
    }catch(error){
      return ops.put({...record,status:signal?.aborted||request.signal?.aborted?'cancelled':'failed',error:safeCode(error),finishedAt:Date.now()});
    }
  }];
}
