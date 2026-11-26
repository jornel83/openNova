import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,statSync,realpathSync,readFileSync,rmSync,chmodSync,utimesSync,symlinkSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Operations} from '../operations.mjs';
import {prepareDocumentRevision,assertRevisionBaseUnchanged} from '../documents/revisions.mjs';

const hash=data=>createHash('sha256').update(data).digest('hex');
function fixture(t,format='pdf'){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-revision-core-'))),cwd=join(home,'workspace'),projectId='alpha';
  const ops=new Operations({home,workspace:cwd});
  t.after(()=>{ops.close();rmSync(home,{recursive:true,force:true});});
  const put=(name,key,data,extra={})=>{
    const path=join(cwd,name),dir=join(home,'document-generations',hash(key)),id='document-artifact-'+hash(key).slice(0,40);
    const source=JSON.stringify({schemaVersion:1,title:'有版本的笔记',blocks:[{type:'paragraph',text:key}]});
    mkdirSync(dir,{recursive:true});
    writeFileSync(path,data);
    writeFileSync(join(dir,'spec.json'),source);
    const {ino,size,ctimeMs,mtimeMs}=statSync(path);
    return ops.put({id,path,projectId,kind:'document_artifact',format,size,version:{ino,size,ctimeMs,mtimeMs},sha256:hash(data),
      specSnapshotPath:join(dir,'spec.json'),specSha256:hash(source),...extra});
  };
  const base=put('简报.'+format,'one','user-visible first edition');
  const prepare=selector=>prepareDocumentRevision({home,ops,projectId,cwd,...selector});
  return {home,cwd,ops,base,prepare,put};
}

test('historical recipe and new editable recipe are selected by identity/hash; prefix numbering follows original path',t=>{
  const f=fixture(t,'docx'),v1=f.prepare({path:'简报.docx'});
  assert.equal(v1.spec.blocks[0].text,'one');assert.equal(v1.targetPath,join(f.cwd,'简报.v2.docx'));
  assert.deepEqual(v1.lineage,{revision:2,parentArtifactId:f.base.id,parentSha256:f.base.sha256,rootArtifactId:f.base.id});
  const v2=f.put('简报.v2.docx','two','second',v1.lineage),editable=JSON.stringify({...v1.spec,title:'Editable input—not the layout recipe'});
  const editPath=join(f.home,'document-generations',hash('two'),'editable-spec.json');writeFileSync(editPath,editable);
  f.ops.put({...v2,editableSpecSnapshotPath:editPath,editableSpecSha256:hash(editable)});
  const third=f.prepare({artifactId:v2.id});
  assert.equal(third.spec.title,JSON.parse(editable).title);assert.equal(third.targetPath,join(f.cwd,'简报.v3.docx'));
  assert.equal(third.lineage.parentArtifactId,v2.id);assert.equal(third.lineage.rootArtifactId,f.base.id);
  assert.equal(readFileSync(f.base.path,'utf8'),'user-visible first edition');
  assert.throws(()=>f.prepare({artifactId:f.base.id}),e=>e.message==='document_revision_not_latest'&&e.details.latestPath===v2.path);
  assert.throws(()=>assertRevisionBaseUnchanged({ops:f.ops,base:v1.base}),/document_revision_not_latest/);
});

test('an edit between inspection and publication is a conflict; deletion, inode replacement and symlinks are never followed',t=>{
  const f=fixture(t),original=readFileSync(f.base.path);
  const check=()=>assertRevisionBaseUnchanged({ops:f.ops,base:f.base});
  assert.doesNotThrow(check);writeFileSync(f.base.path,'manual changes');assert.throws(check,/document_revision_source_changed/);
  assert.equal(readFileSync(f.base.path,'utf8'),'manual changes');
  renameSync(f.base.path,f.base.path+'.bak');assert.throws(check,/document_revision_source_missing/);
  writeFileSync(f.base.path,original);assert.throws(check,/document_revision_source_changed/);
  rmSync(f.base.path);symlinkSync(f.base.path+'.bak',f.base.path);assert.throws(check,/document_revision_source_changed/);
  assert.equal(readFileSync(f.base.path+'.bak','utf8'),'manual changes');
});

test('ownership comes from saved project artifact, not extension, matching bytes or a presented id from another project',t=>{
  const f=fixture(t);
  writeFileSync(join(f.cwd,'foreign.pdf'),readFileSync(f.base.path));
  for(const selector of [{path:'foreign.pdf'},{artifactId:f.base.id,projectId:'beta'},{path:f.base.path,projectId:'beta'},{artifactId:'unknown'}]){
    assert.throws(()=>f.prepare(selector),/document_revision_artifact_not_found/);
  }
  for(const selector of [{},{path:f.base.path,artifactId:f.base.id},{path:'https://example.org/test.pdf'}]){
    assert.throws(()=>f.prepare(selector),/invalid_document_revision_source/);
  }
  f.ops.put({...f.base,id:'another-record'});
  assert.throws(()=>f.prepare({path:f.base.path}),/document_revision_ambiguous_source/);
});

test('a missing or tampered private recipe fails closed; a live source JSON or other artifact recipe cannot substitute',t=>{
  const f=fixture(t),path=f.base.specSnapshotPath,original=readFileSync(path);
  const check=()=>f.prepare({artifactId:f.base.id});
  const fake=join(f.cwd,'my-edit.json');writeFileSync(fake,original);
  writeFileSync(path,'{}');assert.throws(check,/document_revision_spec_unavailable/);
  rmSync(path);assert.throws(check,/document_revision_spec_unavailable/);
  symlinkSync(fake,path);assert.throws(check,/document_revision_spec_unavailable/);
  const other=f.put('另一份.pdf','another','second');
  f.ops.put({...f.base,specSha256:other.specSha256,specSnapshotPath:other.specSnapshotPath});assert.throws(check,/document_revision_spec_unavailable/);
});

test('metadata-only ctime changes retain the saved edition, while changed bytes with restored identity/time do not',async t=>{
  const f=fixture(t),path=f.base.path,when=new Date('2020-01-02T12:00:00Z');
  utimesSync(path,when,when);
  const {ino,size,mtimeMs,ctimeMs}=statSync(path),base={...f.base,version:{ino,size,mtimeMs,ctimeMs}};
  f.ops.put(base);await new Promise(resolve=>setTimeout(resolve,20));chmodSync(path,0o600);
  assert.notEqual(statSync(path).ctimeMs,base.version.ctimeMs);
  assert.equal(f.prepare({artifactId:base.id}).base.sha256,hash(readFileSync(path)));
  const changed=Buffer.alloc(size,35);writeFileSync(path,changed);utimesSync(path,when,when);
  assert.equal(statSync(path).mtimeMs,mtimeMs);assert.equal(statSync(path).ino,ino);assert.equal(statSync(path).size,size);
  assert.throws(()=>f.prepare({artifactId:base.id}),/document_revision_source_changed/);
});
