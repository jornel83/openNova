#!/usr/bin/env node
/** Audit source boundaries; installed packages and generated outputs are not source. */
import {lstatSync,readdirSync,readFileSync,realpathSync,globSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parse as parseYaml} from 'yaml';
import {ROOT,checkEngineSources} from '../services/runtime/sources.mjs';

const excluded=new Set(['node_modules','output','lib','dist','target','coverage','.superpowers','.playwright-cli',
  '__pycache__','.pytest_cache','.cache','.venv','venv','.dsh-build']);
const inside=(root,path)=>path===root||path.startsWith(root+sep);

export function auditSourceTree(root=ROOT) {
  root=realpathSync(root);
  const result={files:0,symlinks:0,packageManifests:0,localDependencies:0,gitlinks:0};
  function contained(path,label,error) {
    if(!inside(root,path))throw Error(error+': '+label);
    // Resolve the nearest existing ancestor too: a missing leaf may live below
    // an installed/generated directory whose symlink escapes this checkout.
    for(let current=path;;current=dirname(current)) {
      try {
        if(!inside(root,realpathSync(current)))throw Error(error+': '+label);
        return;
      }catch(cause) {
        if(!['ENOENT','ENOTDIR'].includes(cause.code)||dirname(current)===current)throw cause;
      }
    }
  }
  function localDependencies(value,base,label) {
    if(typeof value==='string') {
      let local=value.match(/^(?:file:|link:)(.*)$/)?.[1]??(value.startsWith('.')||isAbsolute(value)?value:null);
      if(value.startsWith('workspace:')) {
        const target=value.slice('workspace:'.length);
        if(target.startsWith('.')||isAbsolute(target))local=target;
      }
      if(local!==null) {
        contained(resolve(base,decodeURIComponent(local)),label,'external_local_dependency');
        result.localDependencies++;
      }
    }else if(value&&typeof value==='object')for(const child of Object.values(value))localDependencies(child,base,label);
  }
  function workspacePackages(selectors,base,label) {
    if(selectors===undefined)return;
    if(!Array.isArray(selectors))throw Error('invalid_workspace_packages: '+label);
    for(const selector of selectors) {
      if(typeof selector!=='string')throw Error('invalid_workspace_packages: '+label);
      if(selector.startsWith('!'))continue; // Exclusions cannot introduce source.
      const prefix=selector.split(/[*?{[(]/)[0];
      contained(resolve(base,prefix),label,'external_workspace_package');
      // Reject traversal hidden in glob alternatives before expanding them.
      if(selector.slice(prefix.length).split(/[\/,{]/).includes('..'))throw Error('external_workspace_package: '+label);
      for(const entry of globSync(selector,{cwd:base}))contained(resolve(base,entry),label,'external_workspace_package');
    }
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
      const workspace=parseYaml(readFileSync(path,'utf8'))??{};
      workspacePackages(workspace.packages,dirname(path),label);
      localDependencies(workspace.overrides,dirname(path),label);
      localDependencies(workspace.catalog,dirname(path),label);
      localDependencies(workspace.catalogs,dirname(path),label);
    }
    if(name==='package.json') {
      const pkg=JSON.parse(readFileSync(path,'utf8'));result.packageManifests++;
      workspacePackages(Array.isArray(pkg.workspaces)?pkg.workspaces:pkg.workspaces?.packages,dirname(path),label);
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
