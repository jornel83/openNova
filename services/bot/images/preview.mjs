/** Read only the saved media version identified by a completed operation. */
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,realpath,stat as fileStat} from 'node:fs/promises';
import {isAbsolute,relative,sep} from 'node:path';

const contentTypes=new Map([['png','image/png'],['jpeg','image/jpeg'],['webp','image/webp']]);
const gifParts=new Map([['gif','gif'],['firstFrame','png'],['video','mp4']]);
const gifContentTypes=new Map([['gif','image/gif'],['png','image/png'],['mp4','video/mp4']]);
const maxPreviewBytes=64*1024*1024;

export async function generatedImageVersion({ops,projects},input,{allowGif=false}={}){
  const part=input?.artifact;
  const allowedKeys=allowGif?['operationId','expectedProject','artifact']:['operationId','expectedProject'];
  if(typeof input?.operationId!=='string'||!input.operationId||input.operationId.length>200||
      Object.keys(input).some(key=>!allowedKeys.includes(key))||!input.expectedProject||
      (part!==undefined&&!gifParts.has(part)))
    throw Error('invalid_image_preview');
  const state=projects.validateExpected(input.expectedProject);
  const record=ops.get(input.operationId);
  if(state.focus!=='work'||state.projectId!==record.projectId)throw Error('project_state_changed');
  if(record.kind!=='tool'||record.status!=='completed')throw Error('image_preview_unavailable');
  const file=part===undefined?record.file:undefined;
  const artifact=part===undefined?record.artifact:record.artifacts?.[part];
  const contentType=part===undefined?contentTypes.get(artifact?.format):gifContentTypes.get(artifact?.format);
  if((part===undefined
      ?record.operation!=='image_generate'||!file?.id||file.path!==artifact?.path
      :record.operation!=='gif_generate'||artifact?.format!==gifParts.get(part))||
      !artifact?.path||!contentType||
      !/^[a-f0-9]{64}$/.test(artifact.sha256))throw Error('image_preview_unavailable');

  const workspace=await realpath(projects.project().workspace);
  const path=await realpath(artifact.path).catch(()=>{throw Error('image_artifact_changed');});
  const local=relative(workspace,path);
  if(artifact.path!==path||!local||local==='..'||local.startsWith('..'+sep)||isAbsolute(local))throw Error('image_artifact_changed');
  const bytes=await readPreviewBytes(artifact,'image_artifact_changed');
  projects.validateExpected(input.expectedProject);
  return {bytes,contentType,file,...(part!==undefined?{artifact}:{})};
}

export async function readPreviewBytes(artifact,errorCode){
  const path=artifact.path;
  if(await realpath(path).catch(()=>null)!==path)throw Error(errorCode);
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(()=>{throw Error(errorCode);});
  try{
    const stat=await handle.stat();
    if(!stat.isFile()||!stat.size||stat.size>maxPreviewBytes||stat.size!==(artifact.bytes??artifact.size))
      throw Error(errorCode);
    const fields=['size','ino','mtimeMs','ctimeMs'];
    if(artifact.version&&fields.some(field=>stat[field]!==artifact.version[field]))throw Error(errorCode);
    // Read exactly the recorded size even if a file grows while open.
    const bytes=Buffer.alloc(stat.size);
    let offset=0;
    while(offset<bytes.length){
      const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);
      if(!bytesRead)throw Error(errorCode);
      offset+=bytesRead;
    }
    const latest=await fileStat(path).catch(()=>null);
    if(!latest||fields.some(field=>stat[field]!==latest[field])||
        createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)throw Error(errorCode);
    return bytes;
  }finally{await handle.close();}
}
