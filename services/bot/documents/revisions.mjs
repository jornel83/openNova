/** A revision uses a journaled edition and its private recipe; a live document is never an edit target. */
import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,readSync,fstatSync,lstatSync,realpathSync} from 'node:fs';
import {basename,dirname,extname,join,resolve,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {normalizeDocumentSpec,MAX_SPEC_BYTES} from './spec.mjs';

const maxArtifact=64*1024*1024;
const sameVersion=(a,b)=>a&&b&&['size','mtimeMs','ctimeMs','ino'].every(k=>a[k]===b[k]);
// A chmod or extended-attribute change updates ctime without changing the
// journaled document. File identity, modification time, length and digest pin
// the saved edition; comparison during a live read additionally includes ctime.
const sameEdition=(a,b)=>['size','mtimeMs','ino'].every(key=>a[key]===b[key]);
const edition=a=>a.revision??1;
const rootId=a=>a.rootArtifactId??a.id;
const conflict=(code,base,extra={})=>Object.assign(Error(code),{details:{artifactId:base.id,path:base.path,...extra}});
const own=(row,projectId)=>row?.kind==='document_artifact'&&row.projectId===projectId&&['docx','pdf'].includes(row.format);
const get=(ops,id)=>{try{return ops.get(id);}catch(e){if(e.message!=='unknown_id')throw e;}};

/** Check metadata and bytes on the same fd; recheck name/identity at the end. */
function checked(path,sha,limit,expectedVersion,collect=false){
  if(!/^[a-f0-9]{64}$/.test(sha))throw Error('bad_checksum');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=fstatSync(fd);
    if(!before.isFile()||before.size<1||before.size>limit||expectedVersion&&!sameEdition(before,expectedVersion))throw Error('file_changed');
    const hash=createHash('sha256'),buf=Buffer.alloc(Math.min(before.size,64*1024)),parts=[];let count=0;
    while(count<before.size){
      const n=readSync(fd,buf,0,Math.min(buf.length,before.size-count),count);
      if(!n)throw Error('file_changed');
      const part=buf.subarray(0,n);hash.update(part);
      if(collect)parts.push(Buffer.from(part));count+=n;
    }
    if(!sameVersion(before,fstatSync(fd))||!sameVersion(before,lstatSync(path))||hash.digest('hex')!==sha)throw Error('file_changed');
    return collect?Buffer.concat(parts,count):undefined;
  }finally{closeSync(fd);}
}

function validateLive(base){
  try{
    if(!isAbsolute(base.path)||realpathSync(dirname(base.path))!==dirname(base.path)||!base.version||base.version.size!==base.size)throw Error('file_changed');
    checked(base.path,base.sha256,maxArtifact,base.version);
  }catch(e){
    throw conflict(['ENOENT','ENOTDIR'].includes(e.code)?'document_revision_source_missing':'document_revision_source_changed',base);
  }
}

export function assertLatestEdition(ops,base){
  const head=ops.list('document_artifact').filter(a=>own(a,base.projectId)&&rootId(a)===rootId(base)&&a.id!==base.id&&edition(a)>=edition(base))
    .sort((a,b)=>edition(b)-edition(a))[0];
  if(head)throw conflict('document_revision_not_latest',base,{latestArtifactId:head.id,latestPath:head.path});
}

export function assertRevisionBaseUnchanged({ops,base}){
  if(!own(base,base?.projectId))throw Error('document_revision_artifact_not_found');
  assertLatestEdition(ops,base);
  validateLive(base);
}

export function savedDocumentSpec(home,base){
  try{
    const edit=base.editableSpecSnapshotPath!==undefined||base.editableSpecSha256!==undefined;
    const path=edit?base.editableSpecSnapshotPath:base.specSnapshotPath,sha=edit?base.editableSpecSha256:base.specSha256;
    // Validate the per-generation directory as well as the filename. Do not
    // follow a replaced directory or consult the original, editable JSON path.
    const dir=dirname(path),key=basename(dir),root=realpathSync(home),privateDir=join(root,'document-generations',key);
    if(!/^[a-f0-9]{64}$/.test(key)||base.id!=='document-artifact-'+key.slice(0,40)||
      resolve(dir)!==resolve(home,'document-generations',key)||realpathSync(dir)!==privateDir||
      basename(path)!==(edit?'editable-spec.json':'spec.json'))throw Error('invalid_recipe_path');
    const content=checked(path,sha,MAX_SPEC_BYTES,null,true);
    return normalizeDocumentSpec(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(content)));
  }catch{throw conflict('document_revision_spec_unavailable',base);}
}

function selectArtifact({ops,projectId,cwd,artifactId,path}){
  if(!projectId||typeof cwd!=='string'||!isAbsolute(cwd)||(artifactId!==undefined)===(path!==undefined))throw Error('invalid_document_revision_source');
  if(artifactId!==undefined){
    if(typeof artifactId!=='string'||!artifactId.trim()||artifactId.length>200)throw Error('invalid_document_revision_source');
    const row=get(ops,artifactId);if(own(row,projectId))return row;
  }else{
    if(typeof path!=='string'||!path.trim()||path.length>4096||/[\x00-\x1f]/u.test(path)||/^[\w+.-]+:/.test(path)||path.startsWith('//'))throw Error('invalid_document_revision_source');
    const requested=resolve(cwd,path.startsWith('~/')?join(homedir(),path.slice(2)):path);
    let canonical=requested;try{canonical=join(realpathSync(dirname(requested)),basename(requested));}catch{}
    const matches=ops.list('document_artifact').filter(a=>own(a,projectId)&&(a.path===requested||a.path===canonical));
    if(matches.length===1)return matches[0];
    if(matches.length>1)throw Error('document_revision_ambiguous_source');
  }
  throw Error('document_revision_artifact_not_found');
}

/** Both inspect and apply pin the selected edition, never whichever arbitrary file occupies its name. */
export function prepareDocumentRevision({home,ops,projectId,cwd,artifactId,path}){
  const base=selectArtifact({ops,projectId,cwd,artifactId,path});
  assertRevisionBaseUnchanged({ops,base});
  return {...documentRevisionTarget(ops,base),base,spec:savedDocumentSpec(home,base)};
}

export function documentRevisionTarget(ops,base){
  const root=base.id===rootId(base)?base:get(ops,rootId(base)),next=edition(base)+1;
  if(!own(root,base.projectId)||root.format!==base.format||dirname(root.path)!==dirname(base.path)||extname(root.path)!=='.'+root.format||
    !Number.isSafeInteger(next)||next<2)throw Error('document_revision_lineage_unavailable');
  const targetPath=join(dirname(root.path),basename(root.path,'.'+root.format)+'.v'+next+'.'+root.format);
  return {targetPath,lineage:{rootArtifactId:root.id,parentArtifactId:base.id,parentSha256:base.sha256,revision:next}};
}
