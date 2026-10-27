/** Runs in Chrome's isolated world. No page scripts or form values are evaluated. */
export function readDOM({mode='read',ref,text:inputText,direction,distance,expectedURL,expectedHref}={}){
 const key='__openNovaDOM';const state=globalThis[key]??={ids:new WeakMap(),targets:new Map(),next:1};
 if(mode==='resolve'){const node=state.targets.get(ref);return {valid:!!node?.isConnected};}
 if(expectedURL&&location.href!==expectedURL)return {error:'context_changed'};
 const sensitive='[hidden],[aria-hidden="true"],[data-sensitive],input[type="password"],input[type="file"],[autocomplete*="cc-"],[autocomplete="one-time-code"],[autocomplete="current-password"],[autocomplete="new-password"]';
 const visibleControl=node=>node.isConnected&&!node.closest(sensitive)&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden';
 const fillable=node=>(node.tagName==='TEXTAREA'||node.tagName==='INPUT'&&['text','search','email','url','tel'].includes(node.type))&&visibleControl(node)&&!node.disabled&&!node.readOnly;
 if(['inspect','click','fill'].includes(mode)){
  const node=state.targets.get(ref);
  if(!node?.isConnected||!visibleControl(node))return {error:'stale_target'};
  const href=node.tagName==='A'?node.href:null;
  if(mode==='inspect')return {href:href&&/^https?:/.test(href)?href:null,target:node.target||null};
  if(mode==='click'){
   if(node.disabled||node.getAttribute('aria-disabled')==='true')return {error:'target_disabled'};
   if(expectedHref!==undefined&&href!==expectedHref)return {error:'stale_target'};
   if(href&&!/^https?:/.test(href))return {error:'unsupported_link'};
   node.click();return {status:'completed',action:'click'};
  }
  if(!fillable(node))return {error:'unsupported_input'};
  if(typeof inputText!=='string'||inputText.length>4000)return {error:'invalid_text'};
  const proto=node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto,'value').set.call(node,inputText);
  node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));
  return {status:'completed',action:'fill'};
 }
 if(mode==='scroll'){
  if(!['up','down'].includes(direction)||!Number.isFinite(distance)||distance<1||distance>3000)return {error:'invalid_scroll'};
  window.scrollBy({top:(direction==='up'?-1:1)*distance,behavior:'instant'});
  return {status:'completed',action:'scroll',scrollY:window.scrollY};
 }
 const excluded='script,style,noscript,template,input,textarea,[contenteditable],[hidden],[aria-hidden="true"],[data-sensitive]';
 const visible=node=>{const el=node.nodeType===Node.ELEMENT_NODE?node:node.parentElement;return el&&!el.closest(excluded)&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden';};
 const walker=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT);let text='',visited=0,truncated=false;
 while(walker.nextNode()){
  if(++visited>50000){truncated=true;break;}const node=walker.currentNode;if(!visible(node))continue;
  const value=node.textContent.replace(/\s+/g,' ').trim();if(!value)continue;
  text+=(text?'\n':'')+value;if(text.length>12000){text=text.slice(0,12000);truncated=true;break;}
 }
 for(const [id,node] of state.targets)if(!node.isConnected)state.targets.delete(id);
 const targets=[];for(const node of document.querySelectorAll('a[href],button,[role="button"],input:not([type="password"]),textarea,select')){
  if(targets.length>=100)break;
  const input=node.matches('input,textarea');if(input?!fillable(node):!visible(node))continue;
  const name=(node.getAttribute('aria-label')||node.getAttribute('placeholder')||node.innerText||node.getAttribute('title')||'').trim().slice(0,300);if(!name)continue;
  let id=state.ids.get(node);if(!id){id='target-'+state.next++;state.ids.set(node,id);}state.targets.set(id,node);
  const target={ref:id,role:node.getAttribute('role')||({A:'link',BUTTON:'button',SELECT:'combobox',INPUT:'textbox',TEXTAREA:'textbox'}[node.tagName]||'control'),name};
  if(node.tagName==='A'&&/^https?:$/.test(new URL(node.href,location.href).protocol))target.href=node.href.slice(0,8192);targets.push(target);
 }
 const frames=[...document.querySelectorAll('iframe')].map(f=>{try{return new URL(f.src,location.href).origin===location.origin?'same_origin_iframe_not_read':'cross_origin_iframe_not_read';}catch{return 'iframe_not_read';}});
 return {text,truncated,targets,limitations:[...new Set(frames)],contentType:document.contentType,loading:document.readyState!=='complete'};
}
