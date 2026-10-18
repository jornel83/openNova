import {createCommandRunner,reconnectDelay,boundedResult} from './connection.mjs';
import {createWindowManager} from './windows.mjs';
import {createPageAdapter} from './pages.mjs';
let socket=null,timer=null,attempt=0,base='http://127.0.0.1:18560',state='未配对',connecting=false;
const storage={get:async()=>(await chrome.storage.session.get('commands')).commands||{},set:commands=>chrome.storage.session.set({commands})};
const windows=createWindowManager(chrome);
const pages=createPageAdapter({chrome,windows,publish:(context,activate)=>send({type:'context',context,activate})});
const cancelled=new Set();
async function execute(command){if(cancelled.delete(command.id))return {status:'cancelled'};try{return await pages.execute(command,base,()=>cancelled.has(command.id));}finally{cancelled.delete(command.id);}}
const run=createCommandRunner({storage,execute});
const send=m=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(m));};
async function connect(){
 if(connecting||socket&&[WebSocket.CONNECTING,WebSocket.OPEN].includes(socket.readyState))return;
 connecting=true;
 try{
  const config=(await chrome.storage.local.get('connection')).connection;if(!config){state='未配对';return;}base=config.base;state='连接中';
  const ws=new WebSocket(base.replace('http:','ws:')+'/browser/bridge');socket=ws;
  ws.onopen=()=>ws.send(JSON.stringify({type:'auth',token:config.token}));
  ws.onmessage=async event=>{try{
   if(new TextEncoder().encode(event.data).length>131072)throw Error('packet_too_large');const m=JSON.parse(event.data);
   if(m.type==='ready'){state='已连接';attempt=0;await pages.refresh();return;}
   if(m.type==='ping'){send({type:'pong'});return;}
   if(m.type==='cancel'){cancelled.add(m.id);setTimeout(()=>cancelled.delete(m.id),30000);return;}
   if(m.type==='command'){const result=boundedResult(await run(m.command));if(socket===ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'result',result}));}
  }catch{ws.close(1008,'invalid_message');}};
  ws.onerror=()=>{state='连接失败，等待重连';};
  ws.onclose=()=>{if(socket!==ws)return;socket=null;state='连接断开，等待重连';clearTimeout(timer);timer=setTimeout(connect,reconnectDelay(attempt++));};
 }finally{connecting=false;}
}
function localBase(value){const u=new URL(value);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('仅支持本机 127.0.0.1 HTTP 地址');return u.origin;}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(sender.id===chrome.runtime.id&&message.type==='page-selection'){pages.selection(message,sender).then(()=>reply({ok:true}),()=>reply({ok:false}));return true;}
 // Credentials and local controls are available only to our settings page.
 if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('options.html'))return;
 (async()=>{
  if(message.type==='pair'){
   const target=localBase(message.base),response=await fetch(target+'/browser/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:message.code})});
   const r=await response.json();if(!response.ok)throw Error(r.error);
   await chrome.storage.local.set({connection:{base:target,token:r.token}});socket?.close();socket=null;await connect();return {paired:true};
  }
  if(message.type==='reconnect'){socket?.close();socket=null;await connect();}
  if(message.type==='local-command')return run({id:crypto.randomUUID(),method:message.method,args:message.args,deadlineAt:Date.now()+15000});
  return {base,state,binding:await windows.binding(),context:(await chrome.storage.session.get('pageContext')).pageContext};
 })().then(reply,e=>reply({error:e.message}));return true;
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(async()=>{await chrome.alarms.create('reconnect',{periodInMinutes:0.5});await connect();});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='reconnect')void connect();});
chrome.action.onClicked.addListener(async tab=>{try{await windows.bind(tab);await pages.refresh({activate:true});await chrome.action.setBadgeText({text:'ON',tabId:tab.id});}catch{await chrome.runtime.openOptionsPage();}});
chrome.tabs.onActivated.addListener(info=>{void windows.activated(info).then(active=>active&&pages.refresh({activate:true})).catch(()=>{});});
chrome.webNavigation.onCreatedNavigationTarget.addListener(details=>{void windows.createdTarget(details).then(active=>active&&pages.refresh({activate:true})).catch(()=>{});});
chrome.windows.onFocusChanged.addListener(id=>{void windows.focused(id).then(active=>active&&pages.refresh({activate:true})).catch(()=>{});});
chrome.tabs.onRemoved.addListener(tabId=>{void windows.binding().then(b=>b.workTabId===tabId&&pages.refresh()).catch(()=>{});});
chrome.tabs.onUpdated.addListener((tabId,change)=>{if(change.status==='complete'||change.title)void windows.binding().then(b=>b.workTabId===tabId&&pages.refresh()).catch(()=>{});});
chrome.webNavigation.onBeforeNavigate.addListener(d=>{void pages.navigation({...d,loading:true}).catch(()=>{});});
for(const event of [chrome.webNavigation.onCommitted,chrome.webNavigation.onDOMContentLoaded,chrome.webNavigation.onCompleted])event.addListener(d=>{void pages.navigation({...d,loading:false}).catch(()=>{});});
for(const event of [chrome.webNavigation.onHistoryStateUpdated,chrome.webNavigation.onReferenceFragmentUpdated])event.addListener(d=>{void pages.navigation({...d,loading:false,sameDocument:true}).catch(()=>{});});
chrome.webNavigation.onErrorOccurred.addListener(d=>{void pages.navigation({...d,loading:false,error:true}).catch(()=>{});});
// Extension service workers must register listeners synchronously; no top-level await.
void chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}).then(()=>chrome.alarms.create('reconnect',{periodInMinutes:0.5})).then(connect);
