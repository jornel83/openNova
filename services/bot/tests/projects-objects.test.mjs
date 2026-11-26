import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,statSync,realpathSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {withObjectVersion} from '../projects/objects.mjs';
import {Operations} from '../operations.mjs';
import {createWorkContext} from '../desktop/context.mjs';
import {createFileReader} from '../desktop/file-reader.mjs';
test('changed referenced files must be reread; a later external edit invalidates that read too',async t=>{
  const root=mkdtempSync(join(tmpdir(),'nova-a1-object-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'same.txt');writeFileSync(path,'v1');const s=statSync(path);
  const active={binding:{cwd:root,context:{kind:'file',file:{path,size:s.size,mtimeMs:s.mtimeMs}}}},exec=name=>({name,arguments:{file_path:'same.txt'}});
  writeFileSync(path,'new version 2');let writes=0;
  await assert.rejects(withObjectVersion(active,exec('write'),()=>{writes++;}),/project_object_changed_read_again/);assert.equal(writes,0);
  await withObjectVersion(active,exec('read'),async()=>({isError:false}));
  await withObjectVersion(active,exec('edit'),async()=>{writes++;return {isError:false};});assert.equal(writes,1);
  writeFileSync(path,'externally changed version 3');
  await assert.rejects(withObjectVersion(active,exec('edit'),async()=>{writes++;}),/project_object_changed_read_again/);assert.equal(writes,1);
});
test('a file changing during the read is not accepted as a current version',async t=>{
  const root=mkdtempSync(join(tmpdir(),'nova-a1-object-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'file.txt');writeFileSync(path,'initial');
  const active={binding:{cwd:root}};
  await assert.rejects(withObjectVersion(active,{name:'read',arguments:{file_path:path}},async()=>{writeFileSync(path,'changed during read');return {isError:false};}),/project_object_changed_during_read/);
  assert.equal(active.objectReads.size,0);
});
for(const tool of ['write','edit'])test(`${tool} cannot overwrite a changed native snapshot first read by direct path without a bound reference`,async t=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-native-object-'))),root=join(home,'workspace'),ops=new Operations({home,workspace:root});
  t.after(()=>{ops.close();rmSync(home,{recursive:true,force:true});});
  const path=join(root,'source.pdf'),original='%PDF-1.7\noriginal snapshot\n%%EOF\n',newer='%PDF-1.7\nnewer external saved version\n%%EOF\n';
  writeFileSync(path,original);
  const context=createWorkContext(),active={id:'native-read',projectId:'project-a',signal:new AbortController().signal,
    binding:{focus:'work',projectId:'project-a',cwd:root,context:context.capture(),projectContext:{references:[]}}};
  const reader=createFileReader({home,ops,context,getRequest:()=>active,readNative:async({bytes})=>{
    assert.equal(bytes.toString(),original);writeFileSync(path,newer);return {status:'read',content:'Original snapshot read.',limitation:null};
  }});
  const result=await reader.read({path,question:'Read the saved file.'},{id:'native-read-result'});
  assert.equal(result.status,'completed');assert.equal(result.diskStatus,'changed');
  assert.equal(active.binding.context.kind,'none');assert.deepEqual(active.binding.projectContext.references,[]);
  assert.deepEqual(active.objectReads.get(path),result.source.version);
  let writes=0;
  await assert.rejects(withObjectVersion(active,{name:tool,arguments:{file_path:path}},async()=>{
    writes++;writeFileSync(path,'would overwrite the newer saved file');return {isError:false};
  }),/project_object_changed_read_again/);
  assert.equal(writes,0);assert.equal(readFileSync(path,'utf8'),newer);assert.equal(readFileSync(result.source.snapshotPath,'utf8'),original);
});
test('an unread and unreferenced new file can still be created',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'nova-new-object-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'notes.md'),active={binding:{cwd:root,context:{kind:'none'},projectContext:{references:[]}}};
  let writes=0;
  const result=await withObjectVersion(active,{name:'write',arguments:{file_path:'notes.md'}},async()=>{
    writes++;writeFileSync(path,'New notes.');return {isError:false};
  });
  assert.equal(result.isError,false);assert.equal(writes,1);assert.equal(readFileSync(path,'utf8'),'New notes.');
  assert.equal(active.objectReads.get(path).size,statSync(path).size);
});

test('rereading a journaled Word/PDF cannot authorize a text overwrite; guard survives restart and path aliases',async t=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-guard-edition-'))),root=join(home,'workspace');
  let ops=new Operations({home,workspace:root});
  t.after(()=>{ops.close();rmSync(home,{recursive:true,force:true});});
  const path=join(root,'report.pdf'),alias=join(root,'alias'),active={binding:{cwd:root,projectId:'B'}};
  writeFileSync(path,'manual edits since generation');symlinkSync(path,alias);
  ops.put({id:'saved-edition',kind:'document_artifact',projectId:'A',path,format:'pdf'});
  ops.close();ops=new Operations({home,workspace:root});
  const call=(name,file,next)=>withObjectVersion(active,{name,arguments:{file_path:file}},next,ops);
  await call('read',path,async()=>({isError:false}));
  const stop=()=>assert.fail('text mutation reached filesystem');
  for(const name of ['write','edit'])for(const file of ['report.pdf',alias])await assert.rejects(call(name,file,stop),/document_revision_tool_required/);
  assert.equal(readFileSync(path,'utf8'),'manual edits since generation');
  rmSync(path);await assert.rejects(call('write',path,stop),/document_revision_tool_required/);
  const independent=join(root,'scratch.md');await call('write',independent,async()=>writeFileSync(independent,'allowed'));
  assert.equal(readFileSync(independent,'utf8'),'allowed');
});
