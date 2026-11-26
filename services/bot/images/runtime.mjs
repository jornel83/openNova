/** Select a compatible local environment and verify the entire executor archive. */
import {spawnSync} from 'node:child_process';
import {accessSync,constants,existsSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {isAbsolute,join,posix} from 'node:path';
import {ROOT} from '../../runtime/sources.mjs';
import {runtimePaths} from '../../runtime/paths.mjs';
import {digest,IMAGE_EXECUTOR_RESOURCES,LEGACY_IMAGE_EXECUTOR_RESOURCES,verifySkillSnapshot} from '../skills/bundle.mjs';
import {imageLockName as lockName,installedImagePython} from './runtime-path.mjs';

export {installedImagePython} from './runtime-path.mjs';
const probe='import json, platform, PIL; from PIL import Image; print(json.dumps({"python": platform.python_version(), "pillow": PIL.__version__}))';

export function imageRuntimeEnv({credentials=true,spark=false,source=process.env}={}){
  const env={PATH:'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'};
  if(source.OPENNOVA_PACKAGED==='1'||source.OPENNOVA_BIN_DIR)env.PATH=runtimePaths(source).binDir+':'+env.PATH;
  const keys=['HOME','TMPDIR','LANG','SSL_CERT_FILE','SSL_CERT_DIR'];
  if(spark)keys.push('OPENNOVA_SPARK_SSH_HOST','SSH_AUTH_SOCK');
  if(credentials&&!spark)keys.push('OPENNOVA_IMAGE_ARK_KEY_FILE','OPENNOVA_ARK_KEY_FILE','ARK_API_KEY','HTTPS_PROXY','https_proxy','NO_PROXY','no_proxy');
  for(const key of keys)if(source[key])env[key]=source[key];
  if(credentials&&!spark)env.OPENNOVA_IMAGE_REPOSITORY_ROOT=ROOT;
  return env;
}

export function legacyImagePython(){
  const installed=installedImagePython();
  return process.env.OPENNOVA_IMAGE_PYTHON||(existsSync(installed)?installed:join(ROOT,'output/image/runtime/ark-py311/bin/python'));
}

function inventory(snapshot){
  // A Python archive must not expose unmanifested __init__.py, bytecode, or modules.
  const files=new Set(snapshot.resources.map(file=>file.path));
  const schemaPath='tools/image/tool-definitions.json';
  if(!files.has(schemaPath))throw Error('invalid_image_executor_snapshot');
  const definitions=JSON.parse(readFileSync(join(snapshot.archiveRoot,schemaPath),'utf8'));
  const imageSchema=definitions.find(entry=>entry.function?.name==='image_generate')?.function.parameters;
  if(!imageSchema)throw Error('invalid_image_executor_snapshot');
  const supportsSpark=imageSchema.properties?.provider?.enum?.includes('spark')===true;
  const required=supportsSpark?IMAGE_EXECUTOR_RESOURCES:LEGACY_IMAGE_EXECUTOR_RESOURCES;
  if(files.size!==snapshot.resources.length||required.some(path=>!files.has(path))||
      [...files].some(path=>typeof path!=='string'||path.includes('\\')||path.split('/').some(part=>!part||part==='.'||part==='..')))
    throw Error('invalid_image_executor_snapshot');
  const folders=new Set();
  for(const path of files)for(let dir=posix.dirname(path);dir!=='.';dir=posix.dirname(dir))folders.add(dir);
  function scan(directory,name=''){
    for(const entry of readdirSync(directory,{withFileTypes:true})){
      const path=name?name+'/'+entry.name:entry.name;
      if(entry.isDirectory()&&folders.has(path))scan(join(directory,entry.name),path);
      else if(!entry.isFile()||!files.has(path))throw Error('skill_snapshot_changed');
    }
  }
  scan(snapshot.archiveRoot);
  return supportsSpark;
}

export function pinImageRuntime(snapshot,{credentials=true,spark=false}={}){
  if(snapshot?.name!=='image-production')throw Error('invalid_image_executor_snapshot');
  verifySkillSnapshot(snapshot);
  const supportsSpark=inventory(snapshot);
  if(spark&&!supportsSpark)throw Error('image_snapshot_model_unavailable');
  const archiveRoot=realpathSync(snapshot.archiveRoot);
  const lock=readFileSync(join(archiveRoot,lockName));
  const lines=lock.toString('utf8').split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));
  const expected=lines.length===1&&/^pillow==(\d+\.\d+\.\d+)$/i.exec(lines[0])?.[1];
  if(!expected)throw Error('invalid_image_dependency_lock');
  const python=process.env.OPENNOVA_IMAGE_PYTHON||installedImagePython(lock);
  try{
    if(!isAbsolute(python))throw Error();
    accessSync(python,constants.X_OK);
  }catch{throw Error('image_python_unavailable');}
  const result=spawnSync(python,['-I','-B','-c',probe],{cwd:archiveRoot,env:imageRuntimeEnv({credentials:false}),
    encoding:'utf8',timeout:5000,maxBuffer:8192,stdio:['ignore','pipe','ignore']});
  let actual;
  if(result.status===0)try{actual=JSON.parse(result.stdout);}catch{}
  if(!/^3\.11\.\d+$/.test(actual?.python??'')||actual.pillow!==expected)throw Error('image_runtime_incompatible');
  return {python,archiveRoot,env:imageRuntimeEnv({credentials,spark}),runtime:{python:actual.python,pillow:actual.pillow,skillVersion:snapshot.version,requirementsSha256:digest(lock)}};
}
