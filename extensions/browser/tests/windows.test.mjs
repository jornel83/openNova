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
