/** Resolve task paths without confusing a default cwd with an access boundary. */
import {existsSync,realpathSync,statSync} from 'node:fs';
import {dirname,relative,resolve} from 'node:path';
import {inside} from './workspace.mjs';
import {hasFullFilesystemAccess} from './execution.mjs';

export {hasFullFilesystemAccess} from './execution.mjs';

export function resolveTaskPath(config,value,{directory=false}={}){
  if(typeof value!=='string'||!value||value.includes('\0'))throw Error('invalid_file_path');
  const path=resolve(config.workspace,value);
  if(!hasFullFilesystemAccess(config)){
    if(!inside(config.workspace,path)||relative(config.workspace,path).split('/').includes('.git'))throw Error('outside_task_workspace');
    let existing=path;while(!existsSync(existing)&&existing!==dirname(existing))existing=dirname(existing);
    if(!inside(config.workspace,realpathSync(existing)))throw Error('outside_task_workspace');
  }
  if(directory){
    try{if(!statSync(path).isDirectory())throw Error('not_directory');}
    catch{throw Error('invalid_task_workdir');}
  }
  return path;
}
