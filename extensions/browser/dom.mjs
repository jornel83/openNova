/** Runs in Chrome's isolated world. No page scripts or form values are evaluated. */
export function readDOM({mode='read',ref}={}){
 const key='__openNovaDOM';const state=globalThis[key]??={ids:new WeakMap(),targets:new Map(),next:1};
 if(mode==='resolve'){const node=state.targets.get(ref);return {valid:!!node?.isConnected};}
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
  if(node.matches('input,textarea')||!visible(node))continue;
  const name=(node.getAttribute('aria-label')||node.innerText||node.getAttribute('title')||'').trim().slice(0,300);if(!name)continue;
  let id=state.ids.get(node);if(!id){id='target-'+state.next++;state.ids.set(node,id);}state.targets.set(id,node);
  const target={ref:id,role:node.getAttribute('role')||({A:'link',BUTTON:'button',SELECT:'combobox'}[node.tagName]||'control'),name};
  if(node.tagName==='A'&&/^https?:$/.test(new URL(node.href,location.href).protocol))target.href=node.href.slice(0,8192);targets.push(target);
 }
 const frames=[...document.querySelectorAll('iframe')].map(f=>{try{return new URL(f.src,location.href).origin===location.origin?'same_origin_iframe_not_read':'cross_origin_iframe_not_read';}catch{return 'iframe_not_read';}});
 return {text,truncated,targets,limitations:[...new Set(frames)],contentType:document.contentType,loading:document.readyState!=='complete'};
}
