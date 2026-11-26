/** Authenticated A4 acceptance with the frozen A2 TC02 fixture and an isolated, disposable Bot. */
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {chmodSync,copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {loadSettings} from '../services/agent/settings.mjs';
import {runtimePatch} from '../services/bot/configuration.mjs';
import {createWorkContext} from '../services/bot/desktop/context.mjs';
import {createDocumentGenerator} from '../services/bot/documents/generator.mjs';
import {prepareDocumentRevision} from '../services/bot/documents/revisions.mjs';
import {Operations} from '../services/bot/operations.mjs';
import {botSettings} from '../services/bot/settings.mjs';
import {requireBuiltHarness,ROOT} from '../services/runtime/sources.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const originalSpecHash = '3d520ed7454ad52695f04c9f9bed61bd0c502b3d4f3949d597550bc96d795952';
const originalPdfHash = 'f5285e1b7f48b826e288d05aa6e710818d282f9be02b7d3af03600b8ca433bd5';
const title = 'A2-TC02-物资清单';

function tc02Fixture() {
  const archived = join(ROOT,'output/verification/a2-pdf-tc02-20261118/tc02-frozen-spec.json');
  if (existsSync(archived)) return {source:archived,bytes:readFileSync(archived)};
  const rows = Array.from({length:60}, (_,i) => {
    const id = String(i + 1).padStart(2,'0');
    return [id,'测试物资'+id,String(i + 1),'用于检查中文显示与跨页表格完整性'];
  });
  const spec = {schemaVersion:1,title:'测试物资采购清单。',blocks:[
    {type:'paragraph',text:'本清单包含60条合成测试数据，用于检查分页和表格完整性。'},
    {type:'table',columns:['编号','物资名称','数量','说明'],rows,summary:['合计','','1830','']},
    {type:'paragraph',text:'A2-PDF-验收结束。'},
  ],layout:{pageSize:'A4',fontPreset:'cjk',header:'测试物资采购清单',footer:true},sources:[]};
  return {source:'reconstructed from frozen TC02 fixture',bytes:Buffer.from(JSON.stringify(spec))};
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function fileIdentity(path) {
  const stat = statSync(path);
  return {filename:basename(path),sha256:sha(readFileSync(path)),size:stat.size,ino:stat.ino,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs};
}

function documentManifest(ops,project) {
  const files = readdirSync(project.workspace,{recursive:true,withFileTypes:true})
    .filter(file => file.isFile() && /\.(pdf|docx)$/i.test(file.name))
    .map(file => fileIdentity(join(file.parentPath,file.name))).sort((a,b)=>a.filename.localeCompare(b.filename));
  const versions = ops.list('document_artifact').filter(row => row.projectId===project.id)
    .map(row => ({id:row.id,format:row.format,revision:row.revision??1,sha256:row.sha256,snapshotSha256:sha(readFileSync(row.snapshotPath))}))
    .sort((a,b)=>a.format.localeCompare(b.format));
  return {files,versions};
}

function checkProposal(proposal,base,requestId) {
  assert.equal(proposal.status,'pending');
  assert.equal(proposal.projectId,base.projectId);
  assert.equal(proposal.requestId,requestId);
  assert.equal(proposal.baseArtifactId,base.id);
  assert.equal(proposal.basePath,base.path);
  assert.equal(proposal.baseRevision,1);
  assert.equal(proposal.baseSha256,base.sha256);
  assert.equal(proposal.format,base.format);
  assert.equal(proposal.changeCount,2);
  assert.equal(proposal.changes.length,2);
  const cell = proposal.changes.find(change => change.kind==='cell');
  const summary = proposal.changes.find(change => change.kind==='summaryCell');
  assert.ok(cell && summary,'missing row or total change');
  for (const change of [cell,summary]) {
    assert.equal(change.block,2);
    assert.equal(change.column,3);
    assert.equal(change.columnName,'数量');
  }
  assert.equal(cell.row,60);
  assert.deepEqual([cell.before,cell.after],['60','75']);
  assert.deepEqual([summary.before,summary.after],['1830','1845']);
}

// Exercise the old v1 metadata and recipe layout on an isolated copy of the historical PDF.
function importHistoricalPdf({originalPdf,originalHome,home,project,ops}) {
  const path = realpathSync(originalPdf), sourceHome = realpathSync(originalHome);
  const db = new DatabaseSync(join(sourceHome,'bridge.sqlite'),{readOnly:true});
  let old;
  try {
    db.exec('PRAGMA query_only=ON');
    const rows = db.prepare("SELECT body FROM records WHERE kind='document_artifact' AND json_extract(body,'$.path')=?").all(path);
    assert.equal(rows.length,1,'missing historical PDF record');
    old = JSON.parse(rows[0].body);
    const readonly = {
      list(kind) {return db.prepare('SELECT body FROM records WHERE kind=?').all(kind).map(r=>JSON.parse(r.body));},
      get(id) {const row = db.prepare('SELECT body FROM records WHERE id=?').get(id); if (!row) throw Error('unknown_id'); return JSON.parse(row.body);},
    };
    const verified = prepareDocumentRevision({home:sourceHome,ops:readonly,projectId:old.projectId,cwd:dirname(path),path});
    assert.equal(sha(JSON.stringify(verified.spec)),originalSpecHash);
    assert.equal(old.sha256,originalPdfHash);
    assert.equal(sha(readFileSync(old.snapshotPath)),originalPdfHash);
  } finally {db.close();}
  const dir = join(home,'document-generations',basename(dirname(old.specSnapshotPath)));
  mkdirSync(dir,{recursive:true});
  const target = join(project.workspace,basename(path)), snapshotPath = join(dir,'artifact.pdf'), specSnapshotPath = join(dir,'spec.json');
  copyFileSync(path,target); copyFileSync(old.snapshotPath,snapshotPath); copyFileSync(old.specSnapshotPath,specSnapshotPath);
  const {size,ctimeMs,mtimeMs,ino} = statSync(target);
  const base = ops.put({...old,projectId:project.id,path:target,snapshotPath,specSnapshotPath,version:{size,ctimeMs,mtimeMs,ino}});
  // A file opened by a desktop app can receive metadata updates while its contents stay identical.
  const mode = statSync(target).mode & 0o777;
  chmodSync(target,mode ^ 0o100); chmodSync(target,mode);
  return {base,storedCtimeMs:old.version.ctimeMs,liveCtimeMs:statSync(path).ctimeMs};
}

async function run(originalPdf,originalHome,mode) {
  const decisions=mode==='decisions'||mode==='undo';
  assert.equal(!!originalPdf,!!originalHome,'pass the historical TC02 PDF path and its Bot home together');
  const sources = requireBuiltHarness();
  const fixture = tc02Fixture();
  assert.equal(sha(fixture.bytes),originalSpecHash,'unexpected TC02 input');
  const original = originalPdf ? fileIdentity(resolve(originalPdf)) : null;
  if (original) assert.equal(original.sha256,originalPdfHash,'unexpected original TC02 PDF');
  const port = await freePort();
  let web = await freePort();
  while (web===port) web = await freePort();
  const home = realpathSync(mkdtempSync(join(tmpdir(),'nova-a4-preview-')));
  const workspace = join(home,'workspace');
  mkdirSync(workspace);
  const bot = {...botSettings({OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(port),OPENNOVA_BOT_WEB_PORT:String(web)}),workspace};
  const token = randomUUID();
  writeFileSync(bot.tokenPath,token,{mode:0o600});
  const patch = join(home,'acceptance.patch.json');
  writeFileSync(patch,JSON.stringify(runtimePatch({bot,agent:{harnessRoot:sources.harnessRoot},desktop:false})));
  const evidenceDir = join(ROOT,'output/verification','a4-document-'+mode,randomUUID());
  mkdirSync(evidenceDir,{recursive:true});
  const report = {startedAt:new Date().toISOString(),spec:{source:fixture.source,sha256:originalSpecHash},originalPdf:original,steps:[]};
  const save = () => writeFileSync(join(evidenceDir,'report.json'),JSON.stringify(report,null,2)+'\n');
  save();
  console.log('Evidence:',evidenceDir);
  let host,ops;

  async function api(path,body={}) {
    const response = await fetch(bot.url+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
    const value = await response.json();
    if (!response.ok) throw Error(value.error || 'http_'+response.status+'_'+path);
    return value;
  }
  async function wait(read,ms) {
    const end = Date.now()+ms;
    while (Date.now()<end) {
      if (host.exitCode!==null || host.signalCode) throw Error('isolated_host_exited');
      const value = await read();
      if (value) return value;
      await delay(350);
    }
    throw Error('acceptance_deadline');
  }
  async function start() {
    host = spawn(process.execPath,[join(sources.harnessRoot,'apps/cli/lib/bin.js'),'--profile','web','--patch',patch,'--host','127.0.0.1','--port',String(web),'--no-open'],{
      cwd:workspace,stdio:'ignore',env:{
        PATH:dirname(process.execPath)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',HOME:process.env.HOME,USER:process.env.USER,LANG:'en_US.UTF-8',
        DSH_HOME:join(home,'harness'),OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PLUGIN:sources.botRoot,OPENNOVA_HARNESS_ROOT:sources.harnessRoot,
        OPENNOVA_SIWC_STORAGE:loadSettings().storageDir,NODE_OPTIONS:'--import='+JSON.stringify(join(ROOT,'services/bot/resolve.mjs')),
      },
    });
    await wait(async()=>{try{return (await api('/health')).ready;}catch{return false;}},45000);
  }
  async function stop() {
    if (!host || host.exitCode!==null || host.signalCode) return;
    const stopped = once(host,'exit');
    host.kill('SIGTERM');
    const timer = setTimeout(()=>host.kill('SIGKILL'),5000);
    try {await stopped;} finally {clearTimeout(timer);}
  }
  async function project(name,key) {
    const directory = join(home,key);
    mkdirSync(directory);
    return (await api('/project-action',{action:'create',actionId:randomUUID(),name,directory})).result;
  }
  async function current() {
    const {state} = await api('/projects');
    return {projectId:state.projectId,revision:state.revision};
  }
  async function select(id) {
    await api('/project-action',{action:'select',actionId:randomUUID(),projectId:id,focus:'work',revision:(await current()).revision});
    assert.equal((await current()).projectId,id);
  }
  async function ask(text){
    for(let attempt=1;attempt<=3;attempt++){
      const id=randomUUID();
      await api('/ask',{id,text,source:'text',expectedProject:await current()});
      const result=await wait(async()=>{const r=await api('/result',{id});return !['queued','running'].includes(r.status)&&r;},360000);
      const routingOnly=result.routing?.focus==='clarify'&&['route_timeout','route_unavailable'].includes(result.routing.reason);
      if(!routingOnly||attempt===3)return result;
      assert.ok(!(await api('/operations')).some(o=>o.requestId===id),'never retry a turn that dispatched work');
      (report.routingRetries??=[]).push({id,reason:result.routing.reason});save();
      await delay(1500*attempt);
    }
  }
  const proposalIds = snapshot => snapshot.approvals.map(row=>row.proposal?.id).filter(Boolean).sort();
  try {
    await start();
    const a = await project('物资清单验收','inventory'), b = await project('行程排期','calendar');
    await select(a.id);
    ops = new Operations({home,workspace});
    const specPath = join(home,'tc02.json');
    writeFileSync(specPath,fixture.bytes);
    const context = createWorkContext();
    const req = {id:'tc02-seed',projectId:a.id,binding:{projectId:a.id,cwd:a.workspace,focus:'work',context:context.capture()}};
    const generator = createDocumentGenerator({home,ops,context,getRequest:()=>req,selectOutput:false});
    const bases = [];
    for (const format of ['docx','pdf']) {
      if (format==='pdf' && originalPdf) {
        const {base,storedCtimeMs,liveCtimeMs} = importHistoricalPdf({originalPdf,originalHome,home,project:a,ops});
        report.historicalPdf = {sourceReadOnlyVerified:true,sourceId:base.id,storedCtimeMs,liveCtimeMs,byteExactCopy:true};
        bases.push(base);
        continue;
      }
      const row = await generator.generate({format,specPath,outputPath:title+'.'+format},{id:'tc02-seed-'+format});
      assert.equal(row.status,'completed',row.error);
      assert.equal(row.artifact.editableSpecSha256,originalSpecHash);
      bases.push(row.artifact);
    }
    const before = report.before = documentManifest(ops,a);
    const originalNames = ['docx','pdf'].map(format=>title+'.'+format).sort();
    assert.deepEqual(before.files.map(f=>f.filename).sort(),originalNames);
    assert.equal(before.versions.length,2);
    for (const version of before.versions) {
      assert.equal(version.revision,1);
      assert.equal(version.sha256,version.snapshotSha256);
      assert.equal(version.sha256,before.files.find(f=>f.filename.endsWith('.'+version.format)).sha256);
    }
    save();
    const ids = [];
    const expectedSpec = JSON.parse(fixture.bytes);
    const table = expectedSpec.blocks[1];
    table.rows[59][2] = '75';
    table.summary[2] = String(table.rows.reduce((sum,row)=>sum + Number(row[2]),0));
    assert.equal(table.summary[2],'1845');
    for (const base of bases) {
      const format = base.format;
      const message = '继续当前项目，把 '+title+'.'+format+' 里第60行“测试物资60”的数量改成75，并同步更新数量合计。'
        + (format==='docx'?'先给我看修改对照。':'请帮我保存修改。');
      const step = {format,message};
      report.steps.push(step); save();
      const result=await ask(message),id=result.id;
      step.id=id;step.routing=result.routing;
      step.status = result.status;
      step.answer = result.text;
      step.operations = (await api('/operations')).filter(row=>row.requestId===id)
        .map(({operation,action,phase,status,error,proposal,artifact})=>({operation,action,phase,status,error,proposal,artifactId:artifact?.id}));
      step.after = documentManifest(ops,a);
      save();
      assert.equal(result.status,'completed',result.error);
      assert.equal(result.projectId,a.id);
      assert.deepEqual(step.after,before,'workspace or document versions changed before confirmation');
      const receipts = step.operations.filter(r=>r.phase==='proposed');
      assert.equal(receipts.length,1,'expected a single proposal');
      assert.ok(!step.operations.some(r=>r.phase==='committed' || r.artifactId),'unexpected publication');
      const [receipt] = receipts;
      assert.equal(receipt.status,'completed');
      checkProposal(receipt.proposal,base,id);
      const candidate = await api('/document-proposal',{id:receipt.proposal.id,expectedProject:await current()});
      checkProposal(candidate,base,id);
      assert.deepEqual(candidate.changes,receipt.proposal.changes);
      assert.deepEqual(ops.get(candidate.id).spec,expectedSpec,'unexpected collateral edits in the private candidate');
      step.entireCandidateSpecMatches = true;
      ids.push(candidate.id);
      assert.deepEqual(proposalIds(await api('/snapshot')),ids.toSorted());
      const visibleAnswer = (result.text || '').replace(/[,，]/g,'');
      for (const value of ['60','75','1830','1845']) assert.ok(visibleAnswer.includes(value),'reply missing '+value);
      assert.match(visibleAnswer,/待确认|确认后|未生成|尚未生成|未保存|尚未保存|未写入|没有生成|还没有|仅为预览|确认前/);
      console.log(format,'verified:',candidate.id);
    }
    assert.deepEqual(ops.list('document_proposal').map(p=>p.id).sort(),ids.toSorted());
    await select(b.id);
    assert.deepEqual(proposalIds(await api('/snapshot')),[]);
    assert.ok(!(await api('/operations')).some(row=>row.proposal));
    for (const id of ids) {
      const expectedProject = await current();
      await assert.rejects(api('/document-proposal',{id,expectedProject}),/document_proposal_not_found|unknown_document_proposal|document_proposal_project_mismatch/);
    }
    report.isolated = true; save();
    await stop();
    await start();
    assert.equal((await current()).projectId,b.id);
    assert.deepEqual(proposalIds(await api('/snapshot')),[]);
    assert.ok(!(await api('/operations')).some(row=>row.proposal));
    await select(a.id);
    assert.deepEqual(proposalIds(await api('/snapshot')),ids.toSorted());
    for (const [index,id] of ids.entries()) {
      checkProposal(await api('/document-proposal',{id,expectedProject:await current()}),bases[index],report.steps[index].id);
      assert.deepEqual(ops.get(id).spec,expectedSpec);
    }
    report.afterRestart = documentManifest(ops,a);
    assert.deepEqual(report.afterRestart,before);
    if(decisions){
      const decisionTurn=async text=>{
        const result=await ask(text),id=result.id;
        report.decisions.push({text,answer:result.text,routing:result.routing});save();
        assert.equal(result.status,'completed',result.error);
        return (await api('/operations')).filter(r=>r.requestId===id&&r.operation==='document_proposal_decide');
      };
      const panel=async(id,action,actionId=randomUUID())=>api('/document-proposal-action',{id,action,actionId,expectedProject:await current()});
      const view=async id=>api('/document-proposal',{id,expectedProject:await current()});
      report.decisions=[];
      assert.deepEqual(await decisionTurn('这两份修改我想先留着，都先别应用，也别放弃。'),[]);
      assert.equal((await view(ids[0])).status,'pending');assert.equal((await view(ids[1])).status,'pending');
      const [confirmed]=await decisionTurn('确认应用 PDF 物资清单的修改，Word 那份先留着。');
      assert.equal(confirmed?.phase,'committed');assert.equal(confirmed.proposal.id,ids[1]);
      const pdfV2=confirmed.artifact.path;
      assert.equal(pdfV2,join(a.workspace,title+'.v2.pdf'));assert.equal((await panel(ids[1],'confirm')).artifact.id,confirmed.artifact.id);
      const pdfText=execFileSync('/usr/bin/swift',['-e','import Foundation; import PDFKit; print(PDFDocument(url:URL(fileURLWithPath:CommandLine.arguments[1]))!.string!)',pdfV2],{encoding:'utf8'});
      assert.match(pdfText,/75\s+用于检查中文显示与跨页表格完整性/);assert.match(pdfText,/1845/);
      assert.equal(fileIdentity(bases[1].path).sha256,bases[1].sha256);

      const originalWord=bases[0].path;
      execFileSync('python3',['-I','-c',`
from pathlib import Path
import io, sys, zipfile
p=Path(sys.argv[1])
with zipfile.ZipFile(io.BytesIO(p.read_bytes())) as src, zipfile.ZipFile(p,'w') as dst:
    for item in src.infolist():
        data=src.read(item)
        if item.filename=='word/document.xml':
            body=data.decode().replace('测试物资01','测试物资01（人工复核）',1)
            head,marker,tail=body.partition('测试物资60')
            assert marker and '>60</w:t>' in tail and '>1830</w:t>' in tail
            data=(head+marker+tail.replace('>60</w:t>','>68</w:t>',1).replace('>1830</w:t>','>1838</w:t>',1)).encode()
        dst.writestr(item,data)`,originalWord]);
      const manual=fileIdentity(originalWord),firstClick=randomUUID();
      const conflict=await panel(ids[0],'confirm',firstClick);
      assert.equal(conflict.phase,'conflict',JSON.stringify(conflict));assert.equal((await view(ids[0])).status,'conflict');
      const next=conflict.replacementProposal;
      assert.ok(next?.id,JSON.stringify(conflict));assert.notEqual(next.id,ids[0]);assert.equal(next.status,'pending');
      assert.equal(next.baseSha256,manual.sha256);assert.equal(next.supersedesId,ids[0]);
      assert.deepEqual(next.changes.map(c=>[c.before,c.after]),[['68','75'],['1838','1845']]);
      assert.equal((await panel(ids[0],'confirm',firstClick)).replacementProposal.id,next.id);
      assert.deepEqual(fileIdentity(originalWord),manual);assert.equal(existsSync(join(a.workspace,title+'.v2.docx')),false);
      await stop();await start();
      assert.equal((await view(next.id)).status,'pending');assert.equal((await view(ids[0])).status,'conflict');
      const [applied]=await decisionTurn('就按重新核对后的 Word 对照改吧。');
      assert.equal(applied?.phase,'committed');assert.equal(applied.proposal.id,next.id);
      const wordV2=applied.artifact.path;
      const extracted=JSON.parse(execFileSync('python3',['-I','-c',`
from zipfile import ZipFile
from xml.etree import ElementTree as E
import sys,json
w={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
with ZipFile(sys.argv[1]) as f: root=E.fromstring(f.read('word/document.xml'))
rows=[[''.join(t.text or '' for t in cell.findall('.//w:t',w)) for cell in row.findall('w:tc',w)] for row in root.findall('.//w:tbl/w:tr',w)]
print(json.dumps(rows))`,wordV2],{encoding:'utf8'}));
      assert.equal(extracted[1][1],'测试物资01（人工复核）');assert.equal(extracted[60][2],'75');assert.equal(extracted[61][2],'1845');
      assert.deepEqual(fileIdentity(originalWord),manual);
      const another=await generator.generate({action:'revise',path:pdfV2,patch:{title:'另拟标题'}},{id:'tc02-discard-choice'});
      assert.equal(another.phase,'proposed');
      const [dropped]=await decisionTurn('刚才 PDF 的标题修改方案不用了，放弃吧。');
      assert.equal(dropped?.phase,'discarded');assert.equal(dropped.proposal.id,another.proposal.id);
      assert.equal((await panel(another.proposal.id,'discard')).phase,'discarded');
      const after=documentManifest(ops,a);
      assert.deepEqual(after.versions.map(v=>v.revision).sort(),[1,1,2,2]);
      report.decisionEvidence={pdfV2:confirmed.artifact.sha256,manualSha256:manual.sha256,originalWordProposal:ids[0],replacementProposal:next.id,after,recheckedChanges:next.changes,discarded:another.proposal.id};
      if(mode==='undo'){
        await stop();await start();
        const [pdfUndo]=await decisionTurn('请撤销刚才已经应用到 PDF 物资清单的那次修改，恢复修改前的内容。');
        assert.equal(pdfUndo?.phase,'undone',JSON.stringify(pdfUndo));
        const pdfV3=pdfUndo.artifact;
        assert.equal(pdfV3.revision,3);
        assert.equal(pdfV3.parentArtifactId,confirmed.artifact.id);
        assert.equal(pdfV3.sha256,bases[1].sha256);
        assert.deepEqual(readFileSync(pdfV3.path),readFileSync(bases[1].path));
        assert.equal(fileIdentity(pdfV2).sha256,confirmed.artifact.sha256);

        // The reviewed Word baseline contains the user's saved note and count of 68.
        const wordUndo=await panel(next.id,'undo');
        assert.equal(wordUndo.phase,'undone',JSON.stringify(wordUndo));
        const wordV3=wordUndo.artifact;
        assert.equal(wordV3.revision,3);
        assert.equal(wordV3.parentArtifactId,applied.artifact.id);
        assert.equal(wordV3.sha256,manual.sha256);
        assert.deepEqual(readFileSync(wordV3.path),readFileSync(originalWord));
        assert.equal(fileIdentity(wordV2).sha256,applied.artifact.sha256);
        const restoredWordTable=JSON.parse(readFileSync(ops.get(wordV3.id).editableSpecSnapshotPath)).blocks[1];
        assert.equal(restoredWordTable.rows[0][1],'测试物资01（人工复核）');
        assert.equal(restoredWordTable.rows[59][2],'68');
        assert.equal(restoredWordTable.summary[2],'1838');

        await stop();await start();
        for(const [id,restored] of [[ids[1],pdfV3],[next.id,wordV3]]){
          assert.equal((await view(id)).status,'undone');
          assert.equal((await panel(id,'undo')).artifact.id,restored.id);
        }
        const restored=documentManifest(ops,a);
        assert.deepEqual(restored.versions.map(v=>v.revision).sort(),[1,1,2,2,3,3]);
        const followup=await ask('继续修改 '+basename(pdfV3.path)+'，将第60行数量从60改到61，合计由1830改成1831。让我先看修改对照。');
        const operations=(await api('/operations')).filter(row=>row.requestId===followup.id);
        const previews=operations.filter(row=>row.phase==='proposed');
        assert.equal(previews.length,1,JSON.stringify(operations.map(r=>[r.action,r.phase,r.error])));
        const followupProposal=previews[0].proposal;
        assert.equal(followupProposal.baseArtifactId,pdfV3.id);
        assert.deepEqual(followupProposal.changes.map(c=>[c.before,c.after]),[['60','61'],['1830','1831']]);
        assert.deepEqual(documentManifest(ops,a),restored);
        const v4=(await panel(followupProposal.id,'confirm')).artifact;
        assert.equal(v4.parentArtifactId,pdfV3.id);
        assert.equal(v4.revision,4);
        // A valid PDF with a newly saved trailing comment is no longer the approved edition.
        writeFileSync(v4.path,'\n% TC02 manual edit after v4 approval\n',{flag:'a'});
        const manualV4=fileIdentity(v4.path);
        const blocked=await panel(followupProposal.id,'undo');
        assert.equal(blocked.status,'failed',JSON.stringify(blocked));
        assert.equal(blocked.error,'document_revision_source_changed');
        assert.deepEqual(fileIdentity(v4.path),manualV4);
        assert.equal(existsSync(join(a.workspace,title+'.v5.pdf')),false);
        report.undoEvidence={pdf:{restored:pdfV3.id,sha256:pdfV3.sha256,equalsOriginal:true},word:{restored:wordV3.id,sha256:wordV3.sha256,equalsManual:true},
          afterRestart:restored,followup:{requestId:followup.id,proposal:followupProposal,published:v4.id},
          blockedAfterManualEdit:{error:blocked.error,manualSha256:manualV4.sha256}};
      }
    }
    if (originalPdf) assert.deepEqual(fileIdentity(resolve(originalPdf)),original);
    report.passed = true;
    console.log('Verified A4 document '+mode+'.');
  } catch(error) {
    report.error = String(error.stack || error);
    throw error;
  } finally {
    await stop(); ops?.close(); rmSync(home,{recursive:true,force:true}); save();
  }
}

const args=process.argv.slice(2);
const mode=['--decisions','--undo'].includes(args[0])?args.shift().slice(2):'preview';
await run(args[0],args[1],mode);
