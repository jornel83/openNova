import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,realpathSync,rmSync,symlinkSync,truncateSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Operations} from '../operations.mjs';
import {createWorkContext} from '../desktop/context.mjs';
import {inspectFileReference} from '../desktop/documents.mjs';
import {createFileReader,createFileReadTool} from '../desktop/file-reader.mjs';
import {MAX_RANGED_PDF_SOURCE_BYTES} from '../desktop/file-types.mjs';
import {taskDocumentDefinitions} from '../tasks/document-tool-contract.mjs';

const pdf=marker=>Buffer.from('%PDF-1.7\n'+marker+'\n%%EOF\n');
function fixture(t,options={}){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-file-read-'))),workspace=join(home,'project'),ops=new Operations({home,workspace});
  const context=createWorkContext({inspectFile:inspectFileReference}),controller=new AbortController(),calls=[];
  const state={active:{id:'request-a',projectId:'project-a',signal:controller.signal,binding:{focus:'work',projectId:'project-a',cwd:workspace,context:context.capture(),projectContext:{references:[]}}}};
  const readNative=options.readNative??(async input=>{calls.push(input);return {status:'read',content:'根据文件：'+input.bytes.toString(),limitation:null};});
  const reader=createFileReader({home,ops,context,getRequest:()=>state.active,readNative,...options});
  const save=(name,bytes=pdf('marker'))=>{const path=join(workspace,name);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,bytes);return path;};
  const bindCurrent=path=>{const s=statSync(path);context.selectFile({id:'current-file',path,name:path.split('/').at(-1),size:s.size,mtimeMs:s.mtimeMs});state.active.binding={...state.active.binding,context:context.capture()};};
  t.after(()=>{ops.close();rmSync(home,{recursive:true,force:true});});
  return {home,workspace,ops,context,controller,calls,state,reader,save,bindCurrent,readNative};
}

test('foreground open-document request reads the saved desktop selection even when the model asks for the Nova-associated file',async t=>{
  const f=fixture(t),previous=f.save('history.pdf',pdf('old inventory')),paper=f.save('desk.pdf',pdf('AMP1'));
  f.bindCurrent(previous);
  f.state.active.inputText='帮我读一下当前我正打开的pdf文档里的第1页到第3页，帮我看下AMP1性能指标有什么突破';
  const s=statSync(paper);
  f.state.active.entryOpenDocument=Promise.resolve({status:'available',app:'WPS Office',file:{path:paper,size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs,ino:s.ino}});
  for(const selector of [{current:true},{currentOpen:true},{path:previous},{path:'history.pdf'}]){
    const record=await f.reader.read({...selector,question:'核对 AMP1'});
    assert.equal(record.status,'completed');assert.equal(record.source.path,paper);
    assert.equal(record.source.entry,'desktop_open');assert.equal(record.source.app,'WPS Office');
    assert.equal(f.calls.at(-1).filename,'desk.pdf');
  }
  // Explicitly comparing both documents must preserve the two different selectors.
  f.state.active.inputText='比较我正在打开的文档和 Nova 上次关联的文档';
  const other=await f.reader.read({current:true,question:'核对物资'});
  assert.equal(other.source.path,previous);assert.equal(other.source.entry,'current');
  f.state.active.inputText='帮我读一下我正在打开的文档，文件名 history.pdf';
  assert.equal((await f.reader.read({path:previous,question:'总结'})).source.entry,'path');
  assert.equal(f.calls.length,6);
});

test('an unavailable desktop reference requests clarification and never scans or reads the previous file',async t=>{
  const f=fixture(t);f.bindCurrent(f.save('history.pdf'));
  f.state.active.inputText='帮我分析一下 WPS 里打开的这份文件';
  for(const status of ['unavailable','permission_required','ambiguous','unsupported']){
    f.state.active.entryOpenDocument=Promise.resolve({status});
    const record=await f.reader.read({current:true,question:'总结'});
    assert.equal(record.status,'needs_clarification');assert.equal(record.error,'desktop_document_'+status);assert.ok(!record.source);
  }
  assert.equal(f.calls.length,0);assert.equal(f.context.capture().file.name,'history.pdf');
  f.state.active.inputText='不要读 WPS 里打开的这份文件，请读 Nova 上次关联的文件';
  assert.equal((await f.reader.read({current:true,question:'总结'})).source.entry,'current');
});

