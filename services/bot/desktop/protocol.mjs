/** M0 wire protocol. The browser is an authenticated but untrusted input source. */
export const VERSION=1, MAX_PACKET=128*1024;
export const METHODS=new Set(['open','read','windows.ensure','cancel']);
export const extensionOrigin=value=>typeof value==='string'&&/^chrome-extension:\/\/[a-p]{32}$/.test(value);
export const id=value=>typeof value==='string'&&value.length>0&&value.length<=100;
export function pageRef(p){
 return !!p&&id(p.bindingId)&&Number.isInteger(p.tabId)&&p.tabId>=0&&id(p.documentId)&&Number.isInteger(p.revision)&&p.revision>=0&&typeof p.url==='string'&&p.url.length<=8192&&typeof p.title==='string'&&p.title.length<=1000&&typeof p.readable==='boolean';
}
export function pageContext(value){
 if(!value||!('page' in value)||value.page!==null&&!pageRef(value.page))throw Error('invalid_context');
 const p=value.page,s=value.selection;
 if(s!=null&&(!p||typeof s.text!=='string'||s.text.length>4000||s.documentId!==p.documentId||s.revision!==p.revision))throw Error('invalid_selection');
 return {page:p?{...p}:null,selection:s?{text:s.text,documentId:s.documentId,revision:s.revision,truncated:!!s.truncated}:null};
}
export function result(value){
 if(!value||!id(value.id)||!['completed','failed','cancelled','unknown'].includes(value.status))throw Error('invalid_result');
 if(value.page&&!pageRef(value.page))throw Error('invalid_page');
 if(value.snapshot){const s=value.snapshot;if(!pageRef(s.page)||typeof s.text!=='string'||s.text.length>12000||typeof s.truncated!=='boolean'||!Array.isArray(s.targets)||s.targets.length>100)throw Error('invalid_snapshot');
 for(const t of s.targets)if(!id(t.ref)||typeof t.name!=='string'||t.name.length>300||typeof t.role!=='string'||t.role.length>50||t.href!=null&&(typeof t.href!=='string'||t.href.length>8192))throw Error('invalid_target');}
 return value;
}
