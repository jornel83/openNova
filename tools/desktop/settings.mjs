/** Browser binaries are toolchain; browser profiles and pairing data stay external. */
import {readFileSync,realpathSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {homedir} from 'node:os';
import {ROOT} from '../../services/runtime/sources.mjs';
import {runtimePaths,writableRuntimePath} from '../../services/runtime/paths.mjs';
const expand=value=>value.startsWith('~/')?join(homedir(),value.slice(2)):resolve(value);
function canonical(path) {
 try{return realpathSync(path);}catch(error){
  if(!['ENOENT','ENOTDIR'].includes(error.code)||dirname(path)===path)throw error;
  return join(canonical(dirname(path)),path.slice(dirname(path).length+1));
 }
}
export function browserSettings(env=process.env,root=ROOT) {
 let data={};
 try{data=JSON.parse(readFileSync(runtimePaths(env,root).configFile,'utf8'));}
 catch(error){if(error.code!=='ENOENT')throw Error('invalid_desktop_configuration');}
 const config=data.desktop??{};
 if(!config||typeof config!=='object'||Array.isArray(config))throw Error('invalid_desktop_configuration');
 const executable=env.OPENNOVA_BROWSER_EXECUTABLE||config.browser_executable||'';
 const profile=env.OPENNOVA_BROWSER_USER_DATA_DIR||config.browser_user_data_dir||'';
 if(typeof executable!=='string'||typeof profile!=='string')throw Error('invalid_desktop_configuration');
 if(!executable&&!profile)return {};
 if(!executable||!profile)throw Error('需要同时设置 OPENNOVA_BROWSER_EXECUTABLE 和 OPENNOVA_BROWSER_USER_DATA_DIR（或 desktop 浏览器机器配置）');
 const realRoot=canonical(resolve(root)),realProfile=canonical(expand(profile));
 if(realProfile===realRoot||realProfile.startsWith(realRoot+sep))throw Error('browser_profile_must_be_outside_repository');
 return {executable:expand(executable),profile:writableRuntimePath(profile,env,root)};
}
