/** Explicit text inputs only; task outputs never overwrite the source project. */
import {existsSync,lstatSync,realpathSync,readFileSync,mkdirSync,writeFileSync,copyFileSync,chmodSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {readJson,saveJson} from './agent-files.mjs';
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
export async function prepareDocuments({source,home,mode,inputFiles=[],workspaceMode='documents'}){
  if(!['documents','general'].includes(workspaceMode))throw Error('invalid_workspace_mode');
  source=realpathSync(source);mkdirSync(home,{recursive:true,mode:0o700});home=realpathSync(home);const saved=readJson(join(home,'workspace.json'));
  if(saved){if(saved.source!==source||saved.kind!==workspaceMode||!existsSync(saved.path))throw Error('task_workspace_missing');return saved;}
  (workspaceMode==='general'?validateGeneralInputs:validateInputFiles)(source,inputFiles);const path=resolve(home,'workspace');
  if(existsSync(path))throw Error('workspace_preparation_interrupted');mkdirSync(path,{recursive:true,mode:0o700});
  const inputBaseline={};
  for(const file of inputFiles){const target=join(path,file);mkdirSync(dirname(target),{recursive:true});
    if(workspaceMode==='general'){copyFileSync(join(source,file),target);chmodSync(target,0o600);}
    else{const content=readFileSync(join(source,file));if(content.includes(0))throw Error('document_input_not_text');writeFileSync(target,content,{mode:0o600});}
    const bytes=readFileSync(target);inputBaseline[file]={size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}
  const result={kind:workspaceMode,source,path,mode,inputFiles,inputBaseline,createdAt:Date.now()};saveJson(join(home,'workspace.json'),result);return result;
}
