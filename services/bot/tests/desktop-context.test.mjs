import test from 'node:test';import assert from 'node:assert/strict';
import {createWorkContext} from '../desktop/context.mjs';
const page={bindingId:'b',tabId:1,documentId:'doc',revision:0,url:'https://example.com',title:'Example',readable:true};
const selected={page,selection:{text:'selected',documentId:'doc',revision:0}};
test('focus changes retain selection; navigation clears it; captures cannot mutate live state',()=>{
 const c=createWorkContext();c.updateBrowser(selected,{activate:true});const frozen=c.capture();
 c.updateBrowser({page,selection:null});assert.equal(c.snapshot().selection.text,'selected');
 c.updateBrowser({page:{...page,revision:1},selection:selected.selection});assert.equal(c.snapshot().selection,null);
 assert.equal(frozen.selection.text,'selected');assert.throws(()=>{frozen.page.title='other';});
 c.clearSelection();assert.equal(c.snapshot().selection,null);c.invalidate('disconnected');assert.equal(c.snapshot().kind,'none');
});
test('background browser events cannot steal file context; explicit activation returns to browser',()=>{
 const c=createWorkContext();c.updateBrowser(selected,{activate:true});c.selectFile({id:'f',path:'/tmp/file.md'});
 c.updateBrowser({page:{...page,revision:1},selection:null});assert.equal(c.snapshot().kind,'file');
 c.invalidate('disconnected');assert.equal(c.snapshot().kind,'file');
 c.updateBrowser(selected,{activate:true});assert.equal(c.snapshot().kind,'browser');
});
test('unrelated binding updates and stale revisions cannot replace current context',()=>{
 const c=createWorkContext();c.updateBrowser(selected,{activate:true});
 c.updateBrowser({page:{...page,bindingId:'other'},selection:null});assert.equal(c.snapshot().page.bindingId,'b');
 c.updateBrowser({page:{...page,revision:2},selection:null});c.updateBrowser(selected);assert.equal(c.snapshot().page.revision,2);
});