test('desktop clarification journals the exact known cause without recording arbitrary helper metadata',async t=>{
  const f=fixture(t);
  for(const [reason,expected,message] of [
    ['browser_not_showing_nova','browser_not_showing_nova',/确认前台窗口是 Nova/],
    ['no_witnessed_document','no_witnessed_document',/从文档窗口切回 Nova/],
    ['desktop_observer_timeout','desktop_observer_timeout',/超时/],
    ['unexpected_private_window_title','desktop_document_unavailable',/没有识别到/],
    ['__proto__','desktop_document_unavailable',/没有识别到/]
  ]){
    f.state.active.entryOpenDocument={status:'unavailable',reason,path:'/private/unrelated.pdf',app:'unrelated-window'};
    const record=await f.reader.read({currentOpen:true,question:'读前三页'});
    assert.equal(record.error,'desktop_document_unavailable');assert.equal(record.observationReason,expected);
    assert.match(record.output,message);
    const stored=f.ops.get(record.id);
    assert.equal(stored.observationReason,expected);
    assert.doesNotMatch(JSON.stringify(stored),/unexpected_private_window_title|__proto__|unrelated/);
  }
  assert.equal(f.calls.length,0);
});

test('desktop document checks the send-time file version and exposes the selector only to the foreground',async t=>{
  const f=fixture(t),path=f.save('desk.pdf'),s=statSync(path);
  f.state.active.entryOpenDocument={status:'available',file:{path,size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs,ino:s.ino}};
  writeFileSync(path,pdf('edited after sending'));
  assert.equal((await f.reader.read({currentOpen:true,question:'读'})).error,'file_changed_read_again');
  for(const other of [{current:true},{path},{path:''}]){
    assert.equal((await f.reader.read({currentOpen:true,...other,question:'读'})).error,'invalid_file_read');
  }
  f.state.active.entryOpenDocument={status:'available',file:{path}};
  assert.equal((await f.reader.read({currentOpen:true,question:'读'})).error,'desktop_document_unavailable');
  assert.equal(f.calls.length,0);
  assert.ok(createFileReadTool({})[2].currentOpen);
  assert.equal(taskDocumentDefinitions().find(([name])=>name==='document_read')[2].currentOpen,undefined);
});

test('unique filename reads actual bounded bytes, persists a private immutable snapshot and source, and selects current file without project association',async t=>{
  const f=fixture(t),path=f.save('资料/方案.pdf',pdf('nonce-unique-92'));
  const r=await f.reader.read({path:'方案.pdf',question:'材料的标记是什么？'},{id:'read-one'});
  assert.equal(r.status,'completed');assert.equal(r.source.path,path);assert.equal(r.source.projectId,'project-a');assert.equal(r.source.requestId,'request-a');
  assert.equal(r.source.sha256,createHash('sha256').update(pdf('nonce-unique-92')).digest('hex'));
  assert.deepEqual(readFileSync(r.source.snapshotPath),pdf('nonce-unique-92'));assert.equal(statSync(r.source.snapshotPath).mode&0o777,0o600);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].filename,'方案.pdf');assert.equal(f.calls[0].mime,'application/pdf');
  assert.equal(f.context.capture().file.path,path);assert.equal(f.context.capture().file.contentAccess,'native_file');assert.equal(f.context.capture().file.readStatus,'read');
  assert.deepEqual(f.ops.get('read-one'),r);assert.ok(f.ops.get(r.file.id));assert.equal(f.ops.list('project_reference').length,0);
  const persisted=JSON.stringify(f.ops.list('tool'));assert.ok(!persisted.includes(pdf('nonce-unique-92').toString('base64')));assert.ok(!persisted.includes('"bytes"'));
  writeFileSync(path,pdf('new-version'));
  const duplicate=await f.reader.read({path:'方案.pdf',question:'材料的标记是什么？'},{id:'read-one'});
  assert.deepEqual(duplicate,r);assert.equal(f.calls.length,1);assert.deepEqual(readFileSync(r.source.snapshotPath),pdf('nonce-unique-92'));
  await assert.rejects(f.reader.read({path:'方案.pdf',question:'different'},{id:'read-one'}),/command_id_conflict/);
});

