import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,realpathSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {ROOT,requireBuiltHarness} from '../../runtime/sources.mjs';
import {botSettings} from '../settings.mjs';
import {runtimePatch} from '../configuration.mjs';
import {INPUT} from './fixtures/native-file-provider.mjs';

async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
const pdf=marker=>Buffer.from('%PDF-1.7\n'+marker+'\n%%EOF\n');
const decode=result=>JSON.parse(result.text);

test('real Harness reads both file entries with fixed project sources, replay, cancellation and duplicate admission',{timeout:120000},async t=>{
  const sources=requireBuiltHarness(),home=realpathSync(mkdtempSync(join(tmpdir(),'nova-native-file-runtime-')));
  const port=await freePort();let webPort=await freePort();while(webPort===port)webPort=await freePort();
  const b={...botSettings({OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(port),OPENNOVA_BOT_WEB_PORT:String(webPort)}),workspace:join(home,'workspace')};
  for(const dir of ['workspace','alpha/nested','alpha/one','alpha/two','beta'])mkdirSync(join(home,dir),{recursive:true});
  const alphaPath=join(home,'alpha/nested/source.pdf'),betaPath=join(home,'beta/source.pdf');
  writeFileSync(alphaPath,pdf('NATIVE_ALPHA_ONLY'));writeFileSync(betaPath,pdf('NATIVE_BETA_ONLY'));
  writeFileSync(join(home,'alpha/dup.pdf'),pdf('NATIVE_DUPLICATE_ONLY'));
  writeFileSync(join(home,'alpha/late.pdf'),pdf('NATIVE_LATE_ONLY'));
  for(const dir of ['one','two'])writeFileSync(join(home,'alpha',dir,'same.pdf'),pdf('NATIVE_AMBIGUOUS_ONLY'));
  const token='offline-native-file-fixture',trace=join(home,'reader.jsonl');writeFileSync(b.tokenPath,token);
  const windowPointer=join(home,'document-window');writeFileSync(windowPointer,'');
  const patch=runtimePatch({bot:b,agent:{harnessRoot:sources.harnessRoot},desktop:false});
  const plugins=patch.find(row=>row.insert).insert,provider=plugins.find(p=>p.id==='opennova-chatgpt'),host=plugins.find(p=>p.id==='opennova-bot');
  provider.name=join(ROOT,'services/bot/tests/fixtures/native-file-provider.mjs');
  host.config.nativeFileReaderModule=join(ROOT,'services/bot/tests/fixtures/native-file-reader.mjs');
  host.config.trackOpenDocuments=true;
  host.config.openDocumentTrackerModule=host.config.nativeFileReaderModule;
  const patchPath=join(home,'test.patch.json');writeFileSync(patchPath,JSON.stringify(patch));
  let child,logs='';
  async function stop(){if(!child||child.exitCode!==null||child.signalCode!==null)return;const exit=once(child,'exit');child.kill('SIGTERM');const kill=setTimeout(()=>child.kill('SIGKILL'),5000);try{await exit;}finally{clearTimeout(kill);}}
  t.after(async()=>{await stop();rmSync(home,{recursive:true,force:true});});
  const calls=()=>existsSync(trace)?readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  const readCount=()=>calls().filter(row=>row.phase==='started').length;
  async function api(path,body={}){const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});assert.equal(response.status,200,await response.clone().text());return response.json();}
  async function waitFor(fn,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){try{const result=await fn();if(result)return result;}catch(error){if(child.exitCode!==null||error.code==='ERR_ASSERTION')throw Error(error.message+'\n'+logs);}await delay(40);}throw Error('native file runtime timed out\n'+logs);}
  async function start(){
    child=spawn(process.execPath,[join(sources.harnessRoot,'apps/cli/lib/bin.js'),'--profile','web','--patch',patchPath,'--host','127.0.0.1','--port',String(webPort),'--no-open'],{cwd:b.workspace,stdio:['ignore','pipe','pipe'],env:{...process.env,DSH_HOME:join(home,'harness'),OPENNOVA_BOT_PLUGIN:sources.botRoot,OPENNOVA_HARNESS_ROOT:sources.harnessRoot,OPENNOVA_NATIVE_FILE_TEST_TRACE:trace,OPENNOVA_TEST_ACTIVE_DOCUMENT:windowPointer,NODE_OPTIONS:'--import='+JSON.stringify(join(ROOT,'services/bot/resolve.mjs')),PATH:dirname(process.execPath)+':'+process.env.PATH}});
    child.stdout.on('data',data=>{logs=(logs+data).slice(-20000);});child.stderr.on('data',data=>{logs=(logs+data).slice(-20000);});
    return waitFor(async()=>{try{const health=await api('/health');return health.ready&&health;}catch(error){if(child.exitCode!==null)throw error;return false;}});
  }
  async function result(id){return waitFor(async()=>{const record=await api('/result',{id});assert.ok(!['failed','cancelled','interrupted'].includes(record.status),JSON.stringify(record));return record.status==='completed'&&record;});}
  async function ask(id,text,source='text'){const {state}=await api('/projects');await api('/ask',{id,text,source,expectedProject:{projectId:state.projectId,revision:state.revision}});return result(id);}

  const identity=(await start()).botId;
  const a=(await api('/project-action',{action:'create',actionId:'create-alpha',name:'甲项目',directory:join(home,'alpha')})).result;
  const beta=(await api('/project-action',{action:'create',actionId:'create-beta',name:'乙项目',directory:join(home,'beta')})).result;
  const first=await ask('alpha-name',INPUT.name),one=decode(first);
  assert.equal(first.projectId,a.id);assert.equal(one.result.status,'completed');assert.equal(one.result.content,'NATIVE_ALPHA_ONLY');
  assert.equal(one.result.source.path,alphaPath);assert.equal(one.result.source.projectId,a.id);assert.equal(one.result.source.requestId,first.id);
  assert.equal(one.result.source.sha256,createHash('sha256').update(pdf('NATIVE_ALPHA_ONLY')).digest('hex'));
  assert.deepEqual(readFileSync(one.result.source.snapshotPath),pdf('NATIVE_ALPHA_ONLY'));
  assert.equal((await api('/snapshot')).workContext.file.path,alphaPath);
  const count=readCount(),current=decode(await ask('alpha-current-voice',INPUT.current,'voice'));
  assert.equal(current.result.status,'completed');assert.equal(current.result.source.path,alphaPath);assert.equal(readCount(),count+1);
  const missing=decode(await ask('beta-no-current',INPUT.betaMissing));assert.equal(missing.result.status,'failed');assert.equal(readCount(),count+1);assert.equal(missing.alpha,false);
  const other=decode(await ask('beta-name',INPUT.beta));assert.equal(other.result.source.projectId,beta.id);assert.equal(other.result.content,'NATIVE_BETA_ONLY');assert.equal(other.alpha,false);
  const back=decode(await ask('alpha-return',INPUT.current));assert.equal(back.result.source.path,alphaPath);assert.equal(back.beta,false);
  const beforeAmbiguous=readCount(),ambiguous=decode(await ask('alpha-ambiguous',INPUT.ambiguous));
  assert.equal(ambiguous.result.status,'needs_clarification');assert.equal(ambiguous.result.candidates.length,2);assert.equal(readCount(),beforeAmbiguous);
  assert.equal((await api('/snapshot')).workContext.file.path,alphaPath);

  await stop();assert.equal((await start()).botId,identity);
  assert.equal((await api('/snapshot')).workContext.file.path,alphaPath);
  const beforeReplay=readCount();unlinkSync(alphaPath);
  const history=decode(await ask('alpha-history',INPUT.history));
  assert.equal(history.alpha,true);assert.equal(history.beta,false);assert.ok(history.historySourceIds.includes(one.result.source.sourceId));assert.equal(readCount(),beforeReplay);
  assert.deepEqual(readFileSync(one.result.source.snapshotPath),pdf('NATIVE_ALPHA_ONLY'));
  writeFileSync(alphaPath,pdf('NATIVE_ALPHA_CHANGED'));
  const changed=decode(await ask('alpha-changed',INPUT.changed));assert.equal(changed.result.status,'failed');assert.match(changed.result.error,/changed|version/);assert.equal(readCount(),beforeReplay);

  const {state}=await api('/projects'),request={id:'alpha-duplicate',text:INPUT.duplicate,source:'text',expectedProject:{projectId:state.projectId,revision:state.revision}};
  const beforeDuplicate=readCount(),receipts=await Promise.all([api('/ask',request),api('/ask',request)]);
  assert.equal(receipts.filter(r=>r.duplicate).length,1);assert.equal(decode(await result(request.id)).result.content,'NATIVE_DUPLICATE_ONLY');assert.equal(readCount(),beforeDuplicate+1);
  assert.equal((await api('/ask',request)).duplicate,true);assert.equal(readCount(),beforeDuplicate+1);

  const beforeCancel=(await api('/snapshot')).workContext;
  await api('/ask',{id:'alpha-cancel',text:INPUT.late,source:'voice'});
  await waitFor(()=>calls().some(row=>row.marker==='NATIVE_LATE_ONLY'&&row.phase==='started'));
  await api('/cancel',{id:'alpha-cancel'});
  await waitFor(()=>calls().some(row=>row.marker==='NATIVE_LATE_ONLY'&&row.phase==='returned'));
  assert.equal((await api('/result',{id:'alpha-cancel'})).status,'cancelled');
  assert.deepEqual((await api('/snapshot')).workContext,beforeCancel);
  const nativeOperations=(await api('/operations')).filter(r=>r.operation==='document_read');
  assert.equal(nativeOperations.filter(r=>r.requestId==='alpha-duplicate').length,1);
  const cancelledReads=nativeOperations.filter(r=>r.requestId==='alpha-cancel');
  assert.equal(cancelledReads.length,1);assert.ok(cancelledReads.every(r=>r.status!=='completed'));
  assert.equal((await api('/snapshot')).busy,false);
  assert.equal((await api('/project-detail',{id:a.id})).references.length,0,'reading must not add a persistent project material');

  // The prompt carries only the 12 most recent materials. Name resolution must
  // still use the host's full frozen catalog, including older external files.
  for(const dir of ['external/one','external/two','external/recent'])mkdirSync(join(home,dir),{recursive:true});
  const oldExternal=join(home,'external/old-external.pdf');
  const oldSamePaths=['one','two'].map(dir=>join(home,'external',dir,'old-same.pdf'));
  async function addReference(path,marker,actionId){
    writeFileSync(path,pdf(marker));
    const {project}=await api('/project-detail',{id:a.id});
    await api('/project-reference',{action:'add',actionId,projectId:a.id,revision:project.revision,kind:'file',path});
  }
  await addReference(oldExternal,'NATIVE_OLD_EXTERNAL','old-external');
  for(const [index,path] of oldSamePaths.entries())await addReference(path,'NATIVE_OLD_SAME','old-same-'+index);
  for(let index=0;index<12;index++)await addReference(join(home,'external/recent',`recent-${index}.pdf`),'NATIVE_RECENT','recent-'+index);
  const beforeExternal=readCount(),external=decode(await ask('alpha-old-external',INPUT.oldExternal));
  assert.equal(external.referencePaths.length,12);assert.ok(!external.referencePaths.includes(oldExternal));
  assert.ok(oldSamePaths.every(path=>!external.referencePaths.includes(path)));
  assert.equal(external.result.status,'completed');assert.equal(external.result.source.path,oldExternal);
  assert.equal(external.result.source.projectId,a.id);assert.equal(external.result.content,'NATIVE_OLD_EXTERNAL');
  assert.equal(readCount(),beforeExternal+1);
  const hiddenAmbiguity=decode(await ask('alpha-old-external-ambiguous',INPUT.oldExternalAmbiguous));
  assert.equal(hiddenAmbiguity.referencePaths.length,12);
  assert.ok(oldSamePaths.every(path=>!hiddenAmbiguity.referencePaths.includes(path)));
  assert.equal(hiddenAmbiguity.result.status,'needs_clarification');
  assert.deepEqual(hiddenAmbiguity.result.candidates.map(candidate=>candidate.path).sort(),oldSamePaths.sort());
  assert.equal(readCount(),beforeExternal+1,'ambiguous older materials must not reach the native reader');
  assert.equal((await api('/snapshot')).workContext.file.path,oldExternal);
  assert.equal((await api('/project-detail',{id:a.id})).references.length,15);

  // The external app changes its window after Send. The admitted turn still
  // owns the earlier file even though Nova also has an older project attachment.
  const openPdf=join(home,'external','working-copy.pdf');
  writeFileSync(openPdf,pdf('NATIVE_DESKTOP_PDF'));
  writeFileSync(windowPointer,openPdf);
  const id='desktop-web';
  await api('/ask',{id,text:INPUT.desktop,source:'web'});
  writeFileSync(windowPointer,betaPath);
  const finished=await waitFor(async()=>{const r=await api('/result',{id});return r.status==='completed'&&r;});
  const desktopRead=decode(finished).result;
  assert.equal(desktopRead.source.path,openPdf);
  assert.equal(desktopRead.source.entry,'desktop_open');
  assert.equal(desktopRead.content,'NATIVE_DESKTOP_PDF');

  const voiceRead=decode(await ask('desktop-voice',INPUT.desktopVoice,'voice')).result;
  assert.equal(voiceRead.source.path,betaPath);
  assert.equal(voiceRead.source.entry,'desktop_open');
  const countBeforeMissing=readCount();
  writeFileSync(windowPointer,'');
  const noWindow=decode(await ask('desktop-no-window',INPUT.desktopMissing)).result;
  assert.equal(noWindow.status,'needs_clarification');
  assert.equal(readCount(),countBeforeMissing);

});
