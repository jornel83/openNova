/** Admission-owned fixed bytes. The worker's editable copy is never evidence. */
import {createHash,randomUUID} from 'node:crypto';
import {constants,openSync,closeSync,readSync,fstatSync,lstatSync,realpathSync,readdirSync,mkdirSync,writeFileSync,linkSync,unlinkSync} from 'node:fs';
import {resolve,join,dirname,basename,extname,isAbsolute,relative,sep} from 'node:path';
import {nativeFileMime} from '../desktop/file-types.mjs';
import {validNativeFileHeader} from '../desktop/file-reader.mjs';

const maxSize=20*1024*1024,maxTotal=40*1024*1024;
const textExt=/\.(txt|md|csv|json|yaml|yml|log)$/i;
const excluded=s=>!s||s.startsWith('.')||/^(node_modules|output|dist|memory|sessions)$/i.test(s)||/(secret|credential|token|password|\.local\.)/i.test(s);
const checkedName=p=>typeof p==='string'&&p.length>0&&p.length<=4096&&!/[\\\u0000-\u001f]/.test(p)&&!/^\w+:/.test(p)&&!p.startsWith('//')&&!p.split('/').includes('..');
const validLocal=p=>checkedName(p)&&!isAbsolute(p)&&p.split('/').every(s=>!excluded(s))&&!!(nativeFileMime(p)||textExt.test(p));
const signature=s=>({size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs,ino:s.ino,dev:s.dev});
const matches=(a,b)=>['size','mtimeMs','ctimeMs','ino','dev','sha256'].every(k=>a?.[k]===undefined||a[k]===b[k]);
const sha=b=>createHash('sha256').update(b).digest('hex');
export const isFrozenDocumentResearch=t=>t?.documentResearch===true&&t.workspaceMode==='documents'&&t.inputSnapshot?.version===2;
function fail(code='invalid_document_inputs'){throw Error(code);}
export function documentInputNames(files){
  if(!Array.isArray(files)||files.length>10||files.some(p=>!checkedName(p)||!validLocal(isAbsolute(p)?basename(p):p)))fail();
  return [...new Set(files)];
}
function readBytes(path,limit,expected,{cached=false}={}){
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=fstatSync(fd);
    if(!before.isFile()||before.size>limit)fail('invalid_document_inputs');
    const bytes=Buffer.alloc(before.size+1);let n=0;
    while(n<bytes.length){const x=readSync(fd,bytes,n,bytes.length-n,null);if(!x)break;n+=x;}
    // Publishing a second hard link to identical cached bytes changes ctime.
    // For the cache the required digest verifies contents; the inode verifies identity.
    const identity=cached?{size:before.size,dev:before.dev,ino:before.ino}:signature(before);
    if(n!==before.size||!matches(identity,fstatSync(fd))||!matches(identity,lstatSync(path)))fail('task_inputs_changed');
    const data=bytes.subarray(0,n),version={...signature(before),sha256:sha(data)};
    if(expected&&!matches(expected,version))fail('task_inputs_changed');
    return {bytes:data,version};
  }finally{closeSync(fd);}
}
function cachePath(home,file){
  if(!file||!validLocal(file.path)||!/^[a-f0-9]{64}$/.test(file.sha256))fail('task_input_snapshot_corrupt');
  return join(realpathSync(home),'file-inputs',file.sha256+extname(file.path).toLowerCase());
}
export function readTaskInputBytes(home,file){
  try{
    const path=cachePath(home,file);if(path!==file.snapshotPath||realpathSync(path)!==path)fail();
    return readBytes(path,nativeFileMime(file.path)?maxSize:65536,{size:file.size,sha256:file.sha256},{cached:true}).bytes;
  }catch{throw Error('task_input_snapshot_corrupt');}
}
function deposit(home,file,bytes){
  const path=cachePath(home,file),parent=dirname(path);mkdirSync(parent,{recursive:true,mode:0o700});
  if(realpathSync(parent)!==parent)fail('task_input_snapshot_corrupt');
  const tmp=join(parent,'.task-'+randomUUID());file.snapshotPath=path;
  try{
    writeFileSync(tmp,bytes,{mode:0o600,flag:'wx'});
    try{linkSync(tmp,path);}catch(error){if(error.code!=='EEXIST')throw error;readTaskInputBytes(home,file);}
  }finally{try{unlinkSync(tmp);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
export function freezeDocumentInputs({home,source,projectId,inputFiles,currentFile,current,references=[]}){
  if(!projectId)fail('project_work_request_required');
  const root=realpathSync(source),selected=new Map(),refs=new Map(),names=documentInputNames(inputFiles);
  for(const r of references)if(typeof r?.path==='string'&&isAbsolute(r.path)&&(!r.projectId||r.projectId===projectId)&&r.status!=='removed'&&r.kind!=='directory')refs.set(resolve(r.path),r.version??r);
  if(current?.path&&current.projectId&&current.projectId!==projectId)current=null;
  if(current?.path&&!refs.has(resolve(current.path)))refs.set(resolve(current.path),current);
  function select(full,isCurrent=false){
    const path=resolve(full),rel=relative(root,path),outside=rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel),name=outside?basename(path):rel;
    if(!validLocal(name)||outside&&!refs.has(path)||realpathSync(path)!==path)fail();
    const previous=selected.get(name);
    if(previous&&previous.path!==path)fail('ambiguous_task_input');
    selected.set(name,{path,current:isCurrent||previous?.current===true});
  }
  for(const name of names){
    if(isAbsolute(name)||name.includes('/')){select(resolve(root,name));continue;}
    // A bare filename may occur in a subdirectory or in linked project materials.
    const candidates=new Set([...refs.keys()].filter(p=>basename(p)===name));let seen=0;
    const walk=dir=>{for(const e of readdirSync(dir,{withFileTypes:true})){
      if(++seen>10000)fail('task_input_search_incomplete');
      if(excluded(e.name))continue;
      if(e.isDirectory())walk(join(dir,e.name));else if(e.name===name)candidates.add(join(dir,e.name));
    }};walk(root);
    if(candidates.size>1)fail('ambiguous_task_input');if(!candidates.size)fail('task_input_not_found');
    select([...candidates][0]);
  }
  if(currentFile){if(!current?.path)fail('current_file_required');select(current.path,true);}
  if(selected.size>10)fail();
  let totalBytes=0;const files=[];
  for(const [name,entry] of selected){
    const mime=nativeFileMime(name),{bytes,version}=readBytes(entry.path,mime?maxSize:65536,refs.get(entry.path));
    if(entry.current){
      const expected=current.version??current;
      const sourceId='file-source-'+sha(JSON.stringify([projectId,entry.path,version.sha256]));
      if(!matches(expected,version)||current.sourceId&&current.sourceId!==sourceId)fail('task_inputs_changed');
    }
    if((totalBytes+=bytes.length)>maxTotal)fail('task_inputs_too_large');
    if(mime?!validNativeFileHeader(bytes,extname(name).toLowerCase()):bytes.includes(0))fail(mime?'file_format_mismatch':'document_input_not_text');
    if(realpathSync(entry.path)!==entry.path)fail('task_inputs_changed');
    const file={path:name,sourcePath:entry.path,...version,...(mime?{mime}:{}),...(entry.current?{current:true}:{})};
    deposit(home,file,bytes);files.push(file);
  }
  // All admitted versions must have coexisted. A later input may have taken
  // time to copy while another process was replacing an earlier input.
  for(const file of files){
    try{
      if(realpathSync(file.sourcePath)!==file.sourcePath||!matches(signature(file),lstatSync(file.sourcePath)))fail();
    }catch{fail('task_inputs_changed');}
  }
  return {version:2,source:root,projectId,files,totalBytes};
}
export function documentDestination(root,raw){
  if(!checkedName(raw)||!(/\.(pdf|docx)$/.test(raw)))fail('invalid_document_output');
  return resolve(root,raw);
}