test('duplicate basenames across the project and bound references require clarification before any native call',async t=>{
  const f=fixture(t),a=f.save('a/report.pdf'),b=f.save('b/report.pdf');
  const r=await f.reader.read({path:'report.pdf',question:'总结'},{id:'ambiguous'});
  assert.equal(r.status,'needs_clarification');assert.deepEqual(r.candidates.map(x=>x.path),[a,b]);assert.equal(f.calls.length,0);
  rmSync(b);const outside=join(f.home,'outside','report.pdf');mkdirSync(join(outside,'..'));writeFileSync(outside,pdf('outside'));
  f.state.active.binding={...f.state.active.binding,projectContext:{references:[{kind:'file',status:'active',path:outside}]}};
  const second=await f.reader.read({path:'report.pdf',question:'总结'},{id:'ambiguous-reference'});
  assert.equal(second.status,'needs_clarification');assert.equal(second.candidates.length,2);assert.equal(f.calls.length,0);
});

test('filename search stays within the project and bound references; explicit paths retain existing access',async t=>{
  const f=fixture(t),outside=join(f.home,'outside.pdf');writeFileSync(outside,pdf('outside'));
  symlinkSync(outside,join(f.workspace,'outside.pdf'));
  assert.equal((await f.reader.read({path:'outside.pdf',question:'总结'},{id:'implicit'})).error,'file_not_found');assert.equal(f.calls.length,0);
  const explicit=await f.reader.read({path:outside,question:'总结'},{id:'absolute'});
  assert.equal(explicit.status,'completed');assert.equal(explicit.source.path,outside);assert.equal(f.calls.length,1);
  f.state.active.binding={...f.state.active.binding,projectContext:{references:[{kind:'file',status:'active',path:outside}]}};
  assert.equal((await f.reader.read({path:'outside.pdf',question:'总结'},{id:'reference'})).status,'completed');assert.equal(f.calls.length,2);
});

test('current-file binding is frozen, missing/changed references fail, and explicit reread selects the saved version',async t=>{
  const f=fixture(t);
  assert.equal((await f.reader.read({current:true,question:'总结'},{id:'no-current'})).error,'current_file_required');
  const old=f.save('old.pdf',pdf('original')),other=f.save('other.pdf',pdf('other'));
  f.bindCurrent(old);f.context.selectFile({id:'manually-selected',path:other,name:'other.pdf'});
  const first=await f.reader.read({current:true,question:'标记'},{id:'frozen'});
  assert.equal(first.source.path,old);assert.equal(first.contextSelected,false);assert.equal(f.context.capture().file.path,other);
  writeFileSync(old,pdf('changed and longer'));
  const changed=await f.reader.read({current:true,question:'总结'},{id:'changed'});
  assert.equal(changed.error,'file_changed_read_again');assert.equal(f.calls.length,1);
  const fresh=await f.reader.read({path:old,question:'重新读取最新版本'},{id:'fresh'});
  assert.equal(fresh.status,'completed');assert.match(fresh.content,/changed and longer/);
  rmSync(old);assert.equal((await f.reader.read({current:true,question:'总结'},{id:'missing'})).error,'file_not_found');
});

