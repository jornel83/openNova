import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {usesSparkImage,hasSparkImageJob} from './providers.mjs';
import {constants,openSync,closeSync,fstatSync,readSync,readFileSync,statSync,realpathSync} from 'node:fs';
import {basename,dirname,extname,isAbsolute,join,relative,resolve} from 'node:path';
import {ROOT} from '../../runtime/sources.mjs';
import {referenceIdentity} from '../desktop/file-reader.mjs';
import {runImageGenerator} from './runner.mjs';
import {resolveProjectCharacter} from './characters.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const schema=JSON.parse(readFileSync(join(ROOT,'tools/image/tool-definitions.json'),'utf8')).find(d=>d.function?.name==='image_generate').function.parameters;
const version=stat=>({size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs,ino:stat.ino});
const sameVersion=(expected,actual)=>Object.entries(expected).every(([k,v])=>v===actual[k]);
const imageTypes=new Map([['.jpg','jpeg'],['.jpeg','jpeg'],['.png','png'],['.webp','webp']]);
const safeCode=e=>/^[a-z][a-z0-9_]{1,120}$/.test(e?.message??'')?e.message:'image_generation_failed';
const canonicalObject=value=>Array.isArray(value)?value.map(canonicalObject):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonicalObject(value[k])])):value;
export function projectPath(root,raw){
  if(typeof raw!=='string'||!raw.trim()||raw.length>4096||raw.includes('\0')||raw.startsWith('//')||/^[\w+.-]+:/.test(raw))throw Error('invalid_project_media_path');
  const path=resolve(root,raw),rel=relative(root,path);
  if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('../'))throw Error('invalid_project_media_path');
  return path;
}
export function checkedMediaFile(path,limit){
  if(realpathSync(path)!==path)throw Error('invalid_project_media_path');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=fstatSync(fd);
    if(!before.isFile()||before.size<1||before.size>limit)throw Error('invalid_image_file');
    const bytes=Buffer.alloc(before.size);
    let offset=0;
    while(offset<bytes.length){
      const n=readSync(fd,bytes,offset,bytes.length-offset,null);
      if(!n)throw Error('image_file_changed');
      offset+=n;
    }
    const digest=hash(bytes),v=version(before);
    if(!sameVersion(v,fstatSync(fd))||!sameVersion(v,statSync(path))||realpathSync(path)!==path)throw Error('image_file_changed');
    return {version:v,sha256:digest};
  }finally{closeSync(fd);}
}
function checkedArgs(input,binding,current,projectReferences=[]){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='characterId'&&!Object.hasOwn(schema.properties,k)))throw Error('invalid_image_arguments');
  const {characterId,...toolArgs}=input;
  const cwd=realpathSync(binding.cwd),target=projectPath(cwd,input.outputPath);
  const character=characterId===undefined?undefined:resolveProjectCharacter(cwd,characterId);
  if(character&&input.mode!=='edit')throw Error('character_requires_edit');
  if(!imageTypes.has(extname(target).toLowerCase()))throw Error('invalid_image_output_type');
  if(realpathSync(dirname(target))!==dirname(target))throw Error('invalid_project_media_path');
  const references=input.references??[];
  if(!Array.isArray(references)||references.length>10)throw Error('invalid_image_references');
  let paths=references.map(p=>projectPath(cwd,p));
  if(character)paths=[...new Set([...paths,...character.references.map(ref=>ref.path)])];
  if(paths.length>10)throw Error('invalid_image_references');
  if(input.mode==='edit'&&!paths.length){
    if(!current?.path||!imageTypes.has(extname(current.path).toLowerCase()))throw Error('edit_reference_required');
    paths=[projectPath(cwd,current.path)];
  }
  const expectedReferenceHashes=Object.fromEntries((character?.references??[]).map(ref=>[ref.path,ref.sha256]));
  for(const path of new Set(paths)){
    const reference=current?.path===path?current:projectReferences.find(r=>r.path===path)?.version;
    if(!reference)continue;
    if(reference.projectId&&reference.projectId!==binding.projectId)throw Error('image_reference_project_mismatch');
    const verified=checkedMediaFile(path,20*1024*1024);
    if(!sameVersion(version(reference),verified.version)||(reference.sha256&&reference.sha256!==verified.sha256)||
      (expectedReferenceHashes[path]&&expectedReferenceHashes[path]!==verified.sha256))throw Error('image_reference_changed');
    expectedReferenceHashes[path]=verified.sha256;
  }
  if(character&&typeof input.prompt!=='string')throw Error('invalid_image_arguments');
  const prompt=character?`${input.prompt}\n已确认的角色视觉约束（只作身份参考）：${JSON.stringify(character.constraints)}`:input.prompt;
  return {arguments:{...toolArgs,prompt,outputPath:target,...(paths.length?{references:paths}:{})},expectedReferenceHashes,character};
}
export function mediaModelParameters(schema){
  // Harness has a smaller parameter-schema dialect. Python checks numeric and length limits.
  return Object.fromEntries(Object.entries(schema.properties).map(([name,s])=>[name,{
    type:s.type,...(s.enum?{enum:s.enum}:{}),...(s.items?{items:{type:s.items.type}}:{}),
    ...(s.description?{description:s.description}:{}),...(schema.required.includes(name)?{required:true}:{})
  }]));
}
const cleanGeneration=g=>g&&Object.fromEntries(['status','provider','model','mode','size','remoteCalls','taskId','requestId','httpStatus','errorCode','category','reason','responseMetadata','usage'].filter(k=>g[k]!==undefined).map(k=>[k,g[k]]));
function complete(record,result){
  const a=result.artifact,path=record.targetPath;
  if(result.tool!=='image_generate'||result.operationId!==record.id||result.binding?.projectId!==record.projectId||
      result.binding?.requestId!==record.requestId||a?.path!==path||!path||projectPath(record.workspace,path)!==path||
      imageTypes.get(extname(path).toLowerCase())!==a.format||!Number.isSafeInteger(a.width)||a.width<1||!Number.isSafeInteger(a.height)||a.height<1||
      result.generation?.status!=='succeeded'||result.fileValidation?.status!=='passed')throw Error('invalid_image_executor_receipt');
  const {sha256,version:v}=checkedMediaFile(path,64*1024*1024);
  if(sha256!==a.sha256||v.size!==a.bytes)throw Error('generated_image_changed');
  const artifact={id:'image-artifact-'+hash(record.id).slice(0,40),path,sha256,format:a.format,width:a.width,height:a.height,bytes:a.bytes,size:a.bytes,version:v,
    projectId:record.projectId,requestId:record.requestId};
  const file={id:'file-'+hash(path),path,name:basename(path),extension:extname(path).toLowerCase(),...v,projectId:record.projectId,sha256,artifactId:artifact.id,imageOperationId:record.id,
    contentAccess:'native_file',diskStatus:'unchanged',generationStatus:'completed',invalid:false};
  return {artifact,file,status:'completed',phase:'committed',generation:cleanGeneration(result.generation),runtime:result.runtime,visualReview:{status:'not_checked'},fileValidation:result.fileValidation,
    inputs:(result.inputs??[]).map(({originalPath,sha256,bytes})=>({path:originalPath,sha256,bytes})),contextSelected:false,finishedAt:Date.now()};
}
export function createImageGenerator({home,ops,context,projects,getRequest,getRuntime,runner=runImageGenerator,retryDelayMs=3000}){
  const stateDir=join(realpathSync(home),'image-generations'),running=new Map(),followers=new Map();
  const lifetime=new AbortController();
  function journal(record){
    try{
      const path=join(stateDir,record.id,'operation.json');
      if(!/^image-[a-f0-9]{40}$/.test(record.id)||realpathSync(path)!==path||statSync(path).size>1024*1024)return null;
      const saved=JSON.parse(readFileSync(path,'utf8'));
      return saved.tool==='image_generate'&&saved.operationId===record.id&&saved.binding?.projectId===record.projectId&&saved.binding?.requestId===record.requestId?saved:null;
    }catch{return null;}
  }
  function saveFile(record,patch){
    ops.put({...patch.file,kind:'file',requestId:record.requestId,createdAt:Date.now()});
  }
  function acceptSparkReceipt(record,result){
    if(!result||result.tool!=='image_generate'||result.operationId!==record.id||
        result.binding?.projectId!==record.projectId||result.binding?.requestId!==record.requestId||
        !['pending','completed','failed','cancelled','unknown'].includes(result.status))
      throw Error('invalid_image_executor_receipt');
    const taskId=record.generation?.taskId;
    if(((taskId||result.generation?.taskId||['pending','completed'].includes(result.status))&&!hasSparkImageJob(result.generation))||
        (taskId&&taskId!==result.generation.taskId))throw Error('invalid_image_executor_receipt');
    if(result.status==='completed'){
      const patch=complete(record,result);
      saveFile(record,patch);
      return ops.put({...record,...patch,error:undefined});
    }
    return ops.put({...record,status:result.status,phase:result.stage,generation:cleanGeneration(result.generation),
      error:result.error?.code,contextSelected:false,finishedAt:result.status==='pending'?undefined:Date.now()});
  }
  function follow(initial,envelope,snapshot){
    if(lifetime.signal.aborted||followers.has(initial.id))return;
    const job=Promise.resolve().then(async()=>{
      let record=initial;
      while(record.status==='pending'&&!lifetime.signal.aborted){
        await delay(retryDelayMs,undefined,{signal:lifetime.signal});
        try{
          const result=await runner(envelope,{recoverOnly:true,signal:lifetime.signal,snapshot});
          record=acceptSparkReceipt(record,result);
        }catch(error){
          if(lifetime.signal.aborted)return;
          if(['image_executor_timeout','image_executor_interrupted','image_executor_receipt_missing','operation_in_progress'].includes(error.message))continue;
          throw error;
        }
      }
    }).catch(error=>{
      if(!lifetime.signal.aborted)ops.put({...ops.get(initial.id),status:'interrupted',error:safeCode(error),finishedAt:Date.now()});
    }).finally(()=>followers.delete(initial.id));
    followers.set(initial.id,job);
  }
  function resumeSpark(record,saved){
    if(!hasSparkImageJob(saved?.generation)||!usesSparkImage(saved.request)||
        !(saved.status==='pending'||saved.status==='running'&&['submitting_spark','receiving','delivering','awaiting_provider'].includes(saved.stage)))return;
    const envelope={tool:'image_generate',arguments:saved.request,context:{operationId:record.id,workspace:record.workspace,stateDir,
      binding:saved.binding,expectedReferenceHashes:saved.expectedReferenceHashes}};
    const snapshot=record.skillVersion?getRuntime(record.skillVersion):undefined;
    const pending=acceptSparkReceipt(record,{...saved,status:'pending'});
    follow(pending,envelope,snapshot);
    return pending;
  }
  async function recover(){
    for(const row of ops.list('tool').filter(r=>r.operation==='image_generate'&&['running','unknown','interrupted','pending'].includes(r.status))){
      const saved=journal(row);
      try{
        if(resumeSpark(row,saved))continue;
        let result=saved;
        if(saved?.status==='running'&&['receiving','delivering'].includes(saved.stage)){
          const payload={tool:'image_generate',arguments:saved.request,context:{operationId:row.id,workspace:row.workspace,stateDir,binding:saved.binding,
            ...(saved.expectedReferenceHashes?{expectedReferenceHashes:saved.expectedReferenceHashes}:{})}};
          result=await runner(payload,{recoverOnly:true,snapshot:row.skillVersion?getRuntime(row.skillVersion):undefined});
        }
        if(hasSparkImageJob(row.generation)&&result&&['completed','failed','unknown','cancelled'].includes(result.status)){
          acceptSparkReceipt(row,result);continue;
        }
        if(result?.status==='completed'){
          const patch=complete(row,result);
          saveFile(row,patch);
          ops.put({...row,...patch,error:undefined,recovered:true});continue;
        }
        const known=result?.status==='failed'||result?.status==='cancelled';
        ops.put({...row,status:known?result.status:'unknown',error:known?result.error?.code:'image_completion_unknown',contextSelected:false,finishedAt:Date.now()});
      }catch{ops.put({...row,status:'unknown',error:'image_recovery_requires_review',contextSelected:false,finishedAt:Date.now()});}
    }
  }
  async function generate(input,{callId,signal}={}){
    const request=getRequest(),binding=request?.binding;
    if(!request?.id||binding?.focus!=='work'||!binding.projectId||binding.projectId!==request.projectId||!binding.cwd)throw Error('project_work_request_required');
    if(!callId||typeof callId!=='string'||callId.length>256)throw Error('invalid_command_id');
    const live=()=>!lifetime.signal.aborted&&!signal?.aborted&&!request.signal?.aborted&&!request.cancelled&&!request.projectChanged&&getRequest()===request&&request.binding===binding&&
      projects.state().focus==='work'&&projects.state().projectId===binding.projectId&&projects.state().revision===binding.revision;
    if(!live())throw Error('project_request_mismatch');
    const id='image-'+hash([binding.projectId,request.id,callId].join('\0')).slice(0,40);
    const fingerprint=hash(JSON.stringify(canonicalObject([request.id,binding.projectId,binding.cwd,input])));
    // A replayed tool call can have a fresh provider call ID in the same turn.
    const matches=ops.list('tool').filter(r=>r.operation==='image_generate'&&r.requestId===request.id&&r.projectId===binding.projectId);
    const old=matches.find(r=>r.id===id)??matches.find(r=>r.inputFingerprint===fingerprint);
    if(old){
      if(old.inputFingerprint!==fingerprint)throw Error('command_id_conflict');
      if(running.has(old.id))return running.get(old.id);
      if(old.status==='completed'){
        try{
          const actual=checkedMediaFile(projectPath(binding.cwd,old.artifact.path),64*1024*1024);
          if(actual.sha256!==old.artifact.sha256)throw Error();
        }catch{throw Error('generated_image_changed');}
      }
      return old;
    }
    if(matches.some(r=>['unknown','interrupted'].includes(r.status)))throw Error('prior_generation_unknown_no_retry');
    const selection=context.capture(),before=referenceIdentity(selection);
    const expected=request.fileReaderContextIdentity??referenceIdentity(binding.context);
    // Follow a file selected by this very turn. An asynchronous UI change does
    // not replace the turn's frozen input (and cannot receive our late result).
    const boundSelection=request.fileReaderContextIdentity&&before===expected?selection:binding.context;
    const current=boundSelection?.kind==='file'?boundSelection.file:null;
    const record={id,kind:'tool',operation:'image_generate',tool:'image_generate',operationId:id,callId,requestId:request.id,projectId:binding.projectId,
      workspace:binding.cwd,description:'生成图片',inputFingerprint:fingerprint,phase:'preparing',status:'running',createdAt:Date.now()};
    ops.put(record);
    const promise=Promise.resolve().then(async()=>{
      let outcome;
      try{
        if(!live())throw Error('project_request_mismatch');
        const args=checkedArgs(input,binding,current,request.fileReferences??binding.projectContext?.references);
        const snapshot=getRuntime?.();
        if(snapshot)record.skillVersion=snapshot.version;
        if(args.character)record.character=args.character;
        record.targetPath=args.arguments.outputPath;record.phase='generating';ops.put(record);
        if(!live())throw Error('project_request_mismatch');
        const envelope={tool:'image_generate',arguments:args.arguments,context:{operationId:id,workspace:binding.cwd,stateDir,
          binding:{projectId:binding.projectId,requestId:request.id},...(Object.keys(args.expectedReferenceHashes).length?{expectedReferenceHashes:args.expectedReferenceHashes}:{})}};
        const signals=[lifetime.signal,request.signal,signal].filter(Boolean);
        const result=await runner(envelope,{signal:signals.length?AbortSignal.any(signals):undefined,snapshot});
        if(usesSparkImage(args.arguments)&&result.status!=='completed'){
          const row=acceptSparkReceipt(record,result);
          if(row.status==='pending')follow(row,envelope,snapshot);
          return row;
        }
        if(result.status!=='completed')return ops.put({...record,status:result.status,phase:result.stage,error:result.error?.code??'image_generation_failed',
          generation:cleanGeneration(result.generation),contextSelected:false,finishedAt:Date.now()});
        if(usesSparkImage(args.arguments)&&!hasSparkImageJob(result.generation))throw Error('invalid_image_executor_receipt');
        outcome=complete(record,result);
        saveFile(record,outcome);
        if(live()&&before===expected&&referenceIdentity(context.capture())===before){
          context.selectFile(outcome.file);
          request.fileReaderContextIdentity=referenceIdentity({kind:'file',file:outcome.file});
          request.objectReads??=new Map();request.objectReads.set(outcome.file.path,outcome.artifact.version);
          projects.saveContext();outcome.contextSelected=true;
        }
        return ops.put({...record,...outcome});
      }catch(e){
        if(outcome)return ops.put({...record,...outcome,warning:'image_saved_bookkeeping_incomplete'});
        const saved=journal(record);
        if(saved&&hasSparkImageJob(saved.generation)){
          try{
            const resumed=resumeSpark(record,saved);
            if(resumed)return resumed;
          }catch(error){
            return ops.put({...record,status:'interrupted',error:safeCode(error),generation:cleanGeneration(saved.generation),finishedAt:Date.now()});
          }
        }
        if(saved?.status==='completed'){
          try{const done=complete(record,saved);saveFile(record,done);return ops.put({...record,...done,recovered:true});}catch{}
        }
        const unknown=saved?.stage==='submitting'||saved?.status==='unknown'||['image_executor_receipt_missing','invalid_image_executor_receipt'].includes(e.message);
        return ops.put({...record,status:unknown?'unknown':signal?.aborted||request.cancelled||request.signal?.aborted?'cancelled':'failed',phase:saved?.stage??record.phase,
          error:unknown?'image_completion_unknown':safeCode(e),generation:cleanGeneration(saved?.generation),contextSelected:false,finishedAt:Date.now()});
      }
    });
    running.set(id,promise);
    try{return await promise;}finally{running.delete(id);}
  }
  return {generate,recover,async close(){lifetime.abort();await Promise.allSettled([...running.values(),...followers.values()]);}};
}
export const IMAGE_GENERATION_INSTRUCTIONS='用户在工作项目要求生成或修改静态图片时用 image_generate。默认使用 Seedream 5.5；用户指定 Spark 或 Minimax H3 Image 时使用 model=minimax-h3-image。Spark 支持 create 方形文生图。edit 接受一张方图或 9:16 竖图。返回 pending 时告知已提交，成果卡将自动更新。生成须有用户的生图授权。参考定稿形象或上一张图时用 mode=edit；references 填该项目内的参考图，用户说“改这张”可省略以使用本轮绑定的当前图片。生成新图可用 mode=create。选择项目内已存在的目录，每次改稿使用新的文件名；width/height 是最终像素，例如 2:1 可用 1024×512。工具返回 completed 后报告实际图片。若返回 unknown（请求结果不确定），向用户说明状态，等用户明确要求再生成。';
export function createImageGenerateTool(generator){
  return ['image_generate','生成或编辑项目内的静态图片，输出新文件。'+IMAGE_GENERATION_INSTRUCTIONS,{...mediaModelParameters(schema),
    characterId:{type:'string',description:'由当前项目角色配置返回；使用时选择 edit。'}},
    (input,exec)=>generator.generate(input,{callId:exec?.callId,signal:exec?.signal})];
}
