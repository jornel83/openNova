import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runDocumentGenerator} from '../documents/runner.mjs';
import {normalizeDocumentSpec} from '../documents/spec.mjs';
import {rebaseDocumentCandidate} from '../documents/rebase.mjs';

const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
function inventory(){
  return normalizeDocumentSpec({schemaVersion:1,title:'物资清单',blocks:[{type:'paragraph',text:'本次盘点。'},
    {type:'table',columns:['编号','物资名称','数量'],rows:Array.from({length:60},(_,i)=>[String(i+1),'物资'+(i+1),String(i+1)]),summary:['合计','','1830']}]});
}
function propose(base){
  const proposed=structuredClone(base);
  proposed.blocks[1].rows[59][2]='75';
  proposed.blocks[1].summary[2]='1845';
  return proposed;
}
function fixture(t,format){
  const dir=mkdtempSync(join(tmpdir(),'nova-rebase-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return {async render(spec,name){
    const specPath=join(dir,name+'.json'),outputPath=join(dir,name+'.'+format);
    writeFileSync(specPath,JSON.stringify(spec));
    await runDocumentGenerator({format,specPath,outputPath,workdir:dir});return outputPath;
  }};
}
for(const format of ['docx','pdf']){
  test('real '+format+' rebase pins manual text and recalculates a verified inventory total',{skip:format==='pdf'&&process.platform!=='darwin',timeout:150000},async t=>{
    const f=fixture(t,format),base=inventory(),candidate=propose(base);
    const edited=structuredClone(base);
    edited.blocks[1].rows[0][2]='3';
    edited.blocks[1].rows[59][2]='61';
    edited.blocks[1].summary[2]='1833';
    const originalPath=await f.render(base,'source'),latestPath=await f.render(edited,'user-edit');
    const beforeHash=hash(latestPath);
    const result=await rebaseDocumentCandidate({baseSpec:base,candidateSpec:candidate,format,originalPath,latestPath});
    assert.deepEqual(result.baseSpec,edited);
    const expected=structuredClone(edited);expected.blocks[1].rows[59][2]='75';expected.blocks[1].summary[2]='1847';
    assert.deepEqual(result.spec,expected);
    assert.equal(hash(latestPath),beforeHash);
  });
}

test('a manually formatted Word document is retained when the renderer cannot reproduce its formatting',async t=>{
  const base=inventory(),f=fixture(t,'docx'),originalPath=await f.render(base,'source'),latestPath=originalPath+'.manual';
  execFileSync('python3',['-I','-c',`import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z, zipfile.ZipFile(sys.argv[2],"x") as out:
 for entry in z.infolist():
  data=z.read(entry)
  if entry.filename=="word/document.xml": data=data.replace(b"<w:r>",b"<w:r><w:rPr><w:i/></w:rPr>",1)
  out.writestr(entry,data)`,originalPath,latestPath]);
  const before=hash(latestPath);
  await assert.rejects(rebaseDocumentCandidate({baseSpec:base,candidateSpec:propose(base),format:'docx',originalPath,latestPath}),/document_rebase_unavailable/);
  assert.equal(hash(latestPath),before);
});

test('a user-sorted inventory keeps row order and applies the old quantity to the same identifier',async t=>{
  const base=inventory(),f=fixture(t,'docx'),latest=structuredClone(base);
  latest.blocks[1].rows.reverse();
  const originalPath=await f.render(base,'original'),latestPath=await f.render(latest,'sorted');
  const result=await rebaseDocumentCandidate({format:'docx',baseSpec:base,candidateSpec:propose(base),originalPath,latestPath});
  assert.deepEqual(result.spec.blocks[1].rows[0],['60','物资60','75']);
  assert.deepEqual(result.spec.blocks[1].rows.slice(1),latest.blocks[1].rows.slice(1));
});

test('Word preserves longer notes after an editor save with split runs, saved column widths and session metadata',async t=>{
  const base=inventory(),f=fixture(t,'docx'),originalPath=await f.render(base,'source'),latestPath=originalPath+'.manual';
  execFileSync('python3',['-I','-c',`import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z, zipfile.ZipFile(sys.argv[2],"x") as out:
 out.writestr("word/","")
 for entry in z.infolist():
  v=z.read(entry).decode()
  if entry.filename=="word/document.xml":
   v=v.replace(">物资1</w:t></w:r>",'>物资1</w:t></w:r><w:proofErr w:type=\"spellStart\"/><w:r><w:t>（人工复核）</w:t></w:r><w:proofErr w:type=\"spellEnd\"/>',1)
  if entry.filename=="docProps/core.xml": v=v.replace("</cp:coreProperties>","<cp:revision>2</cp:revision><cp:lastModifiedBy>editor</cp:lastModifiedBy></cp:coreProperties>")
  out.writestr(entry,v)`,originalPath,latestPath]);
  const result=await rebaseDocumentCandidate({format:'docx',baseSpec:base,candidateSpec:propose(base),originalPath,latestPath});
  assert.equal(result.baseSpec.blocks[1].rows[0][1],'物资1（人工复核）');
  assert.equal(result.spec.blocks[1].rows[0][1],'物资1（人工复核）');
});

test('an annotated PDF stays intact if an equivalent editable baseline cannot preserve its note',{skip:process.platform!=='darwin',timeout:90000},async t=>{
  const base=normalizeDocumentSpec({schemaVersion:1,title:'检查',blocks:[{type:'paragraph',text:'记录'}]});
  const f=fixture(t,'pdf'),originalPath=await f.render(base,'document'),latestPath=originalPath+'.annotated';
  execFileSync('/usr/bin/swift',['-e',`import PDFKit
let doc = PDFDocument(url:URL(fileURLWithPath:CommandLine.arguments[1]))!
let note = PDFAnnotation(bounds:CGRect(x:70,y:520,width:32,height:32),forType:.text,withProperties:nil)
note.contents="人工批注"; doc.page(at:0)!.addAnnotation(note)
precondition(doc.write(to:URL(fileURLWithPath:CommandLine.arguments[2])))`,originalPath,latestPath]);
  const before=hash(latestPath);
  await assert.rejects(rebaseDocumentCandidate({baseSpec:base,candidateSpec:{...base,title:'检查结果'},
    format:'pdf',originalPath,latestPath}),/document_rebase_unavailable/);
  assert.equal(hash(latestPath),before);
});