test('a changed linked-reference version cannot silently refresh by filename',async t=>{
  const f=fixture(t),path=f.save('reference.pdf');
  f.state.active.binding={...f.state.active.binding,projectContext:{references:[{kind:'file',status:'active',path,version:{size:statSync(path).size,mtimeMs:statSync(path).mtimeMs}}]}};
  writeFileSync(path,pdf('changed-longer'));
  assert.equal((await f.reader.read({path:'reference.pdf',question:'总结'},{id:'stale-reference'})).error,'file_changed_read_again');
  assert.equal(f.calls.length,0);assert.equal((await f.reader.read({path:'./reference.pdf',question:'重新读取'},{id:'fresh-reference'})).status,'completed');
});

test('full frozen references include external files omitted from the recent prompt list',async t=>{
  const f=fixture(t),path=join(f.home,'older-linked.pdf');writeFileSync(path,pdf('older-linked-content'));
  f.state.active.fileReferences=[{kind:'file',status:'active',path,version:{size:statSync(path).size,mtimeMs:statSync(path).mtimeMs}}];
  assert.deepEqual(f.state.active.binding.projectContext.references,[]);
  const r=await f.reader.read({path:'older-linked.pdf',question:'总结'},{id:'older-reference'});
  assert.equal(r.status,'completed');assert.equal(r.source.path,path);assert.match(r.content,/older-linked-content/);
});

test('snapshot detects a source replaced between initial stat and async file read',async t=>{
  const f=fixture(t),path=f.save('race.pdf');
  const pending=f.reader.read({path,question:'总结'},{id:'race'});
  queueMicrotask(()=>writeFileSync(path,pdf('mutated-source-with-new-length')));
  const r=await pending;assert.equal(r.status,'failed');assert.equal(r.error,'file_changed_during_read');assert.equal(f.calls.length,0);
});

test('native work uses the saved snapshot if disk changes later and reports that change without claiming the new bytes were read',async t=>{
  let path;const f=fixture(t,{readNative:async input=>{writeFileSync(path,pdf('newer-disk-file'));return {status:'read',content:input.bytes.toString(),limitation:null};}});
  path=f.save('stable.pdf',pdf('captured-source'));
  const r=await f.reader.read({path,question:'总结'},{id:'native-race'});
  assert.equal(r.status,'completed');assert.equal(r.diskStatus,'changed');assert.match(r.content,/captured-source/);assert.doesNotMatch(r.content,/newer-disk/);
  assert.deepEqual(readFileSync(r.source.snapshotPath),pdf('captured-source'));
});

test('cancelled native responses and changed requests cannot publish success or overwrite current context',async t=>{
  for(const mode of ['cancel','project']){
    let release,started;const entered=new Promise(resolve=>started=resolve);
    const f=fixture(t,{readNative:()=>{started();return new Promise(resolve=>release=resolve);}}),path=f.save('late.pdf');
    const pending=f.reader.read({path,question:'总结'},{id:'late-'+mode});await entered;
    f.context.selectFile({id:'new-selection',path:'/tmp/new.pdf'});
    if(mode==='cancel')f.controller.abort();else f.state.active={...f.state.active,projectId:'project-b',binding:{...f.state.active.binding,projectId:'project-b'}};
    release({status:'read',content:'late native body',limitation:null});
    const r=await pending;assert.equal(r.status,mode==='cancel'?'cancelled':'failed');assert.equal(r.error,mode==='cancel'?'cancelled':'project_request_mismatch');
    assert.equal(f.context.capture().file.id,'new-selection');assert.equal(f.ops.list('file').length,0);assert.ok(!Object.hasOwn(r,'content'));
  }
});

test('partial and unreadable results remain truthful and preserve external context selections',async t=>{
  let f;f=fixture(t,{readNative:async()=>{f.context.selectFile({id:'user-selection',path:'/tmp/user.pdf'});return {status:'partial',content:'能确认第一页',limitation:'第二页不可读'};}});
  const path=f.save('partial.pdf'),r=await f.reader.read({path,question:'总结'},{id:'partial'});
  assert.equal(r.status,'completed');assert.equal(r.readStatus,'partial');assert.equal(r.limitation,'第二页不可读');assert.equal(r.contextSelected,false);assert.equal(f.context.capture().file.id,'user-selection');
  const unread=fixture(t,{readNative:async()=>({status:'unreadable',content:'无法读取',limitation:'文档被加密'})});
  const failed=await unread.reader.read({path:unread.save('encrypted.pdf'),question:'总结'},{id:'unreadable'});
  assert.equal(failed.status,'failed');assert.equal(failed.error,'native_file_unreadable');assert.equal(unread.context.capture().kind,'none');
});

