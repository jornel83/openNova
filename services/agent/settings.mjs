/** Non-secret machine settings; environment variables override local JSON. */
import {readFileSync, existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function loadSettings(env = process.env, file = env.OPENNOVA_CONFIG || join(root, 'config/voice.local.json')) {
  let config;
  try {
    const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    config = data.agent ?? {};
    if (!config || Array.isArray(config) || typeof config !== 'object' || Object.values(config).some(value => typeof value !== 'string')) throw new Error();
  } catch { throw new Error('invalid_agent_configuration'); }
  const path = (key, name, fallback) => {
    const value = env[key] || config[name] || fallback;
    return value.startsWith('~/') ? join(homedir(), value.slice(2)) : resolve(value);
  };
  return {
    harnessRoot: path('OPENNOVA_HARNESS_ROOT', 'harness_root', resolve(root, '../deepseek-harness')),
    siwcRoot: path('OPENNOVA_SIWC_ROOT', 'siwc_root', join(homedir(), '.local/share/opennova/siwc-devkit')),
    keychainPath: path('OPENNOVA_KEYCHAIN_HELPER', 'keychain_helper', join(homedir(), '.local/share/opennova/bin/siwc-keychain')),
    storageDir: path('OPENNOVA_SIWC_STORAGE', 'siwc_storage', join(homedir(), '.config/opennova-siwc-probe')),
  };
}
