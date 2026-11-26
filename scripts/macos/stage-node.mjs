#!/usr/bin/env node
/** Stage the installed production dependency graph without installing or changing source. */
import {constants,copyFileSync,existsSync,globSync,lstatSync,mkdirSync,readFileSync,readdirSync,readlinkSync,realpathSync,symlinkSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const inside=(root,path)=>path===root||path.startsWith(root+sep);
const stat=path=>{try{return lstatSync(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const manifest=path=>JSON.parse(readFileSync(join(path,'package.json'),'utf8'));
const packageName=name=>typeof name==='string'&&/^(?:@[^/]+\/)?[^/]+$/.test(name)&&!name.includes('\\')&&!name.includes('..');

/** Preserve pnpm's runtime visibility for shared loaders with computed package names. */
export function repairHoistedLinks({source,target,selectedPackages}){
  source=realpathSync(resolve(source));target=realpathSync(resolve(target));
  if(inside(target,source))throw Error('invalid_stage_target');
  const store=join(source,'engine/harness/node_modules/.pnpm'),hoisted=join(store,'node_modules');
  if(!stat(hoisted))return 0;
  const aliases=[];
  for(const name of readdirSync(hoisted)){
    if(name.startsWith('.'))continue;
    const path=join(hoisted,name);
    if(name.startsWith('@')&&stat(path)?.isDirectory())for(const child of readdirSync(path))aliases.push(join(path,child));
    else aliases.push(path);
  }
  let count=0;
  for(const path of aliases){
    if(!stat(path)?.isSymbolicLink())continue;
    let actual;try{actual=realpathSync(path);}catch{throw Error('broken_hoisted_symlink: '+relative(source,path));}
    // During a repair, only installed packages already present in the deployment
    // are eligible. Normal staging uses the explicit production closure as well.
    if(selectedPackages?!selectedPackages.has(actual):!inside(store,actual))continue;
    const stagedPackage=join(target,relative(source,actual));
    if(!existsSync(join(stagedPackage,'package.json')))continue;
    const raw=readlinkSync(path);
    if(isAbsolute(raw)||!inside(source,actual)||!inside(source,resolve(dirname(path),raw)))throw Error('external_hoisted_symlink: '+relative(source,path));
    const destination=join(target,relative(source,path));
    for(let parent=dirname(destination);parent!==target;parent=dirname(parent)){
      if(!inside(target,parent)||stat(parent)?.isSymbolicLink())throw Error('unsafe_hoisted_destination');
    }
    mkdirSync(dirname(destination),{recursive:true});
    const old=stat(destination);
    if(old){if(!old.isSymbolicLink()||readlinkSync(destination)!==raw)throw Error('staged_link_conflict: '+relative(target,destination));}
    else symlinkSync(raw,destination);
    if(!inside(target,realpathSync(destination)))throw Error('external_staged_symlink');
    count++;
  }
  return count;
}

export function stageNode({source,target}){
  source=realpathSync(resolve(source));target=resolve(target);
  if(inside(target,source)||target.split(sep).includes('node_modules'))throw Error('invalid_stage_target');
  mkdirSync(target,{recursive:true});target=realpathSync(target);
  if(inside(target,source))throw Error('invalid_stage_target');
  const report={packages:0,workspacePackages:0,copiedFiles:0,copiedBytes:0,symlinks:0,skippedOptional:[],nativeFiles:[]};
  const copied=new Set(),links=new Set(),visited=new Set(),queue=[];
  const dest=path=>{
    if(!inside(source,path))throw Error('dependency_outside_source: '+path);
    return join(target,relative(source,path));
  };
  function prepare(path){
    if(!inside(target,path))throw Error('write_outside_stage');
    for(let dir=dirname(path);dir!==target;dir=dirname(dir)){
      if(!inside(target,dir))throw Error('write_outside_stage');
      if(stat(dir)?.isSymbolicLink())throw Error('staged_parent_is_symlink: '+relative(target,dir));
    }
    mkdirSync(dirname(path),{recursive:true});
  }
  function copyLink(path){
    const raw=readlinkSync(path);
    if(isAbsolute(raw))throw Error('absolute_dependency_symlink: '+relative(source,path));
    let actual;
    try{actual=realpathSync(path);}catch{throw Error('broken_dependency_symlink: '+relative(source,path));}
    if(!inside(source,actual)||!inside(source,resolve(dirname(path),raw)))throw Error('external_dependency_symlink: '+relative(source,path));
    const out=dest(path);prepare(out);const old=stat(out);
    if(old){if(!old.isSymbolicLink()||readlinkSync(out)!==raw)throw Error('staged_link_conflict: '+relative(target,out));}
    else symlinkSync(raw,out);
    if(!links.has(out)){links.add(out);report.symlinks++;}
  }
  function copyTree(path,{packageRoot=false}={}){
    if(copied.has(path))return;
    copied.add(path);
    const info=lstatSync(path);
    if(info.isSymbolicLink()){copyLink(path);return;}
    const out=dest(path);prepare(out);
    if(stat(out)?.isSymbolicLink())throw Error('staged_path_is_symlink: '+relative(target,out));
    if(info.isDirectory()){
      mkdirSync(out,{recursive:true});
      for(const name of readdirSync(path)){
        if(name==='.git'||name==='.DS_Store'||packageRoot&&name==='node_modules')continue;
        copyTree(join(path,name));
      }
    }else if(info.isFile()){
      copyFileSync(path,out,constants.COPYFILE_FICLONE);
      report.copiedFiles++;report.copiedBytes+=info.size;
      if(/\.(node|dylib)$/.test(path)||basename(path)==='spawn-helper')report.nativeFiles.push(relative(source,path));
    }else throw Error('unsupported_dependency_file: '+relative(source,path));
  }
  function preserveLinks(path){
    let cursor=source;
    for(const part of relative(source,path).split(sep)){
      cursor=join(cursor,part);
      if(lstatSync(cursor).isSymbolicLink()){copyLink(cursor);cursor=realpathSync(cursor);}
    }
    if(!inside(source,cursor))throw Error('dependency_outside_source');
    return cursor;
  }
  function resolveDependency(owner,name){
    if(!packageName(name))throw Error('invalid_dependency_name: '+name);
    for(let directory=owner;inside(source,directory);directory=dirname(directory)){
      const candidate=join(directory,'node_modules',name);
      if(stat(candidate))return candidate;
      if(directory===source)break;
    }
    return null;
  }
  function enqueue(path){
    const actual=preserveLinks(path);
    if(!visited.has(actual)){visited.add(actual);queue.push(actual);}
  }

  // These independent npm/pnpm installations are small and include the OpenNova YAML runtime.
  for(const name of ['node_modules','engine/bot/ds-bot/node_modules','engine/siwc/node_modules','services/bot/desktop/node_modules']){
    const path=join(source,name);if(stat(path))copyTree(path);
  }
  const harness=join(source,'engine/harness');
  if(!existsSync(join(harness,'apps/cli/package.json')))throw Error('harness_cli_manifest_missing');
  // Plugin discovery is dynamic. Keep every production workspace's declared graph;
  // developer-only workspace roots and Electron's alternate app are not seeds.
  const seeds=[...globSync('{apps/cli,apps/web,packages/*/*,vendor/*,native/system/packages/*}/package.json',{cwd:harness})]
    .filter(path=>!path.startsWith('packages/test-support/')&&path!=='packages/typert/generator/package.json');
  for(const path of seeds)enqueue(join(harness,dirname(path)));
  for(let i=0;i<queue.length;i++){
    const path=queue[i],pkg=manifest(path),installed=relative(source,path).split(sep).includes('node_modules');
    if(installed){copyTree(path,{packageRoot:true});report.packages++;}
    else{
      if(!existsSync(join(dest(path),'package.json')))throw Error('stage_source_first: '+relative(source,path));
      report.workspacePackages++;
    }
    const required=new Set(Object.keys(pkg.dependencies??{})),optional=new Set(Object.keys(pkg.optionalDependencies??{}));
    const peers=Object.keys(pkg.peerDependencies??{}),bundled=pkg.bundledDependencies??pkg.bundleDependencies;
    const names=new Set([...required,...optional,...peers,...(Array.isArray(bundled)?bundled:[])]);
    for(const name of names){
      const found=resolveDependency(path,name);
      if(!found){
        if(optional.has(name)||!required.has(name)&&pkg.peerDependenciesMeta?.[name]?.optional){report.skippedOptional.push({package:pkg.name,dependency:name});continue;}
        throw Error('installed_dependency_missing: '+pkg.name+' -> '+name);
      }
      enqueue(found);
    }
  }
  report.hoistedAliases=repairHoistedLinks({source,target,selectedPackages:visited});
  for(const path of links){
    let actual;
    try{actual=realpathSync(path);}catch{throw Error('broken_staged_symlink: '+relative(target,path));}
    if(!inside(target,actual))throw Error('external_staged_symlink: '+relative(target,path));
  }
  return report;
}

function main(args){
  const options={};
  for(let i=0;i<args.length;i+=2){
    if(!['--source','--target'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw Error('Usage: stage-node.mjs --source <source root> --target <staged app code root>');
    options[args[i].slice(2)]=args[i+1];
  }
  if(!options.source||!options.target)throw Error('source_and_target_required');
  console.log(JSON.stringify(stageNode(options),null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}
}