test('reselecting a newer saved version of the same path is not overwritten by an older reading result',async t=>{
  let release,started;const entered=new Promise(resolve=>started=resolve);
  const f=fixture(t,{readNative:()=>{started();return new Promise(resolve=>release=resolve);}}),path=f.save('same-path.pdf');f.bindCurrent(path);
  const pending=f.reader.read({current:true,question:'总结'},{id:'same-path-reselect'});await entered;
  writeFileSync(path,pdf('newly-saved-version-with-different-size'));
  f.context.selectFile({...f.state.active.binding.context.file,size:statSync(path).size,mtimeMs:statSync(path).mtimeMs});
  const newer=f.context.capture();release({status:'read',content:'old snapshot',limitation:null});
  const r=await pending;assert.equal(r.status,'completed');assert.equal(r.contextSelected,false);assert.deepEqual(f.context.capture(),newer);
});

test('oversized native result metadata is rejected without publishing a source as read',async t=>{
  const f=fixture(t,{readNative:async()=>({status:'read',content:'summary',limitation:'x'.repeat(24001)})});
  const r=await f.reader.read({path:f.save('metadata.pdf'),question:'总结'},{id:'oversized-result'});
  assert.equal(r.status,'failed');assert.equal(r.error,'invalid_file_read_result');assert.equal(f.context.capture().kind,'none');
});

test('types, size, incomplete searches and unsafe inputs fail before reading through the model',async t=>{
  const f=fixture(t,{maxBytes:128,maxEntries:2});
  for(const [name,data,error] of [['oversize.pdf',Buffer.alloc(129),'file_too_large'],['empty.pdf',Buffer.alloc(0),'file_empty'],['fake.png',pdf('fake'),'file_format_mismatch'],['file.txt',Buffer.from('text'),'unsupported_file_type']]){
    assert.equal((await f.reader.read({path:f.save(name,data),question:'总结'},{id:name})).error,error);
  }
  for(const path of ['https://example.com/file.pdf','file:///tmp/a.pdf','//server/share/file.pdf'])assert.equal((await f.reader.read({path,question:'总结'},{id:path})).error,'file_not_local');
  assert.equal((await f.reader.read({path:'missing.pdf',question:'总结'},{id:'search'})).error,'file_search_incomplete');
  assert.equal((await f.reader.read({path:'x.pdf',current:true,question:'总结'},{id:'both'})).error,'invalid_file_read');
  assert.equal(f.calls.length,0);
});

test('bounded page selection rejects oversized original PDFs and oversized prepared attachments before model submission',async t=>{
  let slices=0;
  const f=fixture(t,{maxBytes:128,preparePages:async({range})=>{
    slices++;return {bytes:Buffer.alloc(129),pageCount:1,...range};
  }}),path=f.save('range.pdf');
  const args={path,question:'Read the first page',startPage:1,endPage:1};
  assert.equal((await f.reader.read(args,{id:'slice-too-large'})).error,'pdf_pages_output_too_large');
  assert.equal(slices,1);truncateSync(path,MAX_RANGED_PDF_SOURCE_BYTES+1);
  assert.equal((await f.reader.read(args,{id:'original-too-large'})).error,'file_too_large');
  assert.equal(slices,1);assert.equal(f.calls.length,0);
});

