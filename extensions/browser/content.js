// Installed only in the explicitly bound top-level tab. No form values are sent.
(()=>{
 if(globalThis.__openNovaSelection)return;globalThis.__openNovaSelection=true;
 let timer;const notify=()=>{
  const selection=getSelection();if(!selection||selection.isCollapsed)return;
  const node=selection.anchorNode?.parentElement;
  if(node?.closest('input,textarea,[contenteditable],[data-sensitive]'))return;
  const text=selection.toString();if(!text.trim())return;
  chrome.runtime.sendMessage({type:'page-selection',text:text.slice(0,4000),truncated:text.length>4000}).catch(()=>{});
 };
 document.addEventListener('selectionchange',()=>{clearTimeout(timer);timer=setTimeout(notify,120);});
})();
