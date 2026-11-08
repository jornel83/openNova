/** Capture complete skill resources into an immutable, repository-shaped archive. */
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,readdirSync,lstatSync,mkdirSync,writeFileSync,renameSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {join,dirname,relative,isAbsolute} from 'node:path';
import {parse,stringify} from 'yaml';

export const skillNameValid=value=>typeof value==='string'&&value.length<=32&&/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
export const digest=value=>createHash('sha256').update(value).digest('hex');
const inside=(root,path)=>{const part=relative(root,path);return part!=='..'&&!part.startsWith('../')&&!isAbsolute(part);};
const MAX_BYTES=4*1024*1024,MAX_FILES=128;

export function skillDocument(name,description,content,invocation={model:true,user:true}){
  if(!skillNameValid(name)||typeof description!=='string'||!description.trim()||description.length>2000||typeof content!=='string'||!content.trim()||Buffer.byteLength(content)>64000||content.includes('\0'))throw Error('invalid_skill');
  return '---\n'+stringify({name,description:description.trim(),
    ...(invocation.model===false?{'disable-model-invocation':true}:{}),
    ...(invocation.user===false?{'user-invocable':false}:{})})+'---\n\n'+content.trim()+'\n';
}

export function parseSkill(bytes){
  if(bytes.length>64000||bytes.includes(0))throw Error('invalid_skill_document');
  const text=bytes.toString('utf8'),match=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if(!match)throw Error('invalid_skill_document');
  const meta=parse(match[1]),content=match[2].trim();
  skillDocument(meta?.name,meta?.description,content);
  const flag=(value,fallback)=>{
    if(value===undefined)return fallback;
    if(typeof value==='boolean')return value;
    if(typeof value==='string'&&/^(true|false|yes|no|on|off|1|0)$/i.test(value))return /^(true|yes|on|1)$/i.test(value);
    if(value===0||value===1)return !!value;
    throw Error('invalid_skill_invocation');
  };
  return {name:meta.name,description:meta.description.trim(),content,
    invocation:{model:!flag(meta['disable-model-invocation'],false),user:flag(meta['user-invocable'],true)}};
}

function addFile(files,path,bytes){
  if(files.has(path)||path.split('/').includes('..')||isAbsolute(path)||bytes.length>MAX_BYTES)throw Error('invalid_skill_resource');
  files.set(path,bytes);
  if(files.size>MAX_FILES||[...files.values()].reduce((sum,value)=>sum+value.length,0)>MAX_BYTES)throw Error('skill_bundle_too_large');
}

export function captureBundle(directory,{root,source='personal'}={}){
  const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('invalid_skill_directory');
  const documentStat=lstatSync(join(directory,'SKILL.md'));if(!documentStat.isFile()||documentStat.isSymbolicLink())throw Error('invalid_skill_document');
  const info=parseSkill(readFileSync(join(directory,'SKILL.md'))),files=new Map(),prefix='skills/'+info.name;
  function visit(path,rel='',depth=0){
    if(depth>8)throw Error('skill_bundle_too_deep');
    for(const entry of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      if(entry.name.startsWith('.')||entry.name==='__pycache__'||entry.name==='node_modules')continue;
      const child=join(path,entry.name),name=rel?rel+'/'+entry.name:entry.name;
      if(entry.isSymbolicLink())throw Error('skill_resource_symlink');
      if(entry.isDirectory())visit(child,name,depth+1);
      else if(entry.isFile())addFile(files,prefix+'/'+name,readFileSync(child));
      else throw Error('invalid_skill_resource');
    }
  }
  visit(directory);
  // This shipped launcher locates tools/video relative to its repository root.
  // Preserve that layout in the archive so old runs never execute changed files.
  if(source==='bundled'&&info.name==='video-production'&&root){
    for(const name of ['tools/video/tool.py','tools/video/tool-definitions.json']){
      const path=join(root,name),stat=lstatSync(path);
      if(!inside(root,path)||!stat.isFile()||stat.isSymbolicLink())throw Error('invalid_skill_resource');
      addFile(files,name,readFileSync(path));
    }
  }
  return {...info,files,source};
}

export function editedBundle({name,description,content,previous}){
  const files=new Map();
  if(previous){
    verifySkillSnapshot(previous);
    for(const file of previous.resources)files.set(file.path,readFileSync(join(previous.archiveRoot,file.path)));
    if(previous.name!==name)throw Error('skill_name_changed');
  }
  const invocation={model:previous?.invocation?.model!==false,user:previous?.invocation?.user!==false};
  const document=Buffer.from(skillDocument(name,description,content,invocation));
  files.set('skills/'+name+'/SKILL.md',document);
  return {name,description:description.trim(),content:content.trim(),files,source:'personal',invocation};
}

export function archiveBundle(home,bundle){
  const resources=[...bundle.files].sort(([a],[b])=>a.localeCompare(b)).map(([path,bytes])=>({path,sha256:digest(bytes),size:bytes.length}));
  const version=digest(JSON.stringify(resources)),archiveRoot=join(home,'skills','versions',version),resourceBase={kind:'directory',path:join(archiveRoot,'skills',bundle.name)};
  const value={name:bundle.name,description:bundle.description,version,content:bundle.content,source:bundle.source,
    invocation:bundle.invocation??{model:true,user:true},resourceBase,archiveRoot,resources,resourceDigest:version};
  if(existsSync(archiveRoot)){verifySkillSnapshot(value);return value;}
  mkdirSync(dirname(archiveRoot),{recursive:true,mode:0o700});
  const stage=archiveRoot+'.'+randomUUID()+'.tmp';mkdirSync(stage,{mode:0o700});
  try{
    for(const [path,bytes] of bundle.files){const target=join(stage,path);mkdirSync(dirname(target),{recursive:true,mode:0o700});writeFileSync(target,bytes,{mode:0o400,flag:'wx'});}
    renameSync(stage,archiveRoot);
  }catch(error){rmSync(stage,{recursive:true,force:true});throw error;}
  return value;
}

/** Refuse altered archives rather than loading a later resource into an old run. */
export function verifySkillSnapshot(value){
  if(!value||!skillNameValid(value.name)||!Array.isArray(value.resources)||value.resources.length>MAX_FILES||value.resourceBase?.kind!=='directory'||!value.archiveRoot)throw Error('invalid_skill_snapshot');
  if(digest(JSON.stringify(value.resources))!==value.version)throw Error('skill_snapshot_changed');
  const root=realpathSync(value.archiveRoot);
  if(lstatSync(value.archiveRoot).isSymbolicLink()||value.resourceBase.path!==join(value.archiveRoot,'skills',value.name))throw Error('skill_snapshot_changed');
  for(const file of value.resources){
    const path=join(value.archiveRoot,file.path);
    if(!inside(value.archiveRoot,path)||realpathSync(path)!==join(root,file.path))throw Error('skill_snapshot_changed');
    const stat=lstatSync(path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==file.size||digest(readFileSync(path))!==file.sha256)throw Error('skill_snapshot_changed');
  }
  const document=parseSkill(readFileSync(join(value.resourceBase.path,'SKILL.md')));
  if(document.name!==value.name||document.content!==value.content||document.description!==value.description||
    document.invocation.model!==(value.invocation?.model!==false)||document.invocation.user!==(value.invocation?.user!==false))throw Error('skill_snapshot_changed');
  return value;
}
