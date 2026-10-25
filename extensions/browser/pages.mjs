import {readDOM} from './dom.mjs';
import {isChatPage} from './windows.mjs';
const same=(a,b)=>a&&b&&a.bindingId===b.bindingId&&a.tabId===b.tabId&&a.documentId===b.documentId&&a.revision===b.revision;
export function createPageAdapter({chrome,windows,publish}){
 let queue=Promise.resolve(),navigation=null;
 const navigationEpochs=new Map(),epochOf=tabId=>navigationEpochs.get(tabId)||0;
 const load=async()=>(await chrome.storage.session.get('pageContext')).pageContext||{page:null,selection:null};
 const save=async(context,activate=false)=>{await chrome.storage.session.set({pageContext:context});publish(context,activate);return context;};
 const serial=fn=>{const p=queue.then(fn);queue=p.catch(()=>{});return p;};
 async function refresh({activate=false,advanceRevision=false}={}){
  const binding=await windows.binding();if(!binding.workTabId)return save({page:null,selection:null});
  let tab,frame;try{tab=await chrome.tabs.get(binding.workTabId);frame=await chrome.webNavigation.getFrame({tabId:tab.id,frameId:0});}catch{return save({page:null,selection:null});}
  const nav=navigation?.bindingId===binding.bindingId&&navigation.tabId===tab.id?navigation:null;
  if(!frame||nav?.loading)return save({page:null,selection:null});
  const previous=await load(),p=previous.page,documentId=frame.documentId;
  const changed=advanceRevision||!p||p.bindingId!==binding.bindingId||p.documentId!==documentId||p.url!==tab.url;
  const page={bindingId:binding.bindingId,tabId:tab.id,documentId,revision:p?.documentId===documentId?p.revision+(changed?1:0):0,url:(tab.url||'').slice(0,8192),title:(tab.title||'').slice(0,1000),readable:false};
  if(isChatPage(tab.url,binding.chatUrl)||Number.isInteger(binding.chatWindowId)&&tab.windowId===binding.chatWindowId)page.reason='chat_page_cannot_be_work_page';
  else if(nav?.error)page.reason='navigation_failed';
  else if(!/^https?:\/\//.test(tab.url||''))page.reason='unsupported_scheme';
  else try{
   await chrome.scripting.executeScript({target:{tabId:tab.id,documentIds:[documentId]},files:['content.js']});page.readable=true;
  }catch{page.reason='permission_required_or_restricted_page';}
  const currentFrame=await chrome.webNavigation.getFrame({tabId:tab.id,frameId:0}).catch(()=>null);
  if(currentFrame?.documentId!==documentId)return save({page:null,selection:null});
  return save({page,selection:changed||!page.readable?null:previous.selection},activate);
 }
 async function read(expected){
  const context=await refresh(),page=context.page;
  if(!page)throw Error('work_page_unavailable');if(expected&&!same(expected,page))throw Error('stale_page');if(!page.readable)throw Error(page.reason);
  const result=await chrome.scripting.executeScript({target:{tabId:page.tabId,documentIds:[page.documentId]},func:readDOM,args:[{}]});
  const snapshot=result[0]?.result,latest=await chrome.tabs.get(page.tabId),frame=await chrome.webNavigation.getFrame({tabId:page.tabId,frameId:0});
  if(frame?.documentId!==page.documentId||latest.url!==page.url)throw Error('page_changed_during_read');
  if(!snapshot||!['text/html','application/xhtml+xml','text/plain'].includes(snapshot.contentType))throw Error('unsupported_content');
  return {status:'completed',page,snapshot:{page,...snapshot}};
 }
 return {
  refresh:args=>serial(()=>refresh(args)),
  navigation(details){
   if(details.frameId===0)navigationEpochs.set(details.tabId,epochOf(details.tabId)+1);
   return serial(async()=>{
    const b=await windows.binding();
    if(details.tabId!==b.workTabId||details.frameId!==0)return;
    navigation={bindingId:b.bindingId,tabId:b.workTabId,loading:details.loading===true,error:details.error===true};
    if(navigation.loading)return save({page:null,selection:null});
    return refresh({advanceRevision:details.sameDocument===true});
   });
  },
  async selection(message,sender){const b=await windows.binding();if(sender.tab?.id!==b.workTabId||sender.frameId!==0||typeof message.text!=='string'||message.text.length>4000)return;
   return serial(async()=>{const c=await refresh();if(!c.page?.readable||c.page.documentId!==sender.documentId||!message.text.trim())return;return save({...c,selection:{id:crypto.randomUUID(),text:message.text,documentId:c.page.documentId,revision:c.page.revision,truncated:!!message.truncated}});});},
  async execute(command,base,isCancelled=()=>false){
   const check=()=>{if(isCancelled()||command.deadlineAt&&command.deadlineAt<Date.now())throw Error('command_cancelled');};
   check();
   if(command.method==='chat.show')return {status:'completed',windows:await windows.showChat({chatUrl:base+'/'},check)};
   if(command.method==='close')return serial(async()=>{
    if(!['tab','window'].includes(command.args?.scope))throw Error('invalid_close_scope');
    check();const epoch=epochOf(command.page?.tabId),{page}=await refresh();
    if(!same(command.page,page)||command.page.url!==page.url)throw Error('context_changed');
    const receipt=await windows.close(page,command.args.scope,()=>{
     check();if(epoch!==epochOf(page.tabId))throw Error('context_changed');
    });
    navigation=null;
    const next=await refresh({activate:true});
    return {...receipt,page:next.page};
   });
   if(['click','fill','scroll'].includes(command.method)){
    try{
    const receipt=await serial(async()=>{
    check();const epoch=epochOf(command.page?.tabId),{page}=await refresh();
    if(!same(command.page,page))throw Error('context_changed');
    if(!page.readable)throw Error(page.reason);
    const target={tabId:page.tabId,documentIds:[page.documentId]};
    let inspected;
    if(command.method==='click'){
     inspected=(await chrome.scripting.executeScript({target,func:readDOM,args:[{mode:'inspect',ref:command.args.ref,expectedURL:page.url}]}))[0]?.result;
     if(inspected?.error)throw Error(inspected.error);
    }
    const binding=await windows.binding(),frame=await chrome.webNavigation.getFrame({tabId:page.tabId,frameId:0});
    check();if(epoch!==epochOf(page.tabId)||binding.bindingId!==page.bindingId||frame?.documentId!==page.documentId)throw Error('context_changed');
    if(command.method==='click')windows.expectPopup?.({id:command.id,page,href:inspected?.href});
    const result=(await chrome.scripting.executeScript({target,func:readDOM,args:[{...command.args,mode:command.method,expectedURL:page.url,...(inspected?.href?{expectedHref:inspected.href}:{})}]}))[0]?.result;
    if(!result)throw Error('action_receipt_missing');if(result.error)throw Error(result.error);
    return {...result,page};
    });
    if(command.method!=='click')return receipt;
    // Let navigation events drain before returning the reference for the next tool call.
    const end=Math.min(command.deadlineAt||Date.now()+4000,Date.now()+4000);
    await new Promise(r=>setTimeout(r,300));
    do{
     const latest=await this.refresh();
     if(latest.page){
      const original=receipt.page;
      const sameBinding=latest.page.bindingId===original.bindingId&&latest.page.tabId===original.tabId;
      if(!sameBinding&&!windows.isCommandDestination?.(command.id,latest.page))return {status:'failed',error:'context_changed',action:'click',dispatched:true};
      return {...receipt,page:latest.page};
     }
     if(isCancelled())break;
     await new Promise(r=>setTimeout(r,100));
    }while(Date.now()<end);
    return {...receipt,page:undefined,pagePending:true};
    }finally{if(command.method==='click')windows.clearPopup?.(command.id);}
   }
   if(command.method==='windows.ensure'){const result=await windows.ensureWindows({chatUrl:base+'/',...command.args});navigation=null;await this.refresh({activate:command.args?.activate===true});return {status:'completed',windows:result};}
   if(command.method==='read')return serial(()=>{check();return read(command.page);});
   if(command.method==='open'){
    const url=new URL(command.args.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('invalid_url');
    const b=await windows.binding();if(isChatPage(url.href,b.chatUrl||base+'/'))throw Error('chat_page_cannot_be_work_page');
    const existing=b.workTabId?await chrome.tabs.get(b.workTabId).catch(()=>null):null;
    if(!existing||existing.windowId!==b.workWindowId)await windows.ensureWindows({chatUrl:base+'/'});
    const bound=await windows.binding();if(command.page){const current=(await load()).page;if(!same(command.page,current))throw Error('stale_page');}
    navigation={bindingId:bound.bindingId,tabId:bound.workTabId,loading:true,error:false};await serial(()=>save({page:null,selection:null},true));check();
    const opened=await chrome.tabs.update(bound.workTabId,{url:url.href,active:true});
    // An active tab can still be behind another app. Foreground only explicit
    // opens, restoring a minimized window without changing its saved geometry.
    const workWindow=await chrome.windows.get(opened.windowId);check();
    await chrome.windows.update(workWindow.id,{focused:true,...(workWindow.state==='minimized'?{state:'normal'}:{})});
    // A committed document may still be a redirect landing page. Wait for DOM
    // readiness and a short quiet period; slow subresources need not finish.
    const end=Math.min(command.deadlineAt||Date.now()+8000,Date.now()+8000);
    let candidate=null,stableSince=0;
    while(Date.now()<end&&!isCancelled()){
     await new Promise(r=>setTimeout(r,100));const latest=await this.refresh({activate:true});
     const page=latest.page;
     if(!page||page.url==='about:blank'){candidate=null;continue;}
     if(page.bindingId!==bound.bindingId||page.tabId!==bound.workTabId)return {status:'failed',error:'context_changed',navigation:'dispatched'};
     const epoch=epochOf(page.tabId);
     if(page.readable){
      let ready;
      try{ready=(await chrome.scripting.executeScript({target:{tabId:page.tabId,documentIds:[page.documentId]},func:()=>document.readyState}))[0]?.result;}catch{}
      if(!['interactive','complete'].includes(ready)||epoch!==epochOf(page.tabId)){candidate=null;continue;}
     }
     const key=JSON.stringify([page.bindingId,page.tabId,page.documentId,page.revision,page.url,epoch]);
     if(key!==candidate){candidate=key;stableSince=Date.now();}
     if(Date.now()-stableSince>=500&&Date.now()<end&&!isCancelled())return {status:'completed',navigation:'dispatched',page};
    }
    return {status:'completed',navigation:'dispatched',pagePending:true};
   }
   throw Error('unsupported_method');
  },
 };
}