test('concurrent call IDs deduplicate; restart marks unfinished records interrupted and never re-reads them',async t=>{
  let release,started;const entered=new Promise(resolve=>started=resolve);
  const f=fixture(t,{readNative:()=>{started();return new Promise(resolve=>release=resolve);}}),path=f.save('same.pdf');
  const tool=createFileReadTool({reader:f.reader,getRequest:()=>f.state.active}),exec={callId:'same-call',signal:f.controller.signal};
  const a=tool[3]({path,question:'总结'},exec),b=tool[3]({path,question:'总结'},exec);await entered;
  release({status:'read',content:'one completed result',limitation:null});assert.deepEqual(await a,await b);assert.equal(f.ops.list('tool').length,1);
  const input={path,question:'总结'},fingerprint=JSON.stringify({input,requestId:f.state.active.id,projectId:f.state.active.projectId,cwd:f.workspace});
  f.ops.put({id:'interrupted',kind:'tool',operation:'document_read',status:'running',fingerprint});
  const reader=createFileReader({...f,getRequest:()=>f.state.active,readNative:()=>{throw Error('must not repeat');}});
  assert.equal((await reader.read(input,{id:'interrupted'})).status,'interrupted');
});

function pdfReadFixture(context,{pageCount=6,model,onPrepare}={}){
  const requests=[],preparations=[],original=pdf('original-full-document');
  const slice=range=>pdf('original-pages-'+range.startPage+'-'+range.endPage);
  const fixtureState=fixture(context,{
    preparePages:async({bytes,range,signal})=>{
      preparations.push(range??null);assert.deepEqual(bytes,original);
      if(onPrepare)await onPrepare({range,signal});
      if(range&&range.endPage>pageCount)throw Object.assign(Error('pdf_page_range_out_of_bounds'),{pageCount});
      return {bytes:range?slice(range):bytes,pageCount,startPage:range?.startPage??1,endPage:range?.endPage??pageCount};
    },
    readNative:async input=>{
      requests.push(input);
      if(model)return model(input,requests.length);
      return {status:'read',content:'verified from attached pages',limitation:null};
    },
  });
  return {...fixtureState,original,slice,requests,preparations,path:fixtureState.save('六页样本.pdf',original)};
}

test('explicit current-file range sends only selected bytes while source, history and current file keep the original identity',async context=>{
  const state=pdfReadFixture(context),selected={startPage:3,endPage:5},input={current:true,question:'解释这段',...selected};
  state.bindCurrent(state.path);
  const result=await state.reader.read(input,{id:'current-pages-3-5'});
  assert.equal(result.status,'completed');assert.equal(result.readStatus,'read');
  assert.deepEqual(state.preparations,[selected]);assert.equal(state.requests.length,1);
  assert.deepEqual(state.requests[0].bytes,state.slice(selected));
  assert.match(state.requests[0].question,/原第 3 页/);
  assert.deepEqual(result.readScope,{mode:'pdf_pages',...selected,pageCount:6});
  assert.equal(result.source.sha256,createHash('sha256').update(state.original).digest('hex'));
  assert.deepEqual(readFileSync(result.source.snapshotPath),state.original);
  assert.equal(state.context.capture().file.path,state.path);assert.deepEqual(state.ops.get(result.id).readScope,result.readScope);
  const replay=await state.reader.read(input,{id:result.id});assert.deepEqual(replay,result);assert.equal(state.requests.length,1);
  await assert.rejects(state.reader.read({...input,endPage:4},{id:result.id}),/command_id_conflict/);
});

test('a full PDF timeout recovers once from the frozen source and leaves only unread pages for an explicit continuation',async context=>{
  const state=pdfReadFixture(context,{model:async(input,count)=>{
    if(count===1)throw Error('agent_timeout');
    return {status:'read',content:'facts from supplied pages',limitation:null};
  }});
  const first=await state.reader.read({path:state.path,question:'解释整篇'},{id:'full-then-prefix'});
  const prefix={startPage:1,endPage:3},remaining={startPage:4,endPage:6};
  assert.equal(first.status,'completed');assert.equal(first.readStatus,'partial');
  assert.deepEqual(first.readScope,{mode:'pdf_pages',...prefix,pageCount:6});assert.deepEqual(first.recovery.remainingRange,remaining);
  assert.deepEqual(state.requests.map(input=>input.bytes),[state.original,state.slice(prefix)]);
  assert.deepEqual(readFileSync(state.path),state.original);
  const follow=await state.reader.read({path:state.path,question:'只继续未处理的页',...first.recovery.remainingRange},{id:'explicit-unread-pages'});
  assert.equal(follow.readStatus,'read');assert.deepEqual(state.requests.map(input=>input.bytes),[state.original,state.slice(prefix),state.slice(remaining)]);
  assert.equal(follow.source.sha256,first.source.sha256);assert.deepEqual(follow.readScope,{mode:'pdf_pages',...remaining,pageCount:6});
});

