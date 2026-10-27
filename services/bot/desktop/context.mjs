const same=(a,b)=>a&&b&&a.bindingId===b.bindingId&&a.tabId===b.tabId&&a.documentId===b.documentId&&a.revision===b.revision;
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const v of Object.values(value))freeze(v);}return value;}
export function createWorkContext({inspectFile=file=>file,initial,onChange=()=>{}}={}){
 let current=initial?.kind==='file'?{kind:'file',file:structuredClone(initial.file),historical:true}:{kind:'none'},browser=null,cleared=null;
 let last=JSON.stringify(current);
 const changed=()=>{const next=JSON.stringify(current);if(next!==last){last=next;onChange(structuredClone(current));}};
 const copy=()=>structuredClone(current.kind==='file'?{...current,file:inspectFile(current.file)}:current);
 return {
  updateBrowser(value,{activate=false}={}){
   if(!value?.page){browser=null;if(current.kind==='browser')current={kind:'none'};changed();return;}
   const page=structuredClone(value.page),old=browser?.page;
   if(!activate&&old&&old.bindingId!==page.bindingId)return;
   if(old&&old.bindingId===page.bindingId&&old.documentId===page.documentId&&old.revision>page.revision)return;
   let selection=value.selection;
   if(selection&&same(cleared?.page,page)&&JSON.stringify(selection)===cleared.selection)selection=null;
   if(selection&&(selection.documentId!==page.documentId||selection.revision!==page.revision))selection=null;
   if(!selection&&same(old,page))selection=browser.selection;
   browser={kind:'browser',page,selection:selection?structuredClone(selection):null};
   if(activate||current.kind!=='file')current=browser;changed();
  },
  selectFile(file){if(browser)browser={...browser,selection:null};current={kind:'file',file:structuredClone(file)};changed();},
  snapshot:copy,capture:()=>freeze(copy()),
  clearSelection(){if(browser?.selection)cleared={page:browser.page,selection:JSON.stringify(browser.selection)};if(browser)browser={...browser,selection:null};if(current.kind==='browser')current=browser;changed();},
  invalidate(){browser=null;if(current.kind==='browser')current={kind:'none'};changed();},
 };
}
