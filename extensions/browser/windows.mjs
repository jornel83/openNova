export function isChatPage(url,chatUrl){
 try{const a=new URL(url),b=new URL(chatUrl);return a.origin===b.origin&&a.pathname===b.pathname;}catch{return false;}
}
export function layout(area){
 const {left,top,width,height}=area,gap=12;
 if(width<1000){const h=Math.floor((height-gap)/2);return {work:{left,top,width,height:h},chat:{left,top:top+h+gap,width,height:height-h-gap}};}
 const right=400;return {work:{left,top,width:width-right-gap,height},chat:{left:left+width-right,top,width:right,height}};
}
export function createWindowManager(chrome){
 let queue=Promise.resolve(),popup=null,ensuring=0;
 const destinations=new Map();
 const get=async()=>(await chrome.storage.session.get('binding')).binding||{};
 const save=async value=>{await chrome.storage.session.set({binding:value});return value;};
 async function isWorkValid(b){try{const t=await chrome.tabs.get(b.workTabId);return t.windowId===b.workWindowId&&!isChatPage(t.url,b.chatUrl);}catch{return false;}}
 async function ensure(options){
  const chatUrl=options.chatUrl,u=new URL(chatUrl);if(u.origin!==`http://127.0.0.1:${u.port}`||u.username||u.password)throw Error('invalid_chat_url');
  let b=await get();const displays=await chrome.system.display.getInfo(),area=options.bounds||(displays.find(d=>d.isPrimary)||displays[0]).workArea;
  const bounds=layout(area);let workCreated=false,chatCreated=false;
  if(!await isWorkValid(b)){workCreated=true;const w=await chrome.windows.create({url:'about:blank',type:'normal',focused:false,...bounds.work});b={...b,bindingId:crypto.randomUUID(),workWindowId:w.id,workTabId:w.tabs[0].id};}
  let chatValid=false;try{const w=await chrome.windows.get(b.chatWindowId,{populate:true});chatValid=w.tabs?.some(t=>t.url===chatUrl||t.pendingUrl===chatUrl);}catch{}
  if(!chatValid){chatCreated=true;const w=await chrome.windows.create({url:chatUrl,type:'popup',...bounds.chat});b.chatWindowId=w.id;}
  // Chrome may clamp requested width/height. Correct only windows made by this
  // call; a subsequent ensure must leave the user's chosen positions untouched.
  if(workCreated&&chatCreated){
   let work=await chrome.windows.get(b.workWindowId),chat=await chrome.windows.get(b.chatWindowId);
   const adjust=async(w,target)=>{
    const delta=Object.fromEntries(Object.entries(target).filter(([k,v])=>w[k]!==v));
    return Object.keys(delta).length?chrome.windows.update(w.id,delta):w;
   };
   if(area.width>=1000){
    const h=Math.min(area.height,Math.max(work.height,chat.height));
    chat=await adjust(chat,{left:area.left+area.width-chat.width,top:area.top,height:h});
    work=await adjust(work,{left:area.left,top:area.top,width:chat.left-area.left-12,height:chat.height});
   }else{
    chat=await adjust(chat,{left:area.left,top:area.top+area.height-chat.height});
    work=await adjust(work,{left:area.left,top:area.top,height:chat.top-area.top-12});
   }
  }
  b.chatUrl=chatUrl;await save(b);
  if(options.activate){const w=await chrome.windows.get(b.workWindowId);await chrome.windows.update(w.id,{focused:true,...(w.state==='minimized'?{state:'normal'}:{})});}
  return {workWindowId:b.workWindowId,workTabId:b.workTabId,chatWindowId:b.chatWindowId};
 }
 async function bind(tab){const b=await get();if(tab.windowId===b.chatWindowId||isChatPage(tab.url,b.chatUrl))throw Error('chat_page_cannot_be_work_page');if(!/^https?:\/\//.test(tab.url||''))throw Error('unsupported_page');return save({...b,bindingId:crypto.randomUUID(),workWindowId:tab.windowId,workTabId:tab.id});}
 return {binding:get,bind,
  expectPopup({id,page,href}){popup=href?{id,page,href,expiresAt:Date.now()+2500}:null;},
  clearPopup(id){if(popup?.id===id)popup=null;destinations.delete(id);},
  isCommandDestination(id,page){const d=destinations.get(id);return !!d&&d.bindingId===page?.bindingId&&d.tabId===(page?.tabId??page?.workTabId);},
  async createdTarget(details){
   const p=popup,b=await get();
   if(!p||Date.now()>p.expiresAt||details.sourceTabId!==p.page.tabId||details.sourceFrameId!==0||details.url!==p.href||b.bindingId!==p.page.bindingId||b.workTabId!==p.page.tabId)return false;
   popup=null;
   const tab=await chrome.tabs.get(details.tabId);const adopted=await bind({...tab,url:tab.url||details.url});destinations.set(p.id,{bindingId:adopted.bindingId,tabId:adopted.workTabId});return true;
  },
  ensureWindows(options){ensuring++;const p=queue.then(()=>ensure(options)).finally(()=>{ensuring--;});queue=p.catch(()=>{});return p;},
  async focused(windowId){if(ensuring)return false;const b=await get();return windowId===b.workWindowId;},
  async activated({tabId,windowId}){if(ensuring)return false;const b=await get();if(windowId!==b.workWindowId||windowId===b.chatWindowId)return false;if(tabId===b.workTabId)return true;const t=await chrome.tabs.get(tabId);if(t.openerTabId!=null)return false;await bind(t);return true;},
 };
}
