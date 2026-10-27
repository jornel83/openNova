import test from 'node:test';import assert from 'node:assert/strict';
import {createWindowManager,layout} from '../windows.mjs';
function fake(){let i=0,store={};const windows=new Map(),tabs=new Map();return {storage:{session:{get:async()=>structuredClone(store),set:async v=>Object.assign(store,structuredClone(v))}},system:{display:{getInfo:async()=>[{isPrimary:true,workArea:{left:0,top:20,width:1440,height:880}}]}},windows:{
 create:async props=>{const w={id:++i,...props};const t={id:++i,windowId:w.id,url:props.url};w.tabs=[t];windows.set(w.id,w);tabs.set(t.id,t);return structuredClone(w);},
 get:id=>{if(!Number.isInteger(id))throw Error('No matching signature');if(!windows.has(id))return Promise.reject(Error('no window'));return Promise.resolve(structuredClone(windows.get(id)));},
 update:async()=>{throw Error('should not rearrange existing windows');},
 },tabs:{query:async q=>[...tabs.values()].filter(t=>t.windowId===q.windowId),get:async id=>{if(!tabs.has(id))throw Error('no tab');return {...tabs.get(id)};}},windowsMap:windows,tabsMap:tabs};}
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
test('real work-tab activation during repeated ensure is applied after window reconciliation',async()=>{
 const chrome=fake(),m=createWindowManager(chrome),args={chatUrl:'http://127.0.0.1:18562/'};
 const b=await m.ensureWindows(args);chrome.tabsMap.set(99,{id:99,windowId:b.workWindowId,url:'https://example.com/visible'});
 const get=chrome.windows.get;let release,entered;
 const entering=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 chrome.windows.get=async(...a)=>{entered();await gate;return get(...a);};
 const ensuring=m.ensureWindows(args);await entering;
 const activated=m.activated({tabId:99,windowId:b.workWindowId});
 release();await ensuring;
 assert.equal(await activated,true);assert.equal((await m.binding()).workTabId,99);
});
test('explicit toolbar bind during ensure survives its stale initial binding snapshot',async()=>{
 const chrome=fake(),m=createWindowManager(chrome),args={chatUrl:'http://127.0.0.1:18562/'};
 await m.ensureWindows(args);const get=chrome.windows.get;let release,entered;
 const entering=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 chrome.windows.get=async(...a)=>{entered();await gate;return get(...a);};
 const ensuring=m.ensureWindows(args);await entering;
 const binding=m.bind({id:88,windowId:89,url:'https://example.com/new-work'});
 release();await ensuring;await binding;
 assert.equal((await m.binding()).workTabId,88);
});
function chatFixture(){
 const chrome=fake();
 chrome.windows.getAll=async()=>[...chrome.windowsMap.values()].map(w=>structuredClone(w));
 chrome.windows.update=async(id,props)=>{const w=chrome.windowsMap.get(id);if(!w)throw Error('missing window');Object.assign(w,props);return structuredClone(w);};
 chrome.tabs.update=async(id,props)=>{const t=chrome.tabsMap.get(id);if(!t)throw Error('missing tab');Object.assign(t,props);return {...t};};
 return {chrome,m:createWindowManager(chrome),args:{chatUrl:'http://127.0.0.1:18562/'}};
}
test('show Nova recreates only the closed chat window and preserves work binding',async()=>{
 const {chrome,m,args}=chatFixture();const pair=await m.ensureWindows(args),before=await m.binding();
 chrome.windowsMap.delete(pair.chatWindowId);
 const result=await m.showChat(args);
 assert.equal(result.created,true);assert.notEqual(result.chatWindowId,pair.chatWindowId);
 const after=await m.binding();assert.equal(after.bindingId,before.bindingId);assert.equal(after.workTabId,before.workTabId);
 assert.equal(chrome.windowsMap.size,2);const chat=chrome.windowsMap.get(result.chatWindowId);
 assert.equal(chat.type,'popup');assert.equal(chat.focused,true);assert.equal(chat.url,args.chatUrl);
 assert.equal(chat.left,1040);assert.equal(chat.width,400);
});
for(const state of ['normal','minimized','maximized'])test(`show Nova reuses ${state} window without resetting user geometry`,async()=>{
 const {chrome,m,args}=chatFixture();const pair=await m.ensureWindows(args);
 const chat=chrome.windowsMap.get(pair.chatWindowId);Object.assign(chat,{state,left:900,top:100,width:450,height:720,focused:false});
 const result=await m.showChat(args);assert.equal(result.created,false);assert.equal(result.chatWindowId,pair.chatWindowId);
 assert.equal(chat.focused,true);assert.equal(chat.state,state==='minimized'?'normal':state);
 assert.deepEqual([chat.left,chat.top,chat.width,chat.height],[900,100,450,720]);assert.equal(chrome.windowsMap.size,2);
});
test('show Nova without work window creates only chat and repeated commands reuse it',async()=>{
 const {chrome,m,args}=chatFixture();const a=await m.showChat(args),b=await m.showChat(args);
 assert.equal(a.chatWindowId,b.chatWindowId);assert.equal(chrome.windowsMap.size,1);assert.equal((await m.binding()).workTabId,undefined);
});
test('show Nova recovers its existing popup after session binding is lost',async()=>{
 const {chrome,m,args}=chatFixture();const pair=await m.ensureWindows(args);
 await chrome.storage.session.set({binding:{}});
 const result=await m.showChat(args);assert.equal(result.created,false);assert.equal(result.chatWindowId,pair.chatWindowId);assert.equal(chrome.windowsMap.size,2);
});
test('show Nova never adopts a repurposed window or a normal browser tab',async()=>{
 const {chrome,m,args}=chatFixture();const pair=await m.ensureWindows(args);
 const old=chrome.windowsMap.get(pair.chatWindowId);old.tabs[0].url='https://example.com/';
 const normal=await chrome.windows.create({url:args.chatUrl,type:'normal'});
 const result=await m.showChat(args);assert.notEqual(result.chatWindowId,old.id);assert.notEqual(result.chatWindowId,normal.id);assert.equal(result.created,true);
});
test('show Nova rejects nonlocal URL and cancellation before creating or focusing',async()=>{
 const {chrome,m,args}=chatFixture();await assert.rejects(m.showChat({chatUrl:'https://example.com/'}),/invalid_chat_url/);
 await assert.rejects(m.showChat(args,()=>{throw Error('command_cancelled');}),/command_cancelled/);assert.equal(chrome.windowsMap.size,0);
 await m.ensureWindows(args);const count=chrome.windowsMap.size;let checks=0;
 await assert.rejects(m.showChat(args,()=>{if(++checks>1)throw Error('command_cancelled');}),/command_cancelled/);assert.equal(chrome.windowsMap.size,count);
});
