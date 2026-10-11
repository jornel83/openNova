/** JSON-lines bridge: one owned Harness session, serialized turns, no credential output. */
import { createInterface } from 'node:readline';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from './chatgpt.mjs';
import { completedReply } from './result.mjs';
import { loadSettings } from './settings.mjs';

process.umask(0o077);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const settings = loadSettings();
const harnessRoot = settings.harnessRoot;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let harness;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  try { await harness?.close(); } finally { process.exit(130); }
});
try {
  const chatgpt = await createClient();
  const session = await chatgpt.getSession();
  if (session.status !== 'connected' || !session.sharing) throw new Error('chatgpt_authorization_required');
  const models = await chatgpt.listModels({signal:AbortSignal.timeout(30000)});
  if (!models.some(model => model.slug === 'gpt-6.1-sol')) throw new Error('gpt_6_1_sol_unavailable');
  if (process.argv.includes('--check')) {
    send({type:'ready', authorized:true, model:'gpt-6.1-sol'});
  } else {
    const {DeepSeekHarness} = await import(pathToFileURL(join(harnessRoot, 'packages/sdk/client/lib/index.js')).href);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD/.test(key)));
    harness = new DeepSeekHarness({
      profile:'sdk-minimal', patches:[join(here, 'voice.patch.yml')],
      provider:'opennova-chatgpt', model:'gpt-6.1-sol',
      dshHome:join(homedir(), '.local/share/opennova/harness-home'),
      processCwd:root, cwd:root, initializeTimeoutMs:30000, requestTimeoutMs:180000,
      env:{...env, OPENNOVA_HARNESS_ROOT:harnessRoot,
        OPENNOVA_SIWC_ROOT:settings.siwcRoot, OPENNOVA_SIWC_STORAGE:settings.storageDir,
        OPENNOVA_KEYCHAIN_HELPER:settings.keychainPath},
    });
    await harness.start();
    send({type:'ready', authorized:true, model:'gpt-6.1-sol', harness:'DeepSeek Harness', tools:false});
    let sessionId;
    const input = createInterface({input:process.stdin, crlfDelay:Infinity});
    for await (const line of input) {
      if (line.length > 20000) throw new Error('input_too_large');
      const request = JSON.parse(line);
      if (request.type === 'close') break;
      if (request.type !== 'ask' || typeof request.text !== 'string' || !request.text.trim() || request.text.length > 8000) throw new Error('invalid_request');
      const started = Date.now();
      const result = await harness.run(request.text, {sessionId});
      sessionId = result.sessionId;
      const text = completedReply(result);
      send({type:'reply', id:request.id, text, sessionId, elapsed_ms:Date.now()-started});
    }
  }
} catch (error) {
  // Provider/SDK errors may include prompts or stderr; expose only controlled codes.
  const code = /^[a-z0-9_]{1,100}$/.test(error.message ?? '') ? error.message : 'agent_runtime_failed';
  send({type:'error', code});
  if (process.env.OPENNOVA_DEBUG === '1') process.stderr.write(String(error.stack) + '\n');
  process.exitCode = 1;
} finally {
  await harness?.close();
}
// The official SDK retains idle connection handles; all owned Harness work has closed.
process.exit(process.exitCode ?? 0);