test('failed recovery cannot recursively retry, publish successful content or change the selected file',async context=>{
  const state=pdfReadFixture(context,{model:async()=>{throw Error('agent_timeout');}}),range={startPage:2,endPage:4};
  const before=state.context.capture();
  const result=await state.reader.read({path:state.path,question:'解释指定页',...range},{id:'two-timeouts'});
  assert.equal(result.status,'failed');assert.equal(result.error,'agent_timeout');
  assert.deepEqual(state.requests.map(input=>input.bytes),[state.slice(range),state.slice({startPage:2,endPage:3})]);
  assert.deepEqual(state.context.capture(),before);assert.equal(state.ops.list('file').length,0);assert.ok(!Object.hasOwn(result,'content'));
  assert.deepEqual(readFileSync(state.path),state.original);
});

test('single-page, client initialization and non-timeout failures never re-upload a whole or identical attachment',async context=>{
  for(const [error,stage,scope] of [['agent_timeout','model',{startPage:5,endPage:5}],['agent_timeout','client',{}],['network_error','model',{}]]){
    const state=pdfReadFixture(context,{model:async input=>{input.onTiming({stage});throw Error(error);}});
    const result=await state.reader.read({path:state.path,question:'解释',...scope},{id:'no-repeat-'+stage+error});
    assert.equal(result.status,'failed');assert.equal(result.error,error);
    assert.equal(state.requests.length,1);assert.deepEqual(state.preparations,scope.startPage?[scope]:[]);
    assert.equal(result.timings[0].stage,stage);
  }
});

test('out-of-bounds PDF range and a page range on an image fail without sending attachment bytes',async context=>{
  const state=pdfReadFixture(context),range={startPage:6,endPage:7};
  const out=await state.reader.read({path:state.path,question:'解释',...range},{id:'outside-pdf'});
  assert.equal(out.status,'failed');assert.equal(out.error,'pdf_page_range_out_of_bounds');assert.equal(out.pageCount,6);
  const image=Buffer.alloc(24);image.set([137,80,78,71,13,10,26,10]);image.write('IHDR',12);image.writeUInt32BE(1,16);image.writeUInt32BE(1,20);
  const wrong=await state.reader.read({path:state.save('example.png',image),question:'解释',startPage:1,endPage:1},{id:'not-a-pdf'});
  assert.equal(wrong.status,'failed');assert.equal(wrong.error,'pdf_range_requires_pdf');
  assert.deepEqual(state.preparations,[range]);assert.equal(state.requests.length,0);assert.equal(state.context.capture().kind,'none');
});

test('cancelling while a recovery slice is prepared discards late bytes without another model call',async context=>{
  const started=Promise.withResolvers(),release=Promise.withResolvers();
  const state=pdfReadFixture(context,{model:async()=>{throw Error('agent_timeout');},
    onPrepare:async({range})=>{if(range){started.resolve();await release.promise;}}});
  const pending=state.reader.read({path:state.path,question:'解释整篇'},{id:'cancel-recovery-slice'});
  await started.promise;state.controller.abort();release.resolve();const result=await pending;
  assert.equal(result.status,'cancelled');assert.equal(result.error,'cancelled');assert.equal(state.requests.length,1);
  assert.equal(state.context.capture().kind,'none');assert.equal(state.ops.list('file').length,0);assert.deepEqual(readFileSync(state.path),state.original);
});
