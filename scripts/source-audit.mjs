#!/usr/bin/env node
/** Audit source boundaries; installed packages and generated outputs are not source. */
import {lstatSync,readdirSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT,checkEngineSources} from '../services/runtime/sources.mjs';

const excluded=new Set(['node_modules','output','lib','dist','target','coverage','.superpowers','.playwright-cli',
  '__pycache__','.pytest_cache','.cache','.venv','venv','.dsh-build']);
const inside=(root,path)=>path===root||path.startsWith(root+sep);

export function auditSourceTree(root=ROOT) {
  root=realpathSync(root);
  const result={files:0,symlinks:0,packageManifests:0,localDependencies:0,gitlinks:0};
  function localDependencies(value,base,label) {
    if(typeof value==='string') {
      const local=value.match(/^(?:file:|link:)(.*)$/)?.[1]??(value.startsWith('.')||isAbsolute(value)?value:null);
      if(local!==null) {
        if(!inside(root,resolve(base,local)))throw Error('external_local_dependency: '+label);
        result.localDependencies++;
      }
    }else if(value&&typeof value==='object')for(const child of Object.values(value))localDependencies(child,base,label);
  }
  function visit(path) {
    const label=relative(root,path),name=path.split(sep).at(-1);
    if(name==='.git') {if(path!==join(root,'.git'))throw Error('embedded_repository: '+label);return;}
    if(excluded.has(name)||name.endsWith('.local.json')||name.startsWith('.env'))return;
    const stat=lstatSync(path);
    if(stat.isSymbolicLink()) {
      let target;try{target=realpathSync(path);}catch{throw Error('broken_source_symlink: '+label);}
      if(!inside(root,target))throw Error('external_source_symlink: '+label);
      result.symlinks++;return;
    }
    if(stat.isDirectory()) {for(const child of readdirSync(path).sort())visit(join(path,child));return;}
    if(!stat.isFile())return;
    result.files++;
    if(name==='.gitmodules'&&readFileSync(path,'utf8').trim())throw Error('submodule_configuration: '+label);
    if(name==='pnpm-workspace.yaml') {
      // pnpm local override specs are scalar file:/link: values (quoted or plain).
      for(const line of readFileSync(path,'utf8').split('\n')) {
        if(line.trimStart().startsWith('#'))continue;
        for(const match of line.matchAll(/(?:file:|link:)[^\s'"#}\],]+/g))localDependencies(match[0],dirname(path),label);
      }
    }
    if(name==='package.json') {
      const pkg=JSON.parse(readFileSync(path,'utf8'));result.packageManifests++;
      for(const value of [pkg.dependencies,pkg.devDependencies,pkg.optionalDependencies,pkg.peerDependencies,pkg.overrides,pkg.pnpm?.overrides])localDependencies(value,dirname(path),label);
    }
  }
  visit(root);
  // An export has no index; its on-disk boundaries are still checked above.
  const gitRoot=spawnSync('git',['rev-parse','--show-toplevel'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']});
  if(gitRoot.status===0&&realpathSync(gitRoot.stdout.trim())===root) {
    const index=spawnSync('git',['ls-files','--stage','-z'],{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024});
    if(index.status!==0)throw Error('source_index_unreadable');
    result.gitlinks=index.stdout.split('\0').filter(line=>line.startsWith('160000 ')).length;
    if(result.gitlinks)throw Error('external_gitlinks');
  }
  return result;
}

if(process.argv[1]===import.meta.filename) {
  try {checkEngineSources();console.log(JSON.stringify({independent:true,...auditSourceTree()},null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
