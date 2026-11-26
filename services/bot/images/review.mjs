/** Bounded visual evidence from decoded frames of one fixed project GIF. */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants,mkdirSync,realpathSync,writeFileSync} from 'node:fs';
import {open,realpath,stat} from 'node:fs/promises';
import {extname,join} from 'node:path';
import {NATIVE_FILE_READER_MODEL} from '../../agent/native-file-reader.mjs';
import {errorEvent} from '../../agent/errors.mjs';
import {projectPath} from './generator.mjs';
import {generatedImageVersion} from './preview.mjs';
import {pinImageRuntime} from './runner.mjs';

const maxGif=20*1024*1024,maxPage=4*1024*1024;
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const versionKeys=['size','mtimeMs','ctimeMs','ino'];
const errorCodes=new Set(['gif_review_invalid_input','gif_review_animation_required','gif_review_limit_exceeded','gif_review_invalid_animation',
  'gif_review_runtime_missing','gif_review_sampler_failed','gif_review_sampler_timeout','gif_review_invalid_sample','gif_review_invalid_model_receipt',
  'gif_review_source_changed','gif_review_source_unavailable','image_artifact_changed','image_preview_unavailable','project_state_changed','unknown_id',
  'invalid_image_executor_snapshot','invalid_image_dependency_lock','image_runtime_incompatible','image_python_unavailable','skill_snapshot_changed','skill_unknown','skill_disabled']);

function sampleSheet({bytes,signal,snapshot}){
  if(!snapshot)throw Error('gif_review_runtime_missing');
  const pinned=pinImageRuntime(snapshot,{credentials:false});
  return new Promise((resolve,reject)=>{
    const child=spawn(pinned.python,['-I','-B',join(pinned.archiveRoot,'tools/image/review.py')],
      {cwd:pinned.archiveRoot,env:pinned.env,stdio:['pipe','pipe','ignore']});
    let size=0,chunks=[],failure;
    const stop=reason=>{failure??=reason;child.kill('SIGKILL');};
    const abort=()=>stop('cancelled');
    const timer=setTimeout(()=>stop('gif_review_sampler_timeout'),30000);
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    child.stdin.on('error',()=>{});
    child.stdout.on('data',data=>{size+=data.length;if(size>maxPage*2)stop('gif_review_invalid_sample');else chunks.push(data);});
    child.once('error',()=>{cleanup();reject(Error('gif_review_sampler_failed'));});
    child.once('close',status=>{
      cleanup();
      if(failure)return reject(Error(failure));
      let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reject(Error('gif_review_sampler_failed'));}
      if(status!==0||!result?.ok)return reject(Error(errorCodes.has(result?.error)?result.error:'gif_review_sampler_failed'));
      resolve({...result.sample,png:Buffer.from(result.sample?.png??'','base64'),runtime:pinned.runtime});
    });
    child.stdin.end(bytes);
  });
}

async function loadGif(path,expected,check){
  if(await realpath(path).catch(()=>null)!==path)throw Error('gif_review_source_unavailable');
  const handle=await open(path,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW).catch(()=>{throw Error('gif_review_source_unavailable');});
  try{
    const before=await handle.stat();
    if(!before.isFile()||before.size<1||before.size>maxGif)throw Error('gif_review_invalid_input');
    if(expected&&versionKeys.some(key=>expected[key]!==undefined&&expected[key]!==before[key]))throw Error('gif_review_source_changed');
    const bytes=Buffer.alloc(before.size);
    let offset=0;
    while(offset<bytes.length){check();const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw Error('gif_review_source_changed');offset+=bytesRead;}
    const after=await handle.stat(),current=await stat(path).catch(()=>null);
    if(!current||versionKeys.some(key=>before[key]!==after[key]||before[key]!==current[key])||await realpath(path).catch(()=>null)!==path)
      throw Error('gif_review_source_changed');
    const sha=sha256(bytes);
    if(expected?.sha256&&expected.sha256!==sha)throw Error('gif_review_source_changed');
    return {bytes,sha256:sha};
  }finally{await handle.close();}
}

