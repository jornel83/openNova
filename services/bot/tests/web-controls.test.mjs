import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Operations} from '../operations.mjs';
import {Requests} from '../requests.mjs';
import {createControls} from '../controls.mjs';

function fixture(t) {
  const home=mkdtempSync(join(tmpdir(),'nova-web-control-')),workspace=join(home,'project');
  const ops=new Operations({home,workspace});
  // Only model inference is replaced. Admission, persistence and file writes are real.
  const requests=new Requests(ops,async record=>({text:'收到：'+record.input}));
  const handle=createControls({ops,requests,memory:{approve:()=>{throw Error('not_a_file');}},health:()=>({botId:'shared-bot',sessionId:'current-part',ready:true})});
  t.after(async()=>{await requests.close();ops.close();rmSync(home,{recursive:true,force:true});});
  return {ops,requests,handle,workspace};
}

test('browser history merges voice and web requests and survives reloading the snapshot',async t=>{
  const {requests,handle}=fixture(t);
  await handle('/ask',{id:'voice-one',text:'先复盘十五分钟',source:'voice'});await requests.active.work;
  await handle('/ask',{id:'web-two',text:'然后测试十五分钟',source:'web'});await requests.active.work;
  const snapshot=await handle('/snapshot',{});
  assert.equal(snapshot.health.botId,'shared-bot');
  assert.deepEqual(snapshot.messages.map(m=>[m.id,m.source,m.text]),[
    ['voice-one','voice','收到：先复盘十五分钟'],['web-two','web','收到：然后测试十五分钟']]);
  assert.deepEqual((await handle('/snapshot',{})).messages,snapshot.messages);
});

test('confirmation preview is the original proposal and only approval writes the file once',async t=>{
  const {ops,handle,workspace}=fixture(t),path=join(workspace,'brief.md');
  writeFileSync(path,'原内容\n');const p=ops.proposeFile('brief.md','原内容\n网页测试通过\n');
  const preview=(await handle('/snapshot',{})).approvals[0];
  assert.equal(preview.beforeContent,'原内容\n');assert.equal(preview.content,'原内容\n网页测试通过\n');
  assert.equal(readFileSync(path,'utf8'),'原内容\n');
  assert.equal((await handle('/approve',{id:p.id})).status,'applied');
  await handle('/approve',{id:p.id});
  assert.equal(readFileSync(path,'utf8'),'原内容\n网页测试通过\n');
  assert.equal((await handle('/snapshot',{})).approvals[0].status,'applied');
});

test('a rejected or conflicting modification is never silently applied',async t=>{
  const {ops,handle,workspace}=fixture(t),path=join(workspace,'brief.md');
  writeFileSync(path,'original');const p=ops.proposeFile('brief.md','rejected');
  await handle('/reject',{id:p.id});await assert.rejects(()=>handle('/approve',{id:p.id}),/approval_not_pending/);
  const next=ops.proposeFile('brief.md','stale');writeFileSync(path,'external edit');
  await assert.rejects(()=>handle('/approve',{id:next.id}),/file_conflict/);
  assert.equal(readFileSync(path,'utf8'),'external edit');
});

test('web and voice share foreground admission and confirmations wait until it is idle',async t=>{
  const {ops,requests,handle}=fixture(t);let release;
  requests.run=async()=>{await new Promise(r=>release=r);return {text:'完成'};};
  const p=ops.proposeFile('new.md','confirmed');
  await handle('/ask',{id:'voice-active',text:'运行中',source:'voice'});await new Promise(r=>setImmediate(r));
  await assert.rejects(()=>handle('/ask',{id:'web-collision',text:'另一个请求',source:'web'}),/bot_busy/);
  await assert.rejects(()=>handle('/approve',{id:p.id}),/bot_busy/);
  release();await requests.active.work;
  assert.equal((await handle('/approve',{id:p.id})).status,'applied');
});
test('snapshot exposes a separate work reference without changing user messages',async t=>{
 const {ops,requests}=fixture(t);const context={capture:()=>({kind:'file',file:{id:'f',name:'方案.md'}})};
 const handle=createControls({ops,requests,context,health:()=>({ready:true})});
 const snapshot=await handle('/snapshot',{});assert.equal(snapshot.workContext.file.name,'方案.md');assert.equal(snapshot.messages.length,0);
});
test('web document reopen only accepts a server registered file and serializes with model work',async t=>{
 const {ops,requests,workspace}=fixture(t);
 const {createDocumentOpener}=await import('../desktop/documents.mjs');const {createWorkContext}=await import('../desktop/context.mjs');
 const {EventEmitter}=await import('node:events');let launches=0;const context=createWorkContext();
 const documents=createDocumentOpener({workspace,ops,context,spawnOpen:()=>{launches++;const c=new EventEmitter();c.kill=()=>{};setImmediate(()=>c.emit('close',0,null));return c;}});
 writeFileSync(join(workspace,'demo.txt'),'内容');const initial=await documents.open({id:'initial',path:'demo.txt'});
 const handle=createControls({ops,requests,context,documents,health:()=>({ready:true})});
 await assert.rejects(handle('/document-open',{id:'bad',path:'/tmp/anything.txt'}),/invalid_document_request/);
 await assert.rejects(handle('/document-open',{id:'bad',fileId:'unknown'}),/unknown_id/);
 const receipt=await handle('/document-open',{id:'again',fileId:initial.file.id});assert.equal(receipt.status,'dispatched');await handle('/document-open',{id:'again',fileId:initial.file.id});assert.equal(launches,2);
 let release;requests.run=async()=>new Promise(r=>release=r);requests.submit('busy','hello');await new Promise(r=>setImmediate(r));
 await assert.rejects(handle('/document-open',{id:'busy-open',fileId:initial.file.id}),/bot_busy/);release({text:'done'});await requests.active.work;
 assert.equal((await handle('/snapshot',{})).workContext.file.name,'demo.txt');
});
test('context-clear removes selection only, resists old refresh, and accepts a new selection identity',async t=>{
 const {ops,requests}=fixture(t);const {createWorkContext}=await import('../desktop/context.mjs');
 const context=createWorkContext(),page={bindingId:'b',tabId:1,documentId:'d',revision:1};
 const selection={id:'s1',text:'讨论这段',documentId:'d',revision:1};context.updateBrowser({page,selection});
 const handle=createControls({ops,requests,context,health:()=>({ready:true})});
 await handle('/context-clear',{});assert.equal(context.capture().selection,null);
 context.updateBrowser({page,selection});assert.equal(context.capture().selection,null);
 context.updateBrowser({page,selection:{...selection,id:'s2'}});assert.equal(context.capture().selection.text,'讨论这段');
 context.selectFile({id:'f',name:'report.pdf'});await handle('/context-clear',{});assert.equal(context.capture().file.id,'f');
});
