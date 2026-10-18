import test from 'node:test';import assert from 'node:assert/strict';
import {createPageAdapter} from '../pages.mjs';
function fixture(){let store={},url='https://example.com/one',doc='d1',tabId=1;const published=[];
 const chrome={storage:{session:{get:async()=>structuredClone(store),set:async v=>Object.assign(store,structuredClone(v))}},tabs:{get:async()=>({id:tabId,url,title:'Page',status:'complete'})},webNavigation:{getFrame:async()=>({documentId:doc})},scripting:{executeScript:async p=>p.files?[]:[{result:{text:'hello',truncated:false,targets:[],contentType:'text/html'}}]}};
 const pages=createPageAdapter({chrome,windows:{binding:async()=>({bindingId:'b',workTabId:tabId})},publish:(c,a)=>published.push({c,a})});
 return {pages,published,chrome,setURL:v=>url=v,setDoc:v=>doc=v};}
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
