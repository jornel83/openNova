/** Bound object versions prevent a stale reference from overwriting a newer file. */
import {statSync,realpathSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,resolve,sep} from 'node:path';
const version=path=>{try{const s=statSync(path);return {size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs,ino:s.ino};}catch{return null;}};
const matches=(expected,actual)=>expected&&actual&&['size','mtimeMs','ctimeMs','ino'].every(key=>expected[key]===undefined||expected[key]===actual[key]);
const canonical=path=>{try{return realpathSync(path);}catch{return path;}};
export async function withObjectVersion(active,exec,next,ops){
  if(!active?.binding||!['read','write','edit'].includes(exec.name))return next();
  const raw=exec.arguments?.file_path;if(typeof raw!=='string')return next();
  // The Harness resolves a POSIX symlink before applying a subsequent "..".
  // Check that physical identity as well as the journaled name (even if the
  // name has since been deleted or replaced with a symlink).
  const requested=isAbsolute(raw)?raw:active.binding.cwd+sep+raw;
  let path;try{path=realpathSync.native(requested);}catch{path=join(canonical(dirname(requested)),basename(requested));}
  if(['write','edit'].includes(exec.name)&&ops){
    const names=new Set([resolve(requested),path,join(canonical(dirname(requested)),basename(requested))]);
    if([...names].some(name=>ops.isDocumentArtifactPath(name)))throw Error('document_revision_tool_required');
  }
  const before=version(path);
  const file=active.binding.context?.kind==='file'?active.binding.context.file:null;
  const reference=file&&canonical(file.path)===path?file:
    active.binding.projectContext?.references?.find(r=>r.path&&canonical(r.path)===path)?.version;
  active.objectReads??=new Map();
  const expected=active.objectReads.get(path)??reference;
  if(['write','edit'].includes(exec.name)&&expected&&!matches(expected,before))throw Error('project_object_changed_read_again');
  const result=await next();
  if(exec.name==='read'&&!result?.isError){const after=version(path);if(!matches(before,after))throw Error('project_object_changed_during_read');active.objectReads.set(path,after);}
  if(['write','edit'].includes(exec.name)&&!result?.isError)active.objectReads.set(path,version(path));
  return result;
}
