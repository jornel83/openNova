/** OpenNova's independent SIWC connection, using the existing Keychain-backed store. */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSettings } from './settings.mjs';
import { toolsModule } from './siwc-overlay.mjs';

const settings = loadSettings();
export const siwcRoot = settings.siwcRoot;
export const keychainPath = settings.keychainPath;

function secure(operation, input = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    const child = spawn(keychainPath, [operation], {stdio:['pipe', 'pipe', 'ignore']});
    const parts = [];
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', part => parts.push(part));
    child.stdin.on('error', () => {}); // Exit status reports closed-pipe failures.
    child.once('error', () => { clearTimeout(timeout); reject(new Error('secure_storage_unavailable')); });
    child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve(Buffer.concat(parts)) : reject(new Error('secure_storage_unavailable')); });
    child.stdin.end(input);
  });
}

export async function createClient({openBrowser, capabilities='text'} = {}) {
  if (!['text','tools'].includes(capabilities)) throw new Error('invalid_agent_configuration');
  const modulePath=capabilities==='tools' ? toolsModule() : join(siwcRoot, 'packages/local/dist/index.js');
  const {createChatGPT} = await import(pathToFileURL(modulePath).href);
  return createChatGPT({
    appName: 'OpenNova', appId: 'opennova', redirectPort: 14555, sendHostId: true,
    storageDir: settings.storageDir,
    credentialEncryption: {
      id: 'macos-keychain-aes-gcm-v1',
      isAvailable: async () => { try { await secure('check'); return true; } catch { return false; } },
      encrypt: text => secure('encrypt', Buffer.from(text)),
      decrypt: async bytes => (await secure('decrypt', Buffer.from(bytes))).toString('utf8'),
    },
    openBrowser: openBrowser ?? (() => { throw new Error('interactive_sign_in_required'); }),
  });
}
