/** Opt-in live voice bridge. Legacy worker remains a complete-result-only path. */
import {createInterface} from 'node:readline';
import {dirname,resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createClient} from './chatgpt.mjs';
import {completedReply} from './result.mjs';
import {loadSettings} from './settings.mjs';
import {errorEvent} from './errors.mjs';
import {voiceSocket,bounded} from './voice-socket.mjs';

process.umask(0o077);
const here=dirname(fileURLToPath(import.meta.url)), root=resolve(here,'../..');
const settings=loadSettings();
const send=value => process.stdout.write(JSON.stringify(value)+'\n');
let harness,control,active,stage='authorization',input,closing=false;
const sessionId='session-'+randomUUID().replaceAll('-','');
async function cancel() {
  const current=active;
  if (!current) return;
  current.cancelled=true;
  await current.armed;
  await control.command('cancel',current.id);
  await bounded(current.work,25000);
}
async function close() {
  if (closing) return;
  closing=true;
  input?.close();
  try {await cancel();} catch { /* close() below reaps an unresponsive owned runtime. */ }
  try {await harness?.close();} finally {control?.close();}
}
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => {
  void close().finally(() => process.exit(130));
});
try {
  const client=await createClient();
  const session=await client.getSession();
  if (session.status !== 'connected' || !session.sharing) throw new Error('chatgpt_authorization_required');
  stage='model_catalog';
  const models=await client.listModels({signal:AbortSignal.timeout(30000)});
  if (!models.some(m => m.slug === 'gpt-6.1-sol')) throw new Error('gpt_6_1_sol_unavailable');
  stage='harness_start';
  control=await voiceSocket(event => {
    if (active && !active.cancelled && event.id === active.id) send(event);
  });
  const {DeepSeekHarness}=await import(pathToFileURL(join(settings.harnessRoot,'packages/sdk/client/lib/index.js')).href);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD/.test(key)));
  harness=new DeepSeekHarness({profile:'sdk-minimal',patches:[join(here,'voice.patch.yml'),join(here,'stream.patch.yml')],
    provider:'opennova-chatgpt',model:'gpt-6.1-sol',cwd:root,processCwd:root,
    dshHome:join(homedir(),'.local/share/opennova/harness-home'),initializeTimeoutMs:30000,requestTimeoutMs:180000,
    env:{...env,OPENNOVA_HARNESS_ROOT:settings.harnessRoot,OPENNOVA_SIWC_ROOT:settings.siwcRoot,
      OPENNOVA_KEYCHAIN_HELPER:settings.keychainPath,OPENNOVA_SIWC_STORAGE:settings.storageDir,
      OPENNOVA_VOICE_SOCKET:control.path}});
  await harness.start();await control.ready();stage='conversation';
  send({type:'ready',model:'gpt-6.1-sol',sessionId,streaming:true,cancellation:true,tools:false});
  input=createInterface({input:process.stdin,crlfDelay:Infinity});
  for await (const line of input) {
    let request;
    try {
      if (line.length>20000) throw new Error('input_too_large');
      request=JSON.parse(line);
      if (request.type === 'close') break;
      if (request.type === 'cancel') {
        if (active?.id === request.id) void cancel().catch(() => {void close().finally(() => process.exit(1));});
        else send({type:'cancelled',id:request.id});
        continue;
      }
      if (request.type !== 'ask' || active || !Number.isSafeInteger(request.id) ||
          typeof request.text !== 'string' || !request.text.trim() || request.text.length>8000) throw new Error('invalid_request');
      const current={id:request.id,cancelled:false,started:Date.now()};active=current;
      current.armed=control.command('arm',current.id,sessionId);
      current.work=(async () => {
        let event;
        try {
          await current.armed;
          if (!current.cancelled) {
            const result=await harness.run(request.text,{sessionId});
            if (!current.cancelled) event={type:'reply',id:current.id,text:completedReply(result),sessionId,elapsed_ms:Date.now()-current.started};
          }
        } catch (error) {event={...errorEvent(error,'conversation'),id:current.id};}
        if (current.cancelled) event={type:'cancelled',id:current.id};
        if (active === current) active=undefined;
        send(event);
      })();
    } catch(error) {send({...errorEvent(error,'conversation'),id:request?.id});}
  }
} catch(error) {send(errorEvent(error,stage));process.exitCode=1;}
finally {await close();}
process.exit(process.exitCode??0);
