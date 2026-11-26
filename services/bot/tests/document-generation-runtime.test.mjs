import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,realpathSync,readdirSync} from 'node:fs';
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
import {INPUT} from './fixtures/document-generation-provider.mjs';

async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');

test('real Harness uses fixed document generation tools with project isolation, collision protection and durable receipts',{timeout:180000},async t=>{
  // Real project paths may contain Chinese and spaces; compiler scratch space must not inherit them.
  const sources=requireBuiltHarness(),home=realpathSync(mkdtempSync(join(tmpdir(),'nova-document-generation-中文 项目-')));
  const port=await freePort();let webPort=await freePort();while(webPort===port)webPort=await freePort();
  const b={...botSettings({OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(port),OPENNOVA_BOT_WEB_PORT:String(webPort)}),workspace:join(home,'workspace')};
  for(const dir of ['workspace','alpha','beta'])mkdirSync(join(home,dir),{recursive:true});
  const token='offline-document-generation-fixture';writeFileSync(b.tokenPath,token);
  const patch=runtimePatch({bot:b,agent:{harnessRoot:sources.harnessRoot},desktop:false});
  patch.find(row=>row.insert).insert.find(p=>p.id==='opennova-chatgpt').name=join(ROOT,'services/bot/tests/fixtures/document-generation-provider.mjs');
  const patchPath=join(home,'test.patch.json');writeFileSync(patchPath,JSON.stringify(patch));
  let child,logs='';
  async function stop(){if(!child||child.exitCode!==null||child.signalCode!==null)return;const exit=once(child,'exit');child.kill('SIGTERM');const kill=setTimeout(()=>child.kill('SIGKILL'),5000);try{await exit;}finally{clearTimeout(kill);}}
  t.after(async()=>{await stop();rmSync(home,{recursive:true,force:true});});
  async function api(path,body={},expectSuccess=true){
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    assert.equal(response.ok,expectSuccess,await response.clone().text());return response.json();
  }
  async function waitFor(fn,timeout=90000){
    const end=Date.now()+timeout;
    while(Date.now()<end){
      try{const result=await fn();if(result)return result;}
      catch(error){if(child.exitCode!==null||error.code==='ERR_ASSERTION')throw Error(error.message+'\n'+logs);}
      await delay(40);
    }
    throw Error('document generation runtime timed out\n'+logs);
  }
  async function start(){
    child=spawn(process.execPath,[join(sources.harnessRoot,'apps/cli/lib/bin.js'),'--profile','web','--patch',patchPath,'--host','127.0.0.1','--port',String(webPort),'--no-open'],{
      cwd:b.workspace,stdio:['ignore','pipe','pipe'],env:{...process.env,DSH_HOME:join(home,'harness'),OPENNOVA_BOT_PLUGIN:sources.botRoot,OPENNOVA_HARNESS_ROOT:sources.harnessRoot,
        NODE_OPTIONS:'--import='+JSON.stringify(join(ROOT,'services/bot/resolve.mjs')),PATH:dirname(process.execPath)+':'+process.env.PATH}});
    child.stdout.on('data',data=>{logs=(logs+data).slice(-20000);});child.stderr.on('data',data=>{logs=(logs+data).slice(-20000);});
    return waitFor(async()=>{try{const health=await api('/health');return health.ready&&health;}catch(error){if(child.exitCode!==null)throw error;return false;}},30000);
  }
  async function result(id){return waitFor(async()=>{const record=await api('/result',{id});assert.ok(!['failed','cancelled','interrupted'].includes(record.status),JSON.stringify(record));return record.status==='completed'&&record;});}
  async function ask(id,text){const {state}=await api('/projects');await api('/ask',{id,text,source:'text',expectedProject:{projectId:state.projectId,revision:state.revision}});return result(id);}
  const generationOps=async()=>(await api('/operations')).filter(r=>r.operation==='document_generate');
  function assertArtifact(record,projectId,path,format){
    const reply=JSON.parse(record.text),r=reply.result;
    assert.deepEqual(reply.executed,['write','document_generate']);
    assert.equal(record.projectId,projectId);assert.equal(r.status,'completed',JSON.stringify(r));
    assert.equal(r.artifact.path,path);assert.equal(r.artifact.format,format);assert.equal(r.artifact.projectId,projectId);
    assert.equal(r.artifact.sha256,hash(path));assert.equal(r.contentValidation.status,'passed');
    assert.equal(r.layoutValidation.visual.status,'not_checked','runtime must not claim independent visual review');
    const bytes=readFileSync(path);assert.ok(bytes.length>1000);
    if(format==='docx')assert.deepEqual([...bytes.subarray(0,4)],[80,75,3,4]);
    else{assert.match(bytes.subarray(0,16).toString('ascii'),/^%PDF-/);assert.ok(r.pageCount>=3,'72-row PDF must retain natural multi-page content');}
    return r;
  }

  const identity=(await start()).botId;
  const alpha=(await api('/project-action',{action:'create',actionId:'create-alpha',name:'文档甲',directory:join(home,'alpha')})).result;
  const beta=(await api('/project-action',{action:'create',actionId:'create-beta',name:'文档乙',directory:join(home,'beta')})).result;
  const aPath=join(home,'alpha/report.docx'),bPath=join(home,'beta/report.docx');
  const first=await ask('generate-alpha',INPUT.alpha),a=assertArtifact(first,alpha.id,aPath,'docx'),aHash=hash(aPath);
  assert.equal((await api('/snapshot')).workContext.file.path,aPath);
  assert.equal((await api('/project-detail',{id:alpha.id})).references.length,0,'generating an artifact must not implicitly add long-term material');
  const second=await ask('generate-beta',INPUT.beta);assertArtifact(second,beta.id,bPath,'docx');
  assert.equal(hash(aPath),aHash);assert.notEqual(hash(bPath),aHash);
  assert.equal((await api('/snapshot')).workContext.file.path,bPath);

  const conflict=JSON.parse((await ask('generate-collision',INPUT.collision)).text).result;
  assert.equal(conflict.status,'failed');assert.match(conflict.error,/exist|conflict/);assert.equal(hash(aPath),aHash);
  assert.equal((await api('/snapshot')).workContext.file.path,aPath,'failed generation must preserve the restored alpha object');
  let finalPath=aPath,expectedOperations=3;
  if(process.platform==='darwin'){
    finalPath=join(home,'alpha/report.pdf');
    assertArtifact(await ask('generate-pdf',INPUT.pdf),alpha.id,finalPath,'pdf');expectedOperations++;
    assert.equal((await api('/snapshot')).workContext.file.path,finalPath,'final PDF, not an internal preview, becomes current');
  }
  const before=await generationOps();assert.equal(before.length,expectedOperations);
  assert.equal(before.filter(r=>r.status==='completed').length,expectedOperations-1);
  assert.ok(before.every(r=>r.projectId===alpha.id||r.projectId===beta.id));
  assert.equal(before.find(r=>r.requestId==='generate-alpha').artifact.sha256,a.artifact.sha256);
  const otherOperations=await api('/operations');
  assert.equal(otherOperations.filter(r=>r.tool==='bash').length,0,'the model never writes or executes a generation script');
  for(const project of ['alpha','beta']){
    assert.ok(!existsSync(join(home,project,'SHOULD_NOT_EXECUTE')));
    assert.ok(readdirSync(join(home,project)).every(name=>!name.endsWith('.py')&&!name.endsWith('.swift')&&!name.endsWith('.png')));
  }

  const note=JSON.parse((await ask('save-research-note',INPUT.note)).text).result;
  assert.equal(note.status,'completed',JSON.stringify(note));assert.equal(note.path,join(home,'alpha/notes/next.md'));
  assert.match(readFileSync(note.path,'utf8'),/是否需要再安排一次访谈/);
  finalPath=note.path;
  await stop();assert.equal((await start()).botId,identity);
  const looked=JSON.parse((await ask('lookup-research-note',INPUT.lookup)).text).result;
  assert.equal(looked.noteId,note.noteId);assert.deepEqual(looked.claims,note.claims);assert.equal(looked.diskStatus,'unchanged');
  assert.equal((await api('/snapshot')).workContext.file.path,finalPath);
  assert.equal((await generationOps()).length,expectedOperations);
  assert.equal((await api('/ask',{id:'generate-alpha',text:INPUT.alpha,source:'text'})).duplicate,true);
  assert.equal(hash(aPath),aHash);assert.equal((await generationOps()).length,expectedOperations,'replayed admission must not regenerate an existing artifact');
  const revision=JSON.parse((await ask('revise-saved-word',INPUT.revision)).text).result;
  const v2=join(home,'alpha','report.v2.docx');
  assert.equal(revision.status,'completed',revision.error);assert.equal(revision.phase,'proposed');
  const proposal=revision.proposal;
  assert.equal(proposal.baseArtifactId,a.artifact.id);assert.equal(proposal.baseRevision,1);
  assert.equal(proposal.basePath,aPath);assert.equal(proposal.baseSha256,aHash);
  assert.equal(hash(aPath),aHash);assert.equal(existsSync(v2),false);
  const state=(await api('/projects')).state,expectedProject={projectId:state.projectId,revision:state.revision};
  const detail=await api('/document-proposal',{id:proposal.id,expectedProject});
  assert.equal(detail.status,'pending');assert.ok(detail.changes.some(c=>c.before==='ALPHA 文档工具验收 & <中文>'&&c.after==='线下验收第二版'));
  for(const path of ['/approve','/reject'])assert.equal((await api(path,{id:proposal.id},false)).error,'invalid_approval');
  await stop();assert.equal((await start()).botId,identity);
  const restored=await api('/snapshot');assert.equal(restored.workContext.file.path,finalPath);
  assert.ok(restored.approvals.some(r=>r.proposal?.id===proposal.id));assert.deepEqual(await api('/document-proposal',{id:proposal.id,expectedProject}),detail);
  const switched=await api('/project-action',{action:'select',actionId:'return-to-beta',projectId:beta.id,revision:state.revision});
  assert.ok(!(await api('/snapshot')).approvals.some(r=>r.proposal?.id===proposal.id));
  assert.ok(!(await generationOps()).some(r=>r.proposal?.id===proposal.id));
  assert.equal((await api('/document-proposal',{id:proposal.id,expectedProject},false)).error,'project_state_changed');
  assert.equal((await api('/document-proposal',{id:proposal.id,expectedProject:{projectId:beta.id,revision:switched.state.revision}},false)).error,'document_proposal_not_found');
  const decide={id:proposal.id,actionId:'cross-project-click',action:'confirm'};
  assert.equal((await api('/document-proposal-action',{...decide,expectedProject},false)).error,'project_state_changed');
  assert.equal((await api('/document-proposal-action',{...decide,expectedProject:{projectId:beta.id,revision:switched.state.revision}},false)).error,'document_proposal_not_found');
  assert.equal(existsSync(v2),false);
  const changedBytes=Buffer.concat([readFileSync(aPath),Buffer.from('External editor change')]);writeFileSync(aPath,changedBytes);
  const disputed=JSON.parse((await ask('revise-external-word',INPUT.disputed)).text).result;
  assert.equal(disputed.error,'document_revision_source_changed');assert.equal(disputed.phase,'not_committed');
  assert.deepEqual(readFileSync(aPath),changedBytes);assert.equal(existsSync(v2),false);
  assert.ok((await api('/snapshot')).approvals.some(r=>r.proposal?.id===proposal.id));
  const abandoned=JSON.parse((await ask('discard-previous-proposal',INPUT.discard)).text).result;
  assert.equal(abandoned.phase,'discarded');assert.equal(abandoned.proposal.id,proposal.id);
  assert.ok((await api('/snapshot')).approvals.some(r=>r.proposal?.id===proposal.id&&r.proposal.status==='discarded'));
  const here=(await api('/projects')).state,repeat={id:proposal.id,action:'discard',actionId:'repeat-discard',expectedProject:{projectId:here.projectId,revision:here.revision}};
  assert.equal((await api('/document-proposal-action',repeat)).phase,'discarded');
  assert.equal((await api('/document-proposal-action',repeat)).phase,'discarded');
  assert.deepEqual(readFileSync(aPath),changedBytes);assert.equal(existsSync(v2),false);
  expectedOperations+=3;
  assert.equal((await generationOps()).length,expectedOperations);
  const daily=JSON.parse((await ask('generation-daily',INPUT.daily)).text);
  assert.deepEqual(daily.executed,[]);assert.equal(daily.available.includes('document_generate'),false);
  assert.equal((await generationOps()).length,expectedOperations-1,'daily mode hides the project proposal');assert.equal((await api('/snapshot')).busy,false);

  const betaReview=JSON.parse((await ask('revise-beta',INPUT.reviseBeta)).text).result.proposal;
  const betaState=(await api('/projects')).state,betaExpected={projectId:beta.id,revision:betaState.revision};
  const applyBeta={id:betaReview.id,action:'confirm',actionId:'confirm-beta-review',expectedProject:betaExpected};
  const applied=await api('/document-proposal-action',applyBeta);
  assert.equal(applied.phase,'committed');assert.equal(applied.artifact.path,join(home,'beta/report.v2.docx'));
  assert.equal((await api('/snapshot')).approvals.find(r=>r.proposal?.id===betaReview.id&&r.operation==='document_generate').proposal.undoAvailable,true);
  assert.deepEqual(JSON.parse((await ask('keep-beta-edition',INPUT.keepBeta)).text).executed,[]);
  const betaV3=join(home,'beta/report.v3.docx');assert.equal(existsSync(betaV3),false);
  const undone=JSON.parse((await ask('undo-beta-edition',INPUT.undoBeta)).text).result;
  assert.equal(undone.phase,'undone',JSON.stringify(undone));assert.equal(undone.artifact.path,betaV3);
  assert.equal(hash(betaV3),hash(bPath));assert.equal(hash(applied.artifact.path),applied.artifact.sha256);
  assert.equal((await api('/snapshot')).workContext.file.path,betaV3);
  await stop();assert.equal((await start()).botId,identity);
  const persisted=await api('/document-proposal',{id:betaReview.id,expectedProject:betaExpected});
  assert.equal(persisted.status,'undone');assert.equal(persisted.undoArtifact.id,undone.artifact.id);
  const replayed=await api('/document-proposal-action',{...applyBeta,action:'undo',actionId:'repeat-undo-after-restart'});
  assert.equal(replayed.artifact.id,undone.artifact.id);assert.equal(existsSync(join(home,'beta/report.v4.docx')),false);
  assert.equal((await api('/document-proposal-action',{...applyBeta,id:proposal.id,action:'undo',actionId:'wrong-project-undo'},false)).error,'document_proposal_not_found');
});