function validateSample(sample,source){
  const {png,frames,indices,timestampsMs}=sample??{};
  if(sample?.sha256!==source.sha256||!Number.isInteger(frames)||frames<2||frames>512||!Array.isArray(indices)||indices.length!==Math.min(frames,9)||
      indices[0]!==0||indices.at(-1)!==frames-1||indices.some((i,j)=>!Number.isInteger(i)||j>0&&i<=indices[j-1])||
      !Array.isArray(timestampsMs)||timestampsMs.length!==indices.length||timestampsMs[0]!==0||timestampsMs.some((i,j)=>!Number.isSafeInteger(i)||j>0&&i<timestampsMs[j-1])||
      !Buffer.isBuffer(png)||png.length<24||png.length>maxPage||png.toString('hex',0,8)!=='89504e470d0a1a0a')throw Error('gif_review_invalid_sample');
  return {coverage:'png_contact_sheet',totalFrames:frames,sampledFrameIndices:indices,timestampsMs,contactSheetSha256:sha256(png)};
}

function visualReading(native,indices){
  if(native?.status==='unreadable')return {status:'unreadable',checkedFrameIndices:[],verdict:'uncertain',
    limitation:'读取器无法确认此检查页内容。'};
  let evidence;try{evidence=JSON.parse(native?.content??'');}catch{throw Error('gif_review_invalid_model_receipt');}
  if(!['read','partial'].includes(native?.status)||!Array.isArray(evidence?.checkedFrameIndices)||evidence.checkedFrameIndices.some(index=>!indices.includes(index))||
      !evidence.checkedFrameIndices.length||new Set(evidence.checkedFrameIndices).size!==evidence.checkedFrameIndices.length||
      !['matches','deviation','uncertain'].includes(evidence.verdict)||typeof evidence.conclusion!=='string'||!evidence.conclusion.trim()||evidence.conclusion.length>5000)
    throw Error('gif_review_invalid_model_receipt');
  const checked=[...evidence.checkedFrameIndices].sort((a,b)=>a-b);
  const limitations=['仅依据标注的 PNG 样本帧，未播放原 GIF；不能据此确认未抽取帧或真实播放时的自然衔接。',
    typeof native.limitation==='string'?native.limitation.slice(0,1000):''].filter(Boolean);
  return {status:native.status==='partial'||checked.length!==indices.length?'partial':'sampled',checkedFrameIndices:checked,
    verdict:evidence.verdict,conclusion:evidence.conclusion,limitation:limitations.join(' ')};
}

const defaultQuestion='核对角色、服装、表情、动作线索、文字可读性和首尾两张图的可见差异，报告异常或不确定处。';

async function reviewSamples({decoded,evidence,source,question,readNative,signal,check,reviewerModel}){
  const prompt=`这是同一个 GIF 实际解码得到的静态 PNG 检查页，帧索引从 0 开始。总帧数 ${evidence.totalFrames}；检查页仅包含索引 ${evidence.sampledFrameIndices.join('、')}。没有提供实时播放。仅就确实能辨识的样本帧做审阅，未看到的帧不推断。`+
    '外层请遵守附件读取器 JSON 格式；content 字符串填写无 Markdown 的 JSON 对象，结构为 {"checkedFrameIndices":[0],"verdict":"matches|deviation|uncertain","conclusion":"简要写出可核对的观察和不确定性"}。其中 checkedFrameIndices 必须列出本次实际确认观察的索引，括号中的 0 只是结构示例。verdict 从三个值中选一个。'+
    `\n本次视觉检查问题：${question}`;
  const native=await readNative({bytes:decoded.png,filename:'gif-contact-sheet.png',mime:'image/png',question:prompt,signal});
  check();
  return {...evidence,...visualReading(native,evidence.sampledFrameIndices),reviewer:{kind:'model',model:reviewerModel},sourceSha256:source.sha256,reviewedAt:Date.now()};
}

