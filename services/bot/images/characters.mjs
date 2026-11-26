import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync,realpathSync,statSync} from 'node:fs';
import {extname,join,relative} from 'node:path';

export const CHARACTER_PROFILE_FILE='.opennova/image-characters.json';
const idPattern=/^[a-z][a-z0-9-]{0,47}$/;
const versionPattern=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const shaPattern=/^[a-f0-9]{64}$/;
const formats=new Set(['.png','.jpg','.jpeg','.webp']);
const control=/[\p{Cc}\p{Cf}]/u;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fixedError=code=>Error(code);
const plain=(value,limit)=>typeof value==='string'&&value===value.trim()&&value.length>0&&value.length<=limit&&!control.test(value);
const keysMatch=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const same=(a,b)=>['dev','ino','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);

function relativeImagePath(path){
  return plain(path,1024)&&!path.includes('\\')&&!path.includes(':')&&path.split('/').every(p=>p&&p!=='.'&&p!=='..')&&formats.has(extname(path).toLowerCase());
}

function imageSignature(bytes,ext){
  if(ext==='.png')return bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));
  if(ext==='.webp')return bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
  return bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
}

function readBoundFile(path,maxBytes,code){
  let fd;
  try{
    if(realpathSync(path)!==path)throw fixedError(code);
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before=fstatSync(fd);
    if(!before.isFile()||before.size<1||before.size>maxBytes)throw fixedError(code);
    const bytes=Buffer.alloc(before.size);
    for(let start=0;start<bytes.length;){
      const n=readSync(fd,bytes,start,bytes.length-start,null);
      if(n===0)throw fixedError(code);
      start+=n;
    }
    if(!same(before,fstatSync(fd))||!same(before,statSync(path))||realpathSync(path)!==path)throw fixedError(code);
    return bytes;
  }catch{throw fixedError(code);}
  finally{if(fd!==undefined)closeSync(fd);}
}

function load(workspace){
  const root=realpathSync(workspace),path=join(root,CHARACTER_PROFILE_FILE);
  try{lstatSync(path);}catch(error){
    if(error.code==='ENOENT')return null;
    throw fixedError('invalid_character_profile');
  }
  const bytes=readBoundFile(path,64*1024,'invalid_character_profile');
  let profile;
  try{profile=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fixedError('invalid_character_profile');}
  if(!keysMatch(profile,['schemaVersion','characters'])||profile.schemaVersion!==1||!Array.isArray(profile.characters)||profile.characters.length>24)throw fixedError('invalid_character_profile');
  const ids=new Set(),names=new Set();
  for(const entry of profile.characters){
    if(!keysMatch(entry,['id','name','version','constraints','references'])||typeof entry.id!=='string'||!idPattern.test(entry.id)||
        !plain(entry.name,60)||typeof entry.version!=='string'||!versionPattern.test(entry.version)||
        !Array.isArray(entry.constraints)||entry.constraints.length<1||entry.constraints.length>8||!entry.constraints.every(s=>plain(s,240))||
        !Array.isArray(entry.references)||entry.references.length<1||entry.references.length>4)throw fixedError('invalid_character_profile');
    const name=entry.name.normalize('NFKC').toLowerCase();
    if(ids.has(entry.id)||names.has(name))throw fixedError('invalid_character_profile');
    ids.add(entry.id);names.add(name);
    const seen=new Set();
    for(const ref of entry.references){
      if(!keysMatch(ref,['path','sha256'])||!relativeImagePath(ref.path)||typeof ref.sha256!=='string'||!shaPattern.test(ref.sha256))throw fixedError('invalid_character_profile');
      const normalized=ref.path.normalize('NFC');
      if(seen.has(normalized))throw fixedError('invalid_character_profile');
      seen.add(normalized);
    }
  }
  return {root,profileSha256:hash(bytes),entries:profile.characters};
}

/** Advertise the contents of this project's profile, without lifting references into the conversation. */
export function listProjectCharacters(workspace){
  const profile=load(workspace);
  return Object.freeze(profile?.entries.map(({id,name,version})=>Object.freeze({id,name,version}))??[]);
}

/** Verify approved bytes locally before recording a character binding for a media operation. */
export function resolveProjectCharacter(workspace,characterId){
  if(typeof characterId!=='string'||!idPattern.test(characterId))throw fixedError('invalid_character_id');
  const profile=load(workspace),entry=profile?.entries.find(row=>row.id===characterId);
  if(!entry)throw fixedError('character_not_in_project');
  const references=entry.references.map(ref=>{
    const path=join(profile.root,ref.path);
    if(relative(profile.root,path)!==ref.path)throw fixedError('invalid_character_reference');
    const bytes=readBoundFile(path,20*1024*1024,'invalid_character_reference');
    if(hash(bytes)!==ref.sha256)throw fixedError('character_reference_changed');
    if(!imageSignature(bytes,extname(path).toLowerCase()))throw fixedError('invalid_character_reference');
    return Object.freeze({path,sha256:ref.sha256});
  });
  return Object.freeze({id:entry.id,name:entry.name,version:entry.version,profileSha256:profile.profileSha256,
    constraints:Object.freeze(entry.constraints),references:Object.freeze(references)});
}
