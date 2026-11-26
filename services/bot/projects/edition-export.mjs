/** Read and print a host-owned project edition without reconstructing it from chat. */
import {createHash} from 'node:crypto';
import {lstatSync,realpathSync} from 'node:fs';
import {basename,dirname,extname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {readDocument} from '../documents/generator.mjs';
import {readHandoffSource} from './handoff.mjs';
import {readExperimentSource} from '../experiments/service.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');

function editionSource(ops,projectId,sourceId){
  if(!projectId||typeof sourceId!=='string'||!sourceId||sourceId.length>256)throw Error('project_edition_not_found');
  const source=sourceId.startsWith('experiment-')?readExperimentSource(ops,projectId,sourceId):readHandoffSource(ops,projectId,sourceId);
  if(source.projectId!==projectId||source.sourceId!==sourceId)throw Error('project_edition_not_found');
  return {...source,links:source.links??[],sourceSha256:digest(source.text)};
}

function matchesEdition(artifact,source){
  const ref=artifact?.sourceEdition;
  return artifact?.kind==='document_artifact'&&artifact.projectId===source.projectId&&
    ref?.projectId===source.projectId&&ref.sourceId===source.sourceId&&ref.sha256===source.sourceSha256;
}

function exportView(row){
  let diskStatus;
  try{
    const stat=lstatSync(row.path);
    if(!stat.isFile()||stat.size!==row.size)diskStatus='changed';
    else if(['ino','size','mtimeMs','ctimeMs'].every(key=>stat[key]===row.version?.[key]))diskStatus='unchanged';
    else diskStatus=digest(readDocument(row.path).bytes)===row.sha256?'unchanged':'changed';
  }
  catch(error){diskStatus=['ENOENT','ENOTDIR'].includes(error.code)?'missing':
    ['ELOOP','document_file_size_invalid','document_file_required','document_file_changed'].includes(error.code??error.message)?'changed':'unknown';}
  return {id:row.id,format:row.format,path:row.path,sha256:row.sha256,size:row.size,diskStatus};
}

export function readProjectEdition(ops,projectId,sourceId){
  const source=editionSource(ops,projectId,sourceId);
  const candidates=ops.db.prepare("SELECT body FROM records WHERE kind='document_artifact' AND json_extract(body,'$.projectId')=? AND json_extract(body,'$.sourceEdition.sourceId')=? ORDER BY rowid DESC")
    .all(projectId,sourceId).map(({body})=>JSON.parse(body));
  return {...source,exports:candidates.filter(row=>matchesEdition(row,source)).map(exportView)};
}

export function readProjectEditionArtifact(ops,projectId,sourceId,artifactId){
  const source=editionSource(ops,projectId,sourceId);
  if(typeof artifactId!=='string'||!artifactId.startsWith('document-artifact-'))throw Error('project_edition_artifact_not_found');
  let artifact;
  try{artifact=ops.get(artifactId);}catch(error){if(error.message!=='unknown_id')throw error;}
  if(!matchesEdition(artifact,source))throw Error('project_edition_artifact_not_found');
  // Downloads always serve the generator's immutable publication snapshot.
  // A user's newer edits to the visible output file cannot replace these bytes.
  let bytes;
  try{bytes=readDocument(artifact.snapshotPath).bytes;}catch{throw Error('project_edition_snapshot_unavailable');}
  if(bytes.length!==artifact.size||digest(bytes)!==artifact.sha256)throw Error('project_edition_snapshot_changed');
  return {name:basename(artifact.path),format:artifact.format,bytes,sha256:artifact.sha256};
}

function documentSpec(source){
  const blocks=[];
  let paragraphs=source.text.split(/\r?\n[ \t]*\r?\n/u);
  if(paragraphs.length>400)paragraphs=[source.text];
  for(const paragraph of paragraphs){
    // Unicode-aware chunks also fit the renderer when one log is a very long line.
    for(const text of paragraph.match(/[\s\S]{1,12000}/gu)??[])if(text.trim())blocks.push({type:'paragraph',text});
  }
  blocks.push({type:'heading',level:2,text:'版本引用'},
    {type:'paragraph',text:'项目 '+source.projectId+'\n来源 '+source.sourceId+'\n正文 SHA-256 '+source.sourceSha256});
  if(source.links.length)blocks.push({type:'list',ordered:false,items:source.links.map(link=>link.title+' · '+link.sourceId)});
  return {schemaVersion:1,title:source.title,blocks};
}

function exportPath(source,format,outputPath,cwd){
  if(outputPath===undefined){
    const stem=Array.from(source.title.replace(/[\\/:*?"<>|\x00-\x1f]/gu,' ').trim()).slice(0,44).join('')||'成果';
    return join(cwd,'成果导出',stem+'-'+digest(source.sourceId).slice(0,12)+'.'+format);
  }
  if(typeof outputPath!=='string'||!outputPath.trim()||outputPath.length>4096||/[\x00-\x1f]/u.test(outputPath)||
    /^[\w+.-]+:/.test(outputPath)||outputPath.startsWith('//')||extname(outputPath)!=='.'+format)throw Error('invalid_edition_output_path');
  return resolve(cwd,outputPath.startsWith('~/')?join(homedir(),outputPath.slice(2)):outputPath);
}

function canonicalTarget(path){
  try{return join(realpathSync(dirname(path)),basename(path));}
  catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))return path;throw error;}
}

