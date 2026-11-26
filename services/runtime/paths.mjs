/** Keep installed application resources separate from per-user writable state. */
import {realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,dirname,join,resolve,sep} from 'node:path';
import {ROOT} from './sources.mjs';

const expand=value=>value.startsWith('~/')?join(homedir(),value.slice(2)):resolve(value);
function canonical(path){
  try{return realpathSync(path);}catch(error){
    if(!['ENOENT','ENOTDIR'].includes(error.code)||dirname(path)===path)throw error;
    return join(canonical(dirname(path)),basename(path));
  }
}
function applicationRoot(root){
  const resources=dirname(root),contents=dirname(resources);
  return basename(resources)==='Resources'&&basename(contents)==='Contents'?dirname(contents):root;
}

export function writableRuntimePath(path,env=process.env,root=ROOT){
  const result=expand(path);
  if(env.OPENNOVA_PACKAGED==='1'){
    const app=canonical(applicationRoot(resolve(root))),target=canonical(result);
    if(target===app||target.startsWith(app+sep))throw Error('packaged_state_must_be_outside_application');
  }
  return result;
}

export function runtimePaths(env=process.env,root=ROOT){
  const packaged=env.OPENNOVA_PACKAGED==='1';
  const writable=path=>writableRuntimePath(path,env,root);
  const dataRoot=writable(packaged?(env.OPENNOVA_APP_DATA||join(homedir(),'Library/Application Support/OpenNova')):join(homedir(),'.local/share/opennova'));
  return {
    packaged,dataRoot,
    configFile:writable(env.OPENNOVA_CONFIG||join(packaged?dataRoot:root,'config/voice.local.json')),
    secretsFile:writable(env.OPENNOVA_SECRETS_FILE||env.OPENNOVA_SECRETS||join(packaged?dataRoot:root,'config/secrets.local.json')),
    botHome:writable(env.OPENNOVA_BOT_HOME||join(dataRoot,'bot-spike')),
    workspace:packaged?writable(env.OPENNOVA_WORKSPACE||join(dataRoot,'workspace')):root,
    siwcStorage:writable(env.OPENNOVA_SIWC_STORAGE||(packaged?join(dataRoot,'accounts'):join(homedir(),'.config/opennova-siwc-probe'))),
    binDir:expand(env.OPENNOVA_BIN_DIR||(packaged?join(dirname(root),'runtime/bin'):join(root,'output/bin'))),
    logsRoot:packaged?join(dataRoot,'logs'):join(root,'output'),
  };
}
