import test from 'node:test';import assert from 'node:assert/strict';
import {createWindowManager,layout} from '../windows.mjs';
function fake(){let i=0,store={};const windows=new Map(),tabs=new Map();return {storage:{session:{get:async()=>structuredClone(store),set:async v=>Object.assign(store,structuredClone(v))}},system:{display:{getInfo:async()=>[{isPrimary:true,workArea:{left:0,top:20,width:1440,height:880}}]}},windows:{
 create:async props=>{const w={id:++i,...props};const t={id:++i,windowId:w.id,url:props.url};w.tabs=[t];windows.set(w.id,w);tabs.set(t.id,t);return structuredClone(w);},
 get:async id=>{if(!windows.has(id))throw Error('no window');return structuredClone(windows.get(id));},
 update:async()=>{throw Error('should not rearrange existing windows');},
 },tabs:{get:async id=>{if(!tabs.has(id))throw Error('no tab');return {...tabs.get(id)};}},windowsMap:windows,tabsMap:tabs};}
test('repeated ensure reuses windows, aligns heights; chat or unrelated focus never binds it',async()=>{
 const chrome=fake(),m=createWindowManager(chrome),args={chatUrl:'http://127.0.0.1:18562/'};
 const a=await m.ensureWindows(args),b=await m.ensureWindows(args);assert.deepEqual(a,b);assert.equal(chrome.windowsMap.size,2);
 assert.equal(chrome.windowsMap.get(a.workWindowId).height,chrome.windowsMap.get(a.chatWindowId).height);
 const chat=chrome.windowsMap.get(a.chatWindowId).tabs[0];await m.activated({tabId:chat.id,windowId:a.chatWindowId});assert.equal((await m.binding()).workTabId,a.workTabId);
 await assert.rejects(m.bind(chat),/chat_page/);
});
test('lost windows are recreated; persisted IDs are checked before reuse',async()=>{
 const chrome=fake(),m=createWindowManager(chrome),args={chatUrl:'http://127.0.0.1:18562/'};
 const a=await m.ensureWindows(args);chrome.tabsMap.delete(a.workTabId);
 const next=await createWindowManager(chrome).ensureWindows(args);assert.notEqual(next.workTabId,a.workTabId);assert.equal(next.chatWindowId,a.chatWindowId);
});
test('narrow display falls back to stacked windows within work area',()=>{
 const b=layout({left:0,top:20,width:800,height:800});assert.ok(b.chat.top>b.work.top);assert.equal(b.chat.width,800);assert.ok(b.chat.top+b.chat.height<=820);
});
test('only a matching clicked link can adopt its new tab; unrelated popups cannot take focus context',async()=>{
 const chrome=fake(),m=createWindowManager(chrome);await m.ensureWindows({chatUrl:'http://127.0.0.1:18562/'});const b=await m.binding();
 chrome.tabsMap.set(99,{id:99,windowId:b.workWindowId,url:'https://example.com/advert',openerTabId:b.workTabId});
 assert.equal(await m.activated({tabId:99,windowId:b.workWindowId}),false);assert.equal((await m.binding()).workTabId,b.workTabId);
 m.expectPopup({id:'click',page:{bindingId:b.bindingId,tabId:b.workTabId,documentId:'doc'},href:'https://example.com/article'});
 assert.equal(await m.createdTarget({sourceTabId:b.workTabId,sourceFrameId:0,tabId:99,url:'https://example.com/advert'}),false);
 chrome.tabsMap.set(100,{id:100,windowId:b.workWindowId,url:'https://example.com/article',openerTabId:b.workTabId});
 assert.equal(await m.createdTarget({sourceTabId:b.workTabId,sourceFrameId:0,tabId:100,url:'https://example.com/article'}),true);assert.equal((await m.binding()).workTabId,100);assert.equal(m.isCommandDestination('click',await m.binding()),true);assert.equal(m.isCommandDestination('other',await m.binding()),false);m.clearPopup('click');assert.equal(m.isCommandDestination('click',await m.binding()),false);
 assert.equal(await m.createdTarget({sourceTabId:b.workTabId,sourceFrameId:0,tabId:99,url:'https://example.com/article'}),false);
});
test('new windows accommodate actual Chrome bounds once; later user positions are preserved',async()=>{
 const chrome=fake(),create=chrome.windows.create;let updates=0;
 chrome.windows.create=async props=>{
  const w=await create({...props,width:props.type==='popup'?480:props.width,height:props.height-10});return w;
 };
 chrome.windows.update=async(id,props)=>{updates++;Object.assign(chrome.windowsMap.get(id),props);return structuredClone(chrome.windowsMap.get(id));};
 const m=createWindowManager(chrome),args={chatUrl:'http://127.0.0.1:18562/'};
 const b=await m.ensureWindows(args),work=chrome.windowsMap.get(b.workWindowId),chat=chrome.windowsMap.get(b.chatWindowId);
 assert.ok(work.left+work.width<=chat.left,'actual popup width must not overlap work window');
 assert.ok(chat.left+chat.width<=1440,'actual right edge must fit display');
 assert.equal(work.height,chat.height);assert.ok(updates>0);
 const count=updates;work.left=150;chat.top=90;
 await m.ensureWindows(args);assert.equal(updates,count);assert.equal(work.left,150);assert.equal(chat.top,90);
});
test('programmatic window creation cannot impersonate user focus or steal a file reference',async()=>{
 const chrome=fake(),m=createWindowManager(chrome),create=chrome.windows.create;
 let automatic;
 chrome.windows.create=async props=>{const w=await create(props);automatic=await m.focused(w.id);assert.equal(props.type==='normal'?props.focused:false,false);return w;};
 const b=await m.ensureWindows({chatUrl:'http://127.0.0.1:18562/'});assert.equal(automatic,false);
 assert.equal(await m.focused(b.workWindowId),true);
 assert.equal(await m.focused(b.chatWindowId),false);
});