/** Host-only background entry. No dependence on the selected project or file. */
export function createBackgroundGifReview({readNative,sample=sampleSheet,reviewerModel=NATIVE_FILE_READER_MODEL}){
  return async({path,expected,question,snapshot,signal,evidenceDir,check:verify=()=>{}})=>{
    const check=()=>{signal?.throwIfAborted();verify();};
    const args=normalize({path,...(question!==undefined?{question}:{})});
    let source,evidence,runtime,artifacts=[];
    try{
      check();
      if(extname(path).toLowerCase()!=='.gif'||!expected?.sha256)throw Error('gif_review_invalid_input');
      const loaded=await loadGif(path,expected,check);
      source={path,sha256:loaded.sha256,bytes:loaded.bytes.length};
      const decoded=await sample({bytes:loaded.bytes,snapshot,signal});
      check();
      evidence=validateSample(decoded,source);runtime=decoded.runtime;
      mkdirSync(evidenceDir,{recursive:true,mode:0o700});
      if(realpathSync(evidenceDir)!==evidenceDir)throw Error('gif_review_source_unavailable');
      const name='gif-contact-sheet.png',sheetPath=join(evidenceDir,name);
      writeFileSync(sheetPath,decoded.png,{mode:0o400,flag:'wx'});
      artifacts=[{path:sheetPath,name,format:'png',role:'contactSheet',bytes:decoded.png.length,sha256:evidence.contactSheetSha256,scope:'evidence'}];
      const visualReview=await reviewSamples({decoded,evidence,source,question:args.question,readNative,signal,check,reviewerModel});
      return {status:visualReview.status==='unreadable'?'failed':'completed',source,artifacts,runtime,visualReview,
        ...(visualReview.status==='unreadable'?{error:'gif_review_unreadable'}:{})};
    }catch(error){
      return {status:signal?.aborted?'cancelled':'failed',error:signal?.aborted?'cancelled':errorCodes.has(error?.message)?error.message:errorEvent(error,'conversation').code,
        source,artifacts,runtime,visualReview:{...evidence,status:'not_checked',checkedFrameIndices:[],sourceSha256:source?.sha256}};
    }
  };
}

function normalize(args){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['operationId','path','current','question'].includes(k))||
    (args.current!==undefined&&args.current!==true)||[args.operationId,args.path,args.current].filter(v=>v!==undefined).length!==1||
    (args.operationId!==undefined&&(typeof args.operationId!=='string'||!args.operationId||args.operationId.length>200))||
    (args.question!==undefined&&(typeof args.question!=='string'||!args.question.trim()||args.question.length>2000||args.question.includes('\0'))))
    throw Error('invalid_gif_review');
  return {...args,question:args.question?.trim()||defaultQuestion};
}

