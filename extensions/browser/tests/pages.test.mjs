import test from 'node:test';import assert from 'node:assert/strict';
import {createPageAdapter} from '../pages.mjs';
function fixture(){let store={},url='https://example.com/one',doc='d1',tabId=1,bindingId='b';const published=[];
 const chrome={storage:{session:{get:async()=>structuredClone(store),set:async v=>Object.assign(store,structuredClone(v))}},tabs:{get:async()=>({id:tabId,url,title:'Page',status:'complete'})},webNavigation:{getFrame:async()=>({documentId:doc})},scripting:{executeScript:async p=>p.files?[]:[{result:{text:'hello',truncated:false,targets:[],contentType:'text/html'}}]}};
 const windows={binding:async()=>({bindingId,workTabId:tabId,chatUrl:'http://127.0.0.1:18562/'})};
 const pages=createPageAdapter({chrome,windows,publish:(c,a)=>published.push({c,a})});
 return {pages,published,chrome,windows,setURL:v=>url=v,setDoc:v=>doc=v,setTab:(id)=>{tabId=id;bindingId='b'+id;}};}
test('real navigation and SPA routes invalidate old references and selections',async()=>{
 const f=fixture();await f.pages.refresh({activate:true});const old=f.published.at(-1).c.page;
 await f.pages.selection({text:'quote'}, {tab:{id:1},documentId:'d1',frameId:0});assert.equal(f.published.at(-1).c.selection.text,'quote');
 f.setURL('https://example.com/two');await f.pages.navigation({tabId:1,frameId:0});assert.equal(f.published.at(-1).c.page.revision,1);assert.equal(f.published.at(-1).c.selection,null);
 await assert.rejects(f.pages.execute({method:'read',page:old}),/stale_page/);
 f.setDoc('d2');await f.pages.navigation({tabId:1,frameId:0});assert.equal(f.published.at(-1).c.page.documentId,'d2');
 await f.pages.selection({text:'stale'}, {tab:{id:1},documentId:'d1',frameId:0});assert.equal(f.published.at(-1).c.selection,null);
});
test('unrelated tabs and frames are ignored; permission failure is explicit',async()=>{
 const f=fixture();await f.pages.refresh();const before=f.published.length;
 await f.pages.navigation({tabId:2,frameId:0});await f.pages.selection({text:'secret'},{tab:{id:1},documentId:'d1',frameId:2});assert.equal(f.published.length,before);
 f.chrome.scripting.executeScript=async()=>{throw Error('Cannot access contents');};await f.pages.refresh();assert.equal(f.published.at(-1).c.page.readable,false);
 await assert.rejects(f.pages.execute({method:'read'}),/permission_required/);
});
test('committed DOM can be read while slow subresources are still loading',async()=>{
 const f=fixture();f.chrome.tabs.get=async()=>({id:1,url:'https://example.com/one',title:'Article',status:'loading'});
 await f.pages.navigation({tabId:1,frameId:0,loading:false});assert.equal((await f.pages.execute({method:'read'})).status,'completed');
});
test('loading from the old binding cannot block a newly bound loaded tab',async()=>{
 const f=fixture();await f.pages.navigation({tabId:1,frameId:0,loading:true});f.setTab(2);f.setDoc('d2');
 await f.pages.refresh({activate:true});await f.pages.navigation({tabId:1,frameId:0,loading:false});
 assert.equal((await f.pages.execute({method:'read'})).status,'completed');
});
test('same-URL history navigation invalidates old selection and references',async()=>{
 const f=fixture();await f.pages.refresh();const old=f.published.at(-1).c.page;
 await f.pages.selection({text:'old content'},{tab:{id:1},frameId:0,documentId:'d1'});
 await f.pages.navigation({tabId:1,frameId:0,sameDocument:true});const next=f.published.at(-1).c;
 assert.equal(next.page.revision,1);assert.equal(next.selection,null);await assert.rejects(f.pages.execute({method:'read',page:old}),/stale_page/);
});
test('navigating a bound tab to Nova never reads chat content as work content',async()=>{
 const f=fixture();await f.pages.refresh();f.setURL('http://127.0.0.1:18562/#chat');
 await f.pages.navigation({tabId:1,frameId:0});assert.equal(f.published.at(-1).c.page.readable,false);
 await assert.rejects(f.pages.execute({method:'read'}),/chat_page/);
 await assert.rejects(f.pages.execute({method:'open',args:{url:'http://127.0.0.1:18562/'}},'http://127.0.0.1:18562'),/chat_page/);
});
test('failed navigation clears loading and exposes a specific failure until next navigation',async()=>{
 const f=fixture();await f.pages.navigation({tabId:1,frameId:0,loading:true});await f.pages.navigation({tabId:1,frameId:0,error:true});
 await assert.rejects(f.pages.execute({method:'read'}),/navigation_failed/);
 await f.pages.navigation({tabId:1,frameId:0,loading:false});assert.equal((await f.pages.execute({method:'read'})).status,'completed');
});
test('old page actions fail before injection and queued cancellation prevents side effects',async()=>{
 const f=fixture();await f.pages.refresh();const page=f.published.at(-1).c.page;let actions=0;
 f.chrome.scripting.executeScript=async p=>{if(p.func)actions++;return p.files?[]:[{result:{status:'completed',action:'click'}}];};
 f.setURL('https://example.com/two');
 await assert.rejects(f.pages.execute({id:'old',method:'click',page,args:{ref:'target-1'}}),/context_changed/);assert.equal(actions,0);
 const latest=f.published.at(-1).c.page;
 await assert.rejects(f.pages.execute({id:'cancelled',method:'fill',page:latest,args:{ref:'target-1',text:'hello'}},'',()=>true),/command_cancelled/);assert.equal(actions,0);
});
test('ordinary actions return actual receipt while replaced refs return stale_target',async()=>{
 const f=fixture();await f.pages.refresh();const page=f.published.at(-1).c.page;
 f.chrome.scripting.executeScript=async p=>p.files?[]:[{result:p.args[0].ref==='gone'?{error:'stale_target'}:{status:'completed',action:p.args[0].mode}}];
 const r=await f.pages.execute({method:'fill',page,args:{ref:'target-1',text:'华工科技'}});assert.equal(r.status,'completed');assert.equal(r.action,'fill');
 await assert.rejects(f.pages.execute({method:'click',page,args:{ref:'gone'}}),/stale_target/);
});
test('click receipt includes the actual destination reference for the next model tool call',async()=>{
 const f=fixture();await f.pages.refresh();const page=f.published.at(-1).c.page;
 f.chrome.scripting.executeScript=async p=>{
  if(p.files)return [];
  if(p.args[0].mode==='inspect')return [{result:{href:null}}];
  f.setURL('https://example.com/article');f.setDoc('article-doc');return [{result:{status:'completed',action:'click'}}];
 };
 const result=await f.pages.execute({id:'go',method:'click',page,args:{ref:'target-1'}});
 assert.equal(result.page.url,'https://example.com/article');assert.equal(result.page.documentId,'article-doc');
});
test('manual rebind while a click settles is never returned as the click destination',async()=>{
 const f=fixture();await f.pages.refresh();const page=f.published.at(-1).c.page;
 f.chrome.scripting.executeScript=async p=>p.files?[]:[{result:p.args[0].mode==='inspect'?{href:null}:{status:'completed',action:'click'}}];
 const pending=f.pages.execute({id:'manual-race',method:'click',page,args:{ref:'target-1'}});setTimeout(()=>{f.setTab(2);f.setDoc('d2');},20);
 const r=await pending;assert.equal(r.error,'context_changed');assert.equal(r.status,'failed');assert.equal(r.dispatched,true);assert.equal(r.page,undefined);
});
test('navigation in unrelated tabs and subframes does not cancel an otherwise valid action',async()=>{
 const f=fixture();await f.pages.refresh();const page=f.published.at(-1).c.page;let noisy=true,actions=0;
 f.chrome.scripting.executeScript=async p=>{
  if(p.files){if(noisy){noisy=false;void f.pages.navigation({tabId:99,frameId:0,loading:true});void f.pages.navigation({tabId:1,frameId:5,loading:true});}return [];}
  actions++;return [{result:{status:'completed',action:'fill'}}];
 };
 assert.equal((await f.pages.execute({id:'noise',method:'fill',page,args:{ref:'target-1',text:'search'}})).status,'completed');assert.equal(actions,1);
});
test('cancelled or rejected clicks cannot leave a popup expectation armed',async()=>{
 for(const fail of ['cancel','stale']){
  const f=fixture();await f.pages.refresh();const page=f.published.at(-1).c.page;let cancelled=false,armed=false,actions=0;
  f.windows.expectPopup=()=>{armed=true;};f.windows.clearPopup=()=>{armed=false;};
  f.chrome.scripting.executeScript=async p=>{
   if(p.files)return [];
   if(p.args[0].mode==='inspect'){cancelled=fail==='cancel';return [{result:{href:'https://example.com/popup'}}];}
   actions++;return [{result:{error:'stale_target'}}];
  };
  await assert.rejects(f.pages.execute({id:'rejected',method:'click',page,args:{ref:'target-1'}},'',()=>cancelled),fail==='cancel'?/command_cancelled/:/stale_target/);
  assert.equal(armed,false);assert.equal(actions,fail==='cancel'?0:1);
 }
});
test('reselecting the same text gets a fresh selection identity while passive refresh preserves it',async()=>{
 const f=fixture(),sender={tab:{id:1},frameId:0,documentId:'d1'};await f.pages.selection({text:'quote'},sender);
 const first=f.published.at(-1).c.selection.id;assert.equal(typeof first,'string');
 await f.pages.refresh();assert.equal(f.published.at(-1).c.selection.id,first);
 await f.pages.selection({text:'quote'},sender);assert.notEqual(f.published.at(-1).c.selection.id,first);
 const {pageContext}=await import('../../../services/bot/desktop/protocol.mjs');assert.equal(pageContext(f.published.at(-1).c).selection.id,f.published.at(-1).c.selection.id);
});
test('startup window ensure preserves file focus; explicit work-window action activates browser',async()=>{
 const f=fixture();f.windows.ensureWindows=async()=>({workWindowId:1,chatWindowId:2});
 await f.pages.execute({method:'windows.ensure',args:{}},'http://127.0.0.1:18562');
 assert.equal(f.published.at(-1).a,false);
 await f.pages.execute({method:'windows.ensure',args:{activate:true}},'http://127.0.0.1:18562');
 assert.equal(f.published.at(-1).a,true);
});
