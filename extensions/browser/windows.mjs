export function layout(area){
 const {left,top,width,height}=area,gap=12;
 if(width<1000){const h=Math.floor((height-gap)/2);return {work:{left,top,width,height:h},chat:{left,top:top+h+gap,width,height:height-h-gap}};}
 const right=400;return {work:{left,top,width:width-right-gap,height},chat:{left:left+width-right,top,width:right,height}};
}
export function createWindowManager(chrome){
 let queue=Promise.resolve();
 const get=async()=>(await chrome.storage.session.get('binding')).binding||{};
 const save=async value=>{await chrome.storage.session.set({binding:value});return value;};
 async function isWorkValid(b){try{const t=await chrome.tabs.get(b.workTabId);return t.windowId===b.workWindowId&&t.url!==b.chatUrl;}catch{return false;}}
 async function ensure(options){
  const chatUrl=options.chatUrl,u=new URL(chatUrl);if(u.origin!==`http://127.0.0.1:${u.port}`||u.username||u.password)throw Error('invalid_chat_url');
  let b=await get();const displays=await chrome.system.display.getInfo(),area=options.bounds||(displays.find(d=>d.isPrimary)||displays[0]).workArea;
  const bounds=layout(area);
  if(!await isWorkValid(b)){const w=await chrome.windows.create({url:'about:blank',type:'normal',...bounds.work});b={...b,bindingId:crypto.randomUUID(),workWindowId:w.id,workTabId:w.tabs[0].id};}
  let chatValid=false;try{const w=await chrome.windows.get(b.chatWindowId,{populate:true});chatValid=w.tabs?.some(t=>t.url===chatUrl||t.pendingUrl===chatUrl);}catch{}
  if(!chatValid){const w=await chrome.windows.create({url:chatUrl,type:'popup',...bounds.chat});b.chatWindowId=w.id;}
  b.chatUrl=chatUrl;await save(b);return {workWindowId:b.workWindowId,workTabId:b.workTabId,chatWindowId:b.chatWindowId};
 }
 async function bind(tab){const b=await get();if(tab.windowId===b.chatWindowId||tab.url===b.chatUrl)throw Error('chat_page_cannot_be_work_page');if(!/^https?:\/\//.test(tab.url||''))throw Error('unsupported_page');return save({...b,bindingId:crypto.randomUUID(),workWindowId:tab.windowId,workTabId:tab.id});}
 return {binding:get,bind,
  ensureWindows(options){const p=queue.then(()=>ensure(options));queue=p.catch(()=>{});return p;},
  async activated({tabId,windowId}){const b=await get();if(windowId!==b.workWindowId||windowId===b.chatWindowId)return false;if(tabId===b.workTabId)return true;const t=await chrome.tabs.get(tabId);await bind(t);return true;},
 };
}