export function createGifReviewer({ops,projects,getRequest,readNative,getRuntime,sample=sampleSheet,reviewerModel=NATIVE_FILE_READER_MODEL}){
  const running=new Map();
  for(const record of ops.list('tool'))if(record.operation==='gif_review'&&record.status==='running'){
    ops.put({...record,status:'interrupted',error:'gif_review_interrupted',finishedAt:Date.now()});
  }
  async function review(input,{signal,callId}={}){
    const request=getRequest(),binding=request?.binding;
    const check=()=>{
      const state=projects.state();
      if(getRequest()!==request||!request?.id||binding?.focus!=='work'||state.focus!=='work'||binding.projectId!==request.projectId||
          state.projectId!==binding.projectId||state.revision!==binding.revision||request.cancelled||request.projectChanged||request.signal?.aborted||signal?.aborted)
        throw Error('project_state_changed');
    };
    check();
    if(typeof callId!=='string'||!callId||callId.length>256)throw Error('invalid_command_id');
    const args=normalize(input);
    const id='gif-review-'+sha256(JSON.stringify([binding.projectId,request.id,callId])).slice(0,40),fingerprint=sha256(JSON.stringify(args));
    let existing;try{existing=ops.get(id);}catch(error){if(error.message!=='unknown_id')throw error;}
    if(existing){if(existing.fingerprint!==fingerprint)throw Error('command_id_conflict');return running.get(id)??existing;}
    const record={id,kind:'tool',tool:'gif_review',operation:'gif_review',description:'抽帧审阅 GIF',status:'running',fingerprint,
      projectId:binding.projectId,requestId:request.id,createdAt:Date.now()};
    ops.put(record);
    const finish=patch=>ops.put({...record,...patch,finishedAt:Date.now()});
    const work=(async()=>{
      let source,evidence,generation;
      try{
        const snapshot=getRuntime?.();
        if(snapshot)record.skillVersion=snapshot.version;
        const workspace=realpathSync(binding.cwd),current=binding.context?.kind==='file'?binding.context.file:null;
        let path,loaded;
        if(args.operationId){
          const value=await generatedImageVersion({ops,projects},{operationId:args.operationId,artifact:'gif',
            expectedProject:{projectId:binding.projectId,revision:binding.revision}},{allowGif:true});
          generation=ops.get(args.operationId);
          path=projectPath(workspace,generation.artifacts.gif.path);
          loaded={bytes:value.bytes,sha256:sha256(value.bytes)};
          if(loaded.sha256!==generation.artifacts.gif.sha256)throw Error('gif_review_source_changed');
        }else{
          path=projectPath(workspace,args.current?current?.path:args.path);
          if(extname(path).toLowerCase()!=='.gif')throw Error('gif_review_invalid_input');
          const expected=path===current?.path?current:(request.fileReferences??binding.projectContext?.references??[]).find(ref=>ref.path===path)?.version;
          if(expected?.projectId&&expected.projectId!==binding.projectId)throw Error('project_state_changed');
          loaded=await loadGif(path,expected,check);
        }
        check();
        if(loaded.bytes.length>maxGif)throw Error('gif_review_invalid_input');
        source={path,sha256:loaded.sha256,bytes:loaded.bytes.length,...(generation?{operationId:generation.id}:{})};
        const signals=[signal,request.signal].filter(Boolean),effective=signals.length?AbortSignal.any(signals):undefined;
        const decoded=await sample({bytes:loaded.bytes,signal:effective,snapshot});
        evidence=validateSample(decoded,source);check();
        if(decoded.runtime)record.runtime=decoded.runtime;
        const visualReview=await reviewSamples({decoded,evidence,source,question:args.question,readNative,signal:effective,check,reviewerModel});
        const result=finish({status:visualReview.status==='unreadable'?'failed':'completed',...(visualReview.status==='unreadable'?{error:'gif_review_unreadable'}:{}),
          source,visualReview,output:visualReview.conclusion});
        if(generation&&result.status==='completed'){
          const latest=ops.get(generation.id);
          if(latest.artifacts?.gif?.sha256===source.sha256&&latest.projectId===record.projectId&&latest.status==='completed')
            ops.put({...latest,visualReview:{...visualReview,reviewOperationId:id}});
        }
        return result;
      }catch(error){
        const cancelled=signal?.aborted||request.signal?.aborted||request.cancelled||request.projectChanged;
        return finish({status:cancelled?'cancelled':'failed',error:cancelled?'cancelled':errorCodes.has(error?.message)?error.message:errorEvent(error,'conversation').code,
          ...(source?{source}:{}),...(evidence?{visualReview:{...evidence,status:'not_checked',checkedFrameIndices:[],sourceSha256:source.sha256}}:{})});
      }
    })();
    running.set(id,work);void work.finally(()=>running.delete(id)).catch(()=>{});return work;
  }
  return {review};
}

export function createGifReviewTool(reviewer){
  return ['gif_review','对项目中实际保存的 GIF 抽帧并走内部图片读取审阅。传图像的生成 operationId、同项目 GIF path、或 current=true 三选一。只用回执中已经确认的帧和结论，不因导出了检查页就称已审阅，不把抽帧当作播放或全帧检查。不会切换当前文件。',{
    operationId:{type:'string',description:'已完成的 GIF 生成操作编号。'},path:{type:'string',description:'项目内已存在的 GIF 路径。'},
    current:{type:'boolean',description:'引用本轮冻结的当前文件（只能是 GIF）。'},question:{type:'string',description:'想核对的角色、动作或效果。'},
  },(args,exec)=>reviewer.review(args,exec)];
}
