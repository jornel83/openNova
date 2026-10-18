const same=(a,b)=>a&&b&&a.bindingId===b.bindingId&&a.tabId===b.tabId&&a.documentId===b.documentId&&a.revision===b.revision;
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const v of Object.values(value))freeze(v);}return value;}
export function createWorkContext(){
 let current={kind:'none'},browser=null;
 const copy=()=>structuredClone(current);
 return {
  updateBrowser(value,{activate=false}={}){
   if(!value?.page){browser=null;if(current.kind==='browser')current={kind:'none'};return;}
   const page=structuredClone(value.page),old=browser?.page;
   if(!activate&&old&&old.bindingId!==page.bindingId)return;
   if(old&&old.bindingId===page.bindingId&&old.documentId===page.documentId&&old.revision>page.revision)return;
   let selection=value.selection;
   if(selection&&(selection.documentId!==page.documentId||selection.revision!==page.revision))selection=null;
   if(!selection&&same(old,page))selection=browser.selection;
   browser={kind:'browser',page,selection:selection?structuredClone(selection):null};
   if(activate||current.kind!=='file')current=browser;
  },
  selectFile(file){current={kind:'file',file:structuredClone(file)};},
  snapshot:copy,capture:()=>freeze(copy()),
  clearSelection(){if(browser)browser={...browser,selection:null};if(current.kind==='browser')current=browser;},
  invalidate(){browser=null;if(current.kind==='browser')current={kind:'none'};},
 };
}
