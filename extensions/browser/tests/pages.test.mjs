import test from 'node:test';import assert from 'node:assert/strict';
import {createPageAdapter} from '../pages.mjs';
function fixture(){let store={},url='https://example.com/one',doc='d1',tabId=1,bindingId='b';const published=[];
 const chrome={storage:{session:{get:async()=>structuredClone(store),set:async v=>Object.assign(store,structuredClone(v))}},tabs:{get:async()=>({id:tabId,url,title:'Page',status:'complete'})},webNavigation:{getFrame:async()=>({documentId:doc})},scripting:{executeScript:async p=>p.files?[]:[{result:{text:'hello',truncated:false,targets:[],contentType:'text/html'}}]}};
 const pages=createPageAdapter({chrome,windows:{binding:async()=>({bindingId,workTabId:tabId,chatUrl:'http://127.0.0.1:18562/'})},publish:(c,a)=>published.push({c,a})});
 return {pages,published,chrome,setURL:v=>url=v,setDoc:v=>doc=v,setTab:(id)=>{tabId=id;bindingId='b'+id;}};}
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
