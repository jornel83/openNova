/** Explicit real-account read-only probe. No raw provider errors or credentials are persisted. */
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {loadSettings} from '../../services/agent/settings.mjs';
import {voiceSocket,bounded} from '../../services/agent/voice-socket.mjs';
import {completedReply} from '../../services/agent/result.mjs';
import {errorEvent} from '../../services/agent/errors.mjs';
process.umask(0o077);
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
if (!process.argv.includes('--protocol-only')) throw Error('Use --protocol-only');
const settings=loadSettings(), events=[];
let harness,control;
const evidence={kind:'protocol',startedAt:new Date().toISOString(),steps:[]};
try {
  const {DeepSeekHarness}=await import(pathToFileURL(join(settings.harnessRoot,'packages/sdk/client/lib/index.js')));
  control=await voiceSocket(e=>events.push(e));
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/KEY|TOKEN|SECRET|PASSWORD/.test(k)));
  if(env.OPENNOVA_PROXY)Object.assign(env,{HTTPS_PROXY:env.OPENNOVA_PROXY,HTTP_PROXY:env.OPENNOVA_PROXY,NODE_USE_ENV_PROXY:'1',NO_PROXY:'localhost,127.0.0.1'});
  harness=new DeepSeekHarness({profile:'sdk-minimal',patches:['voice.patch.yml','stream.patch.yml','tests/fixtures/probe.patch.yml'].map(p=>join(root,'services/agent',p)),
    provider:'opennova-chatgpt',model:'gpt-6.1-sol',cwd:root,processCwd:root,
    dshHome:join(root,'output/agent/web-probe-home'),initializeTimeoutMs:30000,requestTimeoutMs:180000,
    env:{...env,OPENNOVA_HARNESS_ROOT:settings.harnessRoot,OPENNOVA_SIWC_ROOT:settings.siwcRoot,OPENNOVA_KEYCHAIN_HELPER:settings.keychainPath,OPENNOVA_SIWC_STORAGE:settings.storageDir,OPENNOVA_VOICE_SOCKET:control.path}});
  await harness.start();await control.ready();
  const sessionId='session-'+randomUUID().replaceAll('-','');
  await control.command('arm',1,sessionId);
  const first=await harness.run('Call lookup_probe_value exactly once, then tell me the value returned.',{sessionId});
  const calls=first.events.filter(e=>e.type==='tool/call');
  const results=first.events.filter(e=>e.type==='tool/result');
  if(calls.length!==1 || results.length!==1 || !completedReply(first).includes('opennova-web-probe-ok'))throw Error('probe_roundtrip_failed');
  evidence.steps.push({roundtrip:true,executions:calls.length,callIds:calls.map(c=>c.callId??c.data?.callId),resultCount:results.length});
  console.log('Protocol roundtrip passed; testing cancellation.');
  await control.command('arm',2,sessionId);
  const interrupted=harness.run('Call lookup_probe_value with wait=true.',{sessionId});
  await new Promise(r=>setTimeout(r,500));
  await control.command('cancel',2);
  const cancelled=await bounded(interrupted,25000);
  evidence.steps.push({cancelled:cancelled.events.some(e=>e.type==='turn/end'&&e.data?.reason?.kind==='aborted')});
  if(!evidence.steps.at(-1).cancelled)throw Error('probe_cancel_failed');
  await control.command('arm',3,sessionId);
  const next=await harness.run('Call lookup_probe_value once again without waiting, and answer with the value.',{sessionId});
  evidence.steps.push({continued:completedReply(next).includes('opennova-web-probe-ok')});
  if(!evidence.steps.at(-1).continued)throw Error('probe_continue_failed');
  evidence.passed=true;
} catch(error) { evidence.error=errorEvent(error,'conversation');process.exitCode=1;}
finally {await harness?.close();control?.close();}
const directory=join(root,'output/agent/web-verification');mkdirSync(directory,{recursive:true});
const path=join(directory,`protocol-${Date.now()}.json`);writeFileSync(path,JSON.stringify(evidence,null,2));
console.log(JSON.stringify({...evidence,evidenceFile:path},null,2));