export const PROJECT_EDITION_INSTRUCTIONS='查看或正式导出已有交接说明、逐轮验收记录、决定或实验记录的指定版本时，用 project_edition。先从所属项目的交接或实验工具找到该轮固定 sourceId。export 按该编号原样生成 Word/PDF。不要从聊天重写正文或用最新轮次替代指定版本。';

export function createProjectEditionTool({ops,generator,getRequest}){
  // The generator reconciles publication before the foreground tools are installed.
  const unfinished=ops.db.prepare("SELECT body FROM records WHERE kind='tool' AND json_extract(body,'$.operation')='project_edition' AND json_extract(body,'$.status') IN ('running','interrupted')").all();
  for(const {body} of unfinished){
    const receipt=JSON.parse(body);
    let job;
    try{job=ops.get('generate-'+receipt.id);}catch(error){if(error.message!=='unknown_id')throw error;}
    if(job?.status==='completed'&&job.artifact?.sourceEdition?.sourceId===receipt.sourceIds[0]&&job.projectId===receipt.projectId)
      ops.put({...receipt,status:'completed',artifactId:job.artifact.id,recovered:true,error:undefined});
    else if(receipt.status==='running')ops.put({...receipt,status:'interrupted',error:'edition_export_interrupted'});
  }
  return ['project_edition',PROJECT_EDITION_INSTRUCTIONS,{
    action:{type:'string',enum:['read','export'],required:true},sourceId:{type:'string',required:true,description:'所属项目内已保存的固定版本编号。'},
    format:{type:'string',enum:['docx','pdf'],description:'导出时必填。'},outputPath:{type:'string',description:'可选的成品路径，默认保存在项目的成果导出目录。'},
  },async(input,exec={})=>{
    const request=getRequest(),binding=request?.binding;
    if(!request?.id||binding?.focus!=='work'||!binding.projectId||binding.projectId!==request.projectId||!binding.cwd||request.projectChanged)throw Error('project_work_request_required');
    if(request.cancelled||request.signal?.aborted||exec.signal?.aborted)throw Error('cancelled');
    if(!exec.callId)throw Error('bridge_call_required');
    const {action,sourceId,format,outputPath}=input;
    const allowed=action==='export'?['action','sourceId','format','outputPath']:['action','sourceId'];
    if(!['read','export'].includes(action)||Object.keys(input).some(key=>!allowed.includes(key))||
      action==='export'&&!['docx','pdf'].includes(format))throw Error('invalid_project_edition');
    const source=readProjectEdition(ops,request.projectId,sourceId);
    const id='edition-'+digest(JSON.stringify([request.id,exec.callId])).slice(0,40);
    const path=action==='export'?exportPath(source,format,outputPath,binding.cwd):undefined;
    const signature=digest(JSON.stringify([request.projectId,action,sourceId,format,path]));
    let prior;
    try{prior=ops.get(id);}catch(error){if(error.message!=='unknown_id')throw error;}
    if(prior&&prior.signature!==signature)throw Error('command_id_conflict');
    const receipt={id,kind:'tool',operation:'project_edition',tool:'project_edition',action,signature,projectId:request.projectId,requestId:request.id,
      sourceIds:[sourceId],title:source.title,createdAt:prior?.createdAt??Date.now()};
    if(action==='read'){
      ops.put({...receipt,status:'completed'});return source;
    }
    const complete=artifact=>({status:'completed',sourceId,title:source.title,sourceSha256:source.sourceSha256,artifact});
    if(prior?.status==='completed'){
      const issued=source.exports.find(item=>item.id===prior.artifactId);
      if(!issued)throw Error('project_edition_artifact_not_found');
      return complete(issued);
    }
    const canonicalPath=canonicalTarget(path);
    // Claim this call ID synchronously so concurrent uses cannot bind it to two editions.
    ops.put({...receipt,status:'running'});
    let artifact=source.exports.find(item=>item.path===canonicalPath);
    if(artifact?.diskStatus!=='unchanged'){
      // Reuse only intact publications. The generator uses atomic no-clobber
      // writes even if two distinct turns request the same output path at once.
      const reference={projectId:source.projectId,sourceId,sha256:source.sourceSha256};
      let result;
      try{
        result=await generator.generate({format,outputPath:path},{id:'generate-'+id,request,signal:exec.signal,edition:{reference,spec:documentSpec(source)}});
      }catch(error){
        ops.put({...receipt,status:'failed',error:error.message});throw error;
      }
      if(result.status==='completed'&&result.artifact){
        artifact=exportView(result.artifact);
        if(artifact.diskStatus!=='unchanged'){
          const error='edition_export_file_changed';ops.put({...receipt,status:'failed',error});return {status:'failed',sourceId,error};
        }
      }else if(result.error==='document_target_exists'){
        artifact=readProjectEdition(ops,request.projectId,sourceId).exports.find(item=>item.path===canonicalTarget(path)&&item.diskStatus==='unchanged');
        if(!artifact){ops.put({...receipt,status:'failed',error:result.error});return {status:'failed',sourceId,error:result.error};}
      }else{
        ops.put({...receipt,status:result.status,error:result.error});return {status:result.status,sourceId,error:result.error};
      }
    }
    ops.put({...receipt,status:'completed',artifactId:artifact.id});
    return complete(artifact);
  }];
}
