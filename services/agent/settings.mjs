/** Non-secret machine settings; environment variables override local JSON. */
import {readFileSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runtimeSources} from '../runtime/sources.mjs';
import {runtimePaths,writableRuntimePath} from '../runtime/paths.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function loadSettings(env = process.env, file = runtimePaths(env,root).configFile) {
  const paths=runtimePaths(env,root);
  let config;
  try {
    const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    config = data.agent ?? {};
    if (!config || Array.isArray(config) || typeof config !== 'object' || Object.values(config).some(value => typeof value !== 'string')) throw new Error();
  } catch { throw new Error('invalid_agent_configuration'); }
  const path = (key, name, fallback) => {
    const value = env[key] || config[name] || fallback;
    return writableRuntimePath(value,env,root);
  };
  return {
    harnessRoot: runtimeSources(root).harnessRoot,
    siwcRoot: runtimeSources(root).siwcRoot,
    keychainPath: join(root, 'output/bin/siwc-keychain'),
    storageDir: path('OPENNOVA_SIWC_STORAGE', 'siwc_storage', paths.siwcStorage),
  };
}
