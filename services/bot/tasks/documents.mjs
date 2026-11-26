/** Explicit text inputs only; task outputs never overwrite the source project. */
import {existsSync,lstatSync,realpathSync,readFileSync,mkdirSync,writeFileSync,copyFileSync,chmodSync,openSync,readSync,fstatSync,closeSync,constants,rmSync,renameSync,mkdtempSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {readJson,saveJson} from './agent-files.mjs';
import {readTaskInputBytes} from './frozen-documents.mjs';
const valid=p=>typeof p==='string'&&p.length>0&&p.length<=500&&!p.includes('\\')&&!p.includes('\0')&&!p.startsWith('/')&&p.split('/').every(c=>c&&c!=='.'&&c!=='..'&&!c.startsWith('.')&&!/^(node_modules|output|dist|memory|sessions)$/i.test(c))&&!/(secret|credential|token|password|\.local\.)/i.test(p)&&/\.(txt|md|csv|json|yaml|yml|log)$/i.test(p);
export function validateInputFiles(source,files){
  if(!Array.isArray(files)||files.length>10||files.some(p=>!valid(p)))throw Error('invalid_document_inputs');
  for(const p of files){let path=source;for(const c of p.split('/')){path=join(path,c);if(lstatSync(path).isSymbolicLink())throw Error('invalid_document_inputs');}
    if(!lstatSync(path).isFile()||lstatSync(path).size>65536||!realpathSync(path).startsWith(realpathSync(source)+'/'))throw Error('invalid_document_inputs');}
  return [...new Set(files)];
}
export function validateGeneralInputs(source,files){
  if(!Array.isArray(files)||files.length>20||files.some(p=>typeof p!=='string'||!p||p.length>500||p.includes('\\')||p.includes('\0')||p.startsWith('/')||p.split('/').some(c=>!c||c==='..'||c.startsWith('.')||/^(node_modules|output|dist|memory|sessions)$/i.test(c))||/(secret|credential|token|password|\.local\.)/i.test(p)))throw Error('invalid_document_inputs');
  for(const p of files){let path=source;for(const c of p.split('/')){path=join(path,c);if(lstatSync(path).isSymbolicLink())throw Error('invalid_document_inputs');}
    if(!lstatSync(path).isFile()||lstatSync(path).size>20*1024*1024||!realpathSync(path).startsWith(realpathSync(source)+'/'))throw Error('invalid_document_inputs');}
  return [...new Set(files)];
}
const signature=stat=>({size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs,ino:stat.ino,dev:stat.dev});
const equalVersion=(expected,actual)=>['size','mtimeMs','ctimeMs','ino','dev','sha256'].every(key=>expected[key]===undefined||expected[key]===actual[key]);
const budget=mode=>mode==='documents'?{files:10,bytes:65536}:{files:20,bytes:20*1024*1024};
function inputVersion(path,maxBytes){
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const before=fstatSync(fd);if(!before.isFile()||before.size>maxBytes)throw Error('task_inputs_changed');
    const sha=createHash('sha256'),buffer=Buffer.allocUnsafe(Math.min(maxBytes+1,1024*1024));let length,total=0;
    while((length=readSync(fd,buffer,0,buffer.length,null))>0){total+=length;if(total>maxBytes)throw Error('task_inputs_changed');sha.update(buffer.subarray(0,length));}
    const after=fstatSync(fd);if(!equalVersion(signature(before),signature(after))||total!==before.size)throw Error('task_inputs_changed');
    return {...signature(before),sha256:sha.digest('hex')};
  }finally{closeSync(fd);}
}
/** Bound only explicit inputs; never recursively hash a project or follow its references. */
export function captureTaskInputs(source,inputFiles,{workspaceMode='general',references=[]}={}){
  const files=(workspaceMode==='documents'?validateInputFiles:validateGeneralInputs)(source,inputFiles),limits=budget(workspaceMode),root=realpathSync(source),captured=[];
  if(files.length>limits.files)throw Error('invalid_document_inputs');
  for(const path of files){
    const full=join(root,path),sourcePath=realpathSync(full),version=inputVersion(full,limits.bytes);
    for(const reference of references){
      if(!reference?.path)continue;
      let referencePath;try{referencePath=realpathSync(reference.path);}catch{referencePath=resolve(reference.path);}
      if(referencePath===sourcePath&&!equalVersion(reference.version??reference,version))throw Error('task_inputs_changed');
    }
    if(realpathSync(full)!==sourcePath)throw Error('task_inputs_changed');captured.push({path,sourcePath,...version});
  }
  return {version:1,source:root,files:captured,totalBytes:captured.reduce((n,file)=>n+file.size,0)};
}
function verifyTaskInputs(source,inputFiles,workspaceMode,snapshot){
  try{
    const current=captureTaskInputs(source,inputFiles,{workspaceMode});
    if(snapshot.version!==1||snapshot.source!==current.source||snapshot.files.length!==current.files.length||snapshot.totalBytes!==current.totalBytes||current.files.some((file,index)=>{
      const expected=snapshot.files[index];return expected.path!==file.path||expected.sourcePath!==file.sourcePath||!equalVersion(expected,file);
    }))throw Error();
  }catch{throw Error('task_inputs_changed');}
}
export async function prepareDocuments({source,home,mode,inputFiles=[],workspaceMode='documents',inputSnapshot}){
  if(!['documents','general'].includes(workspaceMode))throw Error('invalid_workspace_mode');
  // A completed workspace owns its copies. Continuation does not reread or
  // require an original source that the user subsequently moved or removed.
  if(inputSnapshot?.version===2)source=resolve(source);
  else try{source=realpathSync(source);}catch{source=resolve(source);}
  mkdirSync(home,{recursive:true,mode:0o700});home=realpathSync(home);const saved=readJson(join(home,'workspace.json'));
  if(saved){
    if(saved.source!==source||saved.kind!==workspaceMode||!existsSync(saved.path))throw Error('task_workspace_missing');
    if(inputSnapshot?.version===2&&(saved.path!==join(home,'workspace')||realpathSync(saved.path)!==saved.path||!lstatSync(saved.path).isDirectory()))throw Error('task_workspace_missing');
    return saved;
  }
  if(inputSnapshot?.version===2){
    if(workspaceMode!=='documents'||inputSnapshot.source!==source||inputFiles.length!==inputSnapshot.files.length||
       inputSnapshot.files.some((f,i)=>inputFiles[i]!==f.path))throw Error('task_input_snapshot_corrupt');
    const botHome=resolve(home,'../../..'),path=join(home,'workspace');
    const inputBaseline=Object.fromEntries(inputSnapshot.files.map(file=>[file.path,{size:file.size,sha256:file.sha256}]));
    const key=createHash('sha256').update(JSON.stringify([source,inputSnapshot.projectId,inputBaseline])).digest('hex');
    // The receipt is outside the editable workspace. Its directory identity
    // survives rename and distinguishes our publication from a user's directory.
    const receipt=stat=>join(home,`prepare-${stat.dev}-${stat.ino}.json`);
    function finishPublished(verifyCopies=true){
      const stat=lstatSync(path);
      if(!stat.isDirectory()||realpathSync(path)!==path||readJson(receipt(stat))?.key!==key)throw Error('task_workspace_missing');
      if(verifyCopies)for(const file of inputSnapshot.files){
        const p=join(path,file.path);if(realpathSync(p)!==p||inputVersion(p,file.size).sha256!==file.sha256)throw Error('task_workspace_missing');
      }
      const result={kind:workspaceMode,source,path,mode,inputFiles,inputBaseline,createdAt:Date.now()};
      saveJson(join(home,'workspace.json'),result);
      return result;
    }
    if(existsSync(path))return finishPublished();
    const stage=mkdtempSync(join(home,'prepare-'));
    try{
      for(const file of inputSnapshot.files){
        const bytes=readTaskInputBytes(botHome,file),target=join(stage,file.path);mkdirSync(dirname(target),{recursive:true,mode:0o700});
        writeFileSync(target,bytes,{flag:'wx',mode:0o600});
      }
      saveJson(receipt(lstatSync(stage)),{key});
      if(!existsSync(path)){
        try{renameSync(stage,path);}catch(error){if(!['ENOTEMPTY','EEXIST'].includes(error.code))throw error;}
      }
      return finishPublished(existsSync(stage));
    }finally{rmSync(stage,{recursive:true,force:true});}
  }
  if(inputSnapshot)verifyTaskInputs(source,inputFiles,workspaceMode,inputSnapshot);
  (workspaceMode==='general'?validateGeneralInputs:validateInputFiles)(source,inputFiles);const path=resolve(home,'workspace');
  if(existsSync(path))throw Error('workspace_preparation_interrupted');mkdirSync(path,{recursive:true,mode:0o700});
  const inputBaseline={};
  try{
    for(const file of inputFiles){const target=join(path,file);mkdirSync(dirname(target),{recursive:true});
      if(workspaceMode==='general'){copyFileSync(join(source,file),target);chmodSync(target,0o600);}
      else{const content=readFileSync(join(source,file));if(content.includes(0))throw Error('document_input_not_text');writeFileSync(target,content,{mode:0o600});}
      const version=inputVersion(target,budget(workspaceMode).bytes);inputBaseline[file]={size:version.size,sha256:version.sha256};
      const expected=inputSnapshot?.files.find(item=>item.path===file);if(expected&&(version.size!==expected.size||version.sha256!==expected.sha256))throw Error('task_inputs_changed');
    }
  }catch(error){
    if(inputSnapshot){rmSync(path,{recursive:true,force:true});throw Error(error.message==='document_input_not_text'?'document_input_not_text':'task_inputs_changed');}
    throw error;
  }
  const result={kind:workspaceMode,source,path,mode,inputFiles,inputBaseline,createdAt:Date.now()};saveJson(join(home,'workspace.json'),result);return result;
}
