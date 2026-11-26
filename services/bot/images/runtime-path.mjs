/** Bootstrapping OpenNova cannot import packages that setup has not installed yet. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ROOT} from '../../runtime/sources.mjs';
import {runtimePaths} from '../../runtime/paths.mjs';

export const imageLockName='tools/image/requirements.lock.txt';

export function installedImagePython(lock,root=ROOT,env=process.env){
  const paths=runtimePaths(env,root);
  if(paths.packaged&&(env.OPENNOVA_IMAGE_PYTHON||env.OPENNOVA_PYTHON))return env.OPENNOVA_IMAGE_PYTHON||env.OPENNOVA_PYTHON;
  const version=createHash('sha256').update(lock??readFileSync(join(root,imageLockName))).digest('hex');
  return join(paths.packaged?paths.dataRoot:root,paths.packaged?'runtime/image':'output/image/runtime','py311-'+version,'bin/python');
}
