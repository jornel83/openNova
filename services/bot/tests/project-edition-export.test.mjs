import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createWorkContext} from '../desktop/context.mjs';
import {createDocumentGenerator} from '../documents/generator.mjs';
import {Operations} from '../operations.mjs';
import {createProjectEditionTool,readProjectEdition,readProjectEditionArtifact} from '../projects/edition-export.mjs';
import {createHandoffTool} from '../projects/handoff.mjs';
import {ProjectStore} from '../projects/store.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

function setup(t){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'opennova-editions-'))),workspace=join(home,'project');
  const local={};
  function restart(){
    local.ops?.close();
    const ops=new Operations({home,workspace});
    const store=new ProjectStore({home,workspace,ops});
    const getRequest=()=>local.active;
    const context=createWorkContext({});
    const gen=createDocumentGenerator({home,ops,context,getRequest});
    Object.assign(local,{ops,workspace,store,context,
      edition:createProjectEditionTool({ops,generator:gen,getRequest})[3],
      handoff:createHandoffTool({ops,store,state:()=>store.state(),detail:id=>({project:store.get(id),records:[],references:[]})},getRequest)[3]});
  }
  local.turn=(id,input)=>{
    const state=local.store.state(),binding={...state,cwd:workspace,context:local.context.capture()};
    local.active={id,input,projectId:binding.projectId,binding};
    local.ops.put({kind:'request',...local.active});
  };
  restart();
  t.after(()=>{local.ops.close();rmSync(home,{recursive:true,force:true});});
  return Object.assign(local,{restart});
}

test('handoff source, rendered exports and downloads stay pinned after round two, restart and user edits',async t=>{
  const f=setup(t);
  f.turn('p1','为外部项目准备说明');
  const brief=f.handoff({action:'prepare',title:'空白行回归',brief:'请修复空白输入并保留可用行。',criteria:['保留正常行','过滤空白行']});
  const received='ok 1 - KEEP-INPUT-379';
  f.turn('p2',received);
  const first=f.handoff({action:'review',handoffId:brief.handoffId,round:1,quote:received,results:[{criterionId:'C1',status:'passed',evidence:received}]});
  f.turn('p3','返工，补上第二项');
  const next=f.handoff({action:'rework',handoffId:brief.handoffId,round:1,quote:'返工，补上第二项'});
  assert.equal(next.round,2);
  const sourceId=first.source.sourceId,projectId=f.active.projectId;
  f.restart();
  f.turn('p4','打开第一轮验收记录并导出');
  const edition=await f.edition({action:'read',sourceId},{callId:'read'});
  assert.equal(edition.round,1);assert.equal(edition.text,first.source.text);
  assert.deepEqual(edition.links.map(item=>item.sourceId),[brief.source.sourceId]);
  const word=await f.edition({action:'export',sourceId,format:'docx'},{callId:'word'});
  assert.equal(word.status,'completed',word.error);
  const doc=execFileSync('unzip',['-p',word.artifact.path,'word/document.xml'],{encoding:'utf8'});
  assert.ok(doc.includes(received)&&doc.includes(sourceId)&&doc.includes(brief.source.sourceId));
  assert.ok(!doc.includes(next.source.sourceId));
  if(process.platform==='darwin'){
    const pdf=await f.edition({action:'export',sourceId,format:'pdf'},{callId:'pdf'});
    assert.equal(pdf.status,'completed',pdf.error);
    const content=execFileSync('/usr/bin/swift',['-e','import Foundation; import PDFKit; let d=PDFDocument(url:URL(fileURLWithPath:CommandLine.arguments.last!))!; print(d.string!)',pdf.artifact.path],{encoding:'utf8'});
    assert.ok(content.replace(/\s/gu,'').includes(received.replace(/\s/gu,'')));
    assert.ok(content.replace(/\s/gu,'').includes(sourceId));
    assert.ok(!content.replace(/\s/gu,'').includes(next.source.sourceId));
  }
  assert.equal(f.ops.list('tool').filter(r=>r.operation==='project_edition'&&r.sourceIds.includes(sourceId)&&r.status==='completed').length,process.platform==='darwin'?3:2);
  const published=f.ops.list('tool').find(row=>row.operation==='project_edition'&&row.artifactId===word.artifact.id);
  // The lower-level publication may succeed a moment before its user-facing receipt.
  f.ops.put({...published,status:'interrupted',artifactId:undefined});
  f.restart();
  assert.equal(f.ops.get(published.id).artifactId,word.artifact.id);assert.equal(f.ops.get(published.id).recovered,true);
  f.turn('p5','再给我第一轮那一份 Word');
  const same=await f.edition({action:'export',sourceId,format:'docx'},{callId:'again'});
  assert.equal(same.artifact.id,word.artifact.id);
  const original=readFileSync(word.artifact.path),id=word.artifact.id;
  writeFileSync(word.artifact.path,'个人新内容');
  const replay=await f.edition({action:'export',sourceId,format:'docx'},{callId:'again'});
  assert.equal(replay.status,'completed');assert.equal(replay.artifact.diskStatus,'changed');
  assert.equal(readProjectEdition(f.ops,projectId,sourceId).exports.find(e=>e.id===id).diskStatus,'changed');
  const downloaded=readProjectEditionArtifact(f.ops,projectId,sourceId,id);
  assert.equal(digest(downloaded.bytes),word.artifact.sha256);assert.deepEqual(downloaded.bytes,original);
  assert.throws(()=>readProjectEditionArtifact(f.ops,projectId,next.source.sourceId,id),/project_edition_artifact_not_found/);
  assert.throws(()=>readProjectEditionArtifact(f.ops,'other-project',sourceId,id),/source_not_found/);
  const collision=await f.edition({action:'export',sourceId,format:'docx'},{callId:'no-overwrite'});
  assert.equal(collision.status,'failed');assert.equal(collision.error,'document_target_exists');
  assert.equal(readFileSync(word.artifact.path,'utf8'),'个人新内容');
  const copy=await f.edition({action:'export',sourceId,format:'docx',outputPath:'第一轮副本.docx'},{callId:'new-path'});
  assert.equal(copy.status,'completed');assert.deepEqual(readProjectEdition(f.ops,projectId,sourceId).links,edition.links);
  const row=f.ops.get(id);writeFileSync(row.snapshotPath,'篡改的快照');
  assert.throws(()=>readProjectEditionArtifact(f.ops,projectId,sourceId,id),/snapshot_changed/);
  await assert.rejects(f.edition({action:'read',sourceId,format:'pdf'},{callId:'invalid'}),/invalid_project_edition/);
  f.active={...f.active,projectId:'other',binding:{...f.active.binding,projectId:'other'}};
  await assert.rejects(f.edition({action:'export',sourceId,format:'pdf'},{callId:'wrong-project'}),/source_not_found/);
});
