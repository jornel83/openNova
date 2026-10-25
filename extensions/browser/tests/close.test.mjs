import test from 'node:test';
import assert from 'node:assert/strict';
import {createWindowManager} from '../windows.mjs';
import {createPageAdapter} from '../pages.mjs';
import {createCommandRunner} from '../connection.mjs';

// Only the Chrome boundary is simulated; window binding, references, command
// deduplication and page publication all use the production implementations.
async function fixture(){
 let i=0,store={};const tabs=new Map(),wins=new Map(),published=[];
 const chrome={
  storage:{session:{get:async()=>structuredClone(store),set:async v=>Object.assign(store,structuredClone(v))}},
  system:{display:{getInfo:async()=>[{isPrimary:true,workArea:{left:0,top:20,width:1440,height:880}}]}},
  windows:{
   create:async props=>{const w={id:++i,...props};wins.set(w.id,w);const t={id:++i,windowId:w.id,url:props.url,title:props.url,active:true};tabs.set(t.id,t);return {...w,tabs:[t]};},
   get:async id=>{if(!wins.has(id))throw Error('no window');return {...wins.get(id),tabs:[...tabs.values()].filter(t=>t.windowId===id)};},
   update:async(id,props)=>Object.assign(wins.get(id),props),
   remove:async id=>{if(!wins.delete(id))throw Error('no window');for(const t of tabs.values())if(t.windowId===id)tabs.delete(t.id);},
  },
  tabs:{
   get:async id=>{if(!tabs.has(id))throw Error('no tab');return {...tabs.get(id)};},
   query:async q=>[...tabs.values()].filter(t=>t.windowId===q.windowId),
   update:async(id,props)=>{const t=tabs.get(id);if(!t)throw Error('no tab');Object.assign(t,props);queueMicrotask(()=>void pages.navigation({tabId:id,frameId:0,loading:false}));return {...t};},
   remove:async id=>{const t=tabs.get(id);if(!t)throw Error('no tab');tabs.delete(id);const rest=[...tabs.values()].filter(x=>x.windowId===t.windowId);if(!rest.length)wins.delete(t.windowId);else rest[0].active=true;},
  },
  webNavigation:{getFrame:async({tabId})=>{if(!tabs.has(tabId))throw Error('no tab');return {documentId:'doc-'+tabId};}},
  scripting:{executeScript:async p=>p.files?[]:[{result:'complete'}]},
 };
 const windows=createWindowManager(chrome),base='http://127.0.0.1:18562';
 const pages=createPageAdapter({chrome,windows,publish:(context,activate)=>published.push({context,activate})});
 const pair=await windows.ensureWindows({chatUrl:base+'/'});
 Object.assign(tabs.get(pair.workTabId),{url:'https://www.xueqiu.com/S/SZ000988',title:'华工科技'});
 const page=(await pages.refresh({activate:true})).page;
 const execute=(scope='tab',ref=page,cancel=()=>false)=>pages.execute({id:crypto.randomUUID(),method:'close',page:ref,args:{scope},deadlineAt:Date.now()+10000},base,cancel);
 return {chrome,windows,pages,pair,page,tabs,wins,published,execute,base};
}
test('close last work tab clears reference, preserves chat, then open rebuilds work window',async()=>{
 const f=await fixture();const r=await f.execute();
 assert.equal(r.status,'completed');assert.equal(r.scope,'tab');assert.equal(f.tabs.has(f.page.tabId),false);
 assert.equal(f.wins.has(f.pair.chatWindowId),true);assert.equal(f.published.at(-1).context.page,null);
 const opened=await f.pages.execute({method:'open',args:{url:'https://example.com/'}},f.base);
 assert.equal(opened.status,'completed');assert.notEqual(opened.page.tabId,f.page.tabId);
 assert.equal((await f.windows.binding()).chatWindowId,f.pair.chatWindowId);assert.equal(f.wins.size,2);
});
test('closing one work tab retains remaining tab and reuses same work window',async()=>{
 const f=await fixture();f.tabs.set(99,{id:99,windowId:f.pair.workWindowId,url:'https://example.com/other',title:'Other',active:false});
 const r=await f.execute();assert.equal(r.page.tabId,99);assert.equal(f.tabs.size,2);
 assert.equal((await f.windows.binding()).workWindowId,f.pair.workWindowId);
 await f.windows.ensureWindows({chatUrl:f.base+'/'});assert.equal(f.wins.size,2);
 await assert.rejects(f.execute('tab'),/context_changed/);assert.equal(f.tabs.has(99),true);
});
test('close window removes its tabs but preserves Nova chat and unrelated windows',async()=>{
 const f=await fixture();f.tabs.set(99,{id:99,windowId:f.pair.workWindowId,url:'https://example.com/other'});
 const unrelated=await f.chrome.windows.create({url:'https://example.com/personal'});
 const r=await f.execute('window');assert.equal(r.status,'completed');assert.equal(f.wins.has(f.pair.workWindowId),false);
 assert.equal(f.wins.has(f.pair.chatWindowId),true);assert.equal(f.wins.has(unrelated.id),true);
 assert.equal(f.published.at(-1).context.page,null);assert.equal((await f.windows.binding()).workTabId,undefined);
});
test('changed pages, invalid scopes and cancelled close never remove a tab',async()=>{
 const f=await fixture();await assert.rejects(f.execute('all'),/invalid_close_scope/);
 await assert.rejects(f.execute('tab',f.page,()=>true),/command_cancelled/);
 f.tabs.get(f.page.tabId).url='https://example.com/changed';
 await assert.rejects(f.execute(),/context_changed/);assert.equal(f.tabs.has(f.page.tabId),true);
});
test('close works on unreadable pages without requiring website content permission',async()=>{
 const f=await fixture();f.chrome.scripting.executeScript=async()=>{throw Error('permission denied');};
 const page=(await f.pages.refresh()).page;assert.equal(page.readable,false);
 assert.equal((await f.execute('tab',page)).status,'completed');assert.equal(f.tabs.has(page.tabId),false);
});
test('manual tab and window removal repair bindings without leaving orphan work windows',async()=>{
 const f=await fixture();f.tabs.set(99,{id:99,windowId:f.pair.workWindowId,url:'https://example.com/other',active:false});
 await f.chrome.tabs.remove(f.page.tabId);await f.windows.removed({tabId:f.page.tabId});
 assert.equal((await f.windows.binding()).workTabId,99);
 await f.chrome.windows.remove(f.pair.workWindowId);await f.windows.removed({windowId:f.pair.workWindowId});
 assert.equal((await f.windows.binding()).workTabId,undefined);
 const p=await f.windows.ensureWindows({chatUrl:f.base+'/'});assert.equal(p.chatWindowId,f.pair.chatWindowId);assert.equal(f.wins.size,2);
});
test('open recovers from manually closed work window even before removal event arrives',async()=>{
 const f=await fixture();await f.chrome.windows.remove(f.pair.workWindowId);
 const r=await f.pages.execute({method:'open',args:{url:'https://example.com/'}},f.base);
 assert.equal(r.status,'completed');assert.notEqual(r.page.tabId,f.page.tabId);assert.equal(f.wins.size,2);
});
test('Nova chat cannot be closed even after tab movement or when sharing a work window',async()=>{
 const f=await fixture();f.tabs.get(f.page.tabId).windowId=f.pair.chatWindowId;
 await assert.rejects(f.execute('tab'),/chat_page_cannot_be_work_page|context_changed/);assert.equal(f.tabs.has(f.page.tabId),true);
 f.tabs.get(f.page.tabId).windowId=f.pair.workWindowId;
 f.tabs.set(99,{id:99,windowId:f.pair.workWindowId,url:f.base+'/'});
 await assert.rejects(f.execute('window'),/chat_page_cannot_be_work_page/);assert.equal(f.wins.has(f.pair.workWindowId),true);
});
test('close commands cross the extension protocol and duplicates cannot close the next tab',async()=>{
 const f=await fixture();let journal={};
 const run=createCommandRunner({storage:{get:async()=>journal,set:async v=>{journal=v;}},execute:c=>f.pages.execute(c,f.base)});
 const command={id:'close-one',method:'close',page:f.page,args:{scope:'tab'},deadlineAt:Date.now()+10000};
 const a=await run(command);assert.equal(a.status,'completed');
 await f.windows.ensureWindows({chatUrl:f.base+'/'});const tab=(await f.windows.binding()).workTabId;
 assert.deepEqual(await run(command),a);assert.equal(f.tabs.has(tab),true);
});
