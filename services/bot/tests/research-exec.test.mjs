import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
import {loadSettings} from '../../agent/settings.mjs';import {createBridge} from '../http.mjs';
const execution=await import('../research/exec.mjs').catch(()=>({}));
const root=loadSettings().harnessRoot,imp=p=>import(pathToFileURL(join(root,p)));
export async function fixture(t){
 const home=mkdtempSync(join(tmpdir(),'research-exec-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const {Context}=await imp('vendor/cordis/lib/index.js');const {default:Subprocess}=await imp('packages/subprocess/subprocess-local/lib/index.js');const {LocalBashExecutor}=await imp('packages/shell/bash-local/lib/index.js');
 const ctx=new Context();const subprocessFiber=ctx.plugin(Subprocess);await subprocessFiber;ctx.subprocess.internals={spillDir:home};const shellFiber=ctx.plugin(LocalBashExecutor,{cwd:home,graceMs:100});await shellFiber;t.after(async()=>{await shellFiber.dispose();await subprocessFiber.dispose();});
 const rows=new Map(),ops={put:r=>(rows.set(r.id,r),r),get:id=>rows.get(id),list:k=>[...rows.values()].filter(r=>r.kind===k)};
 return {home,ctx,rows,ops};
}
test('helper_joins_parent_request, helper_502_exits_nonzero, ordinary_bash_still_works',async t=>{
 assert.equal(typeof execution.createResearchExec,'function');const f=await fixture(t);const controller=new AbortController();let manager;let observed;
 const server=createBridge({token:'test',handle:async(path,body)=>{assert.equal(path,'/research/http');return manager.http(body,async(request,context)=>{observed=context;return {ok:false,statusCode:502,excerpt:'upstream failed',request};});}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});writeFileSync(join(f.home,'client.token'),'test');
 manager=execution.createResearchExec({shell:f.ctx.shell,ops:f.ops,workspace:f.home,home:f.home,port:server.address().port});t.after(()=>manager.close());
 const helper=new URL('../../../tools/research/http.mjs',import.meta.url).pathname;
 const r=await manager.run({command:`${process.execPath} '${helper}' --url https://example.com`},{requestId:'r1',callId:'c1',signal:controller.signal});
 assert.equal(r.exitCode,1);assert.equal(r.status,'failed');assert.equal(observed.requestId,'r1');assert.equal(observed.parentCallId,'c1');assert.equal(r.httpFailures,1);
 await assert.rejects(manager.http({executionId:r.id,request:{url:'https://example.com'}},()=>{}),/execution_not_active/);
 const ordinary=await (await f.ctx.shell.execute(f.ctx.shell.resolve({command:'echo ordinary'}))).result();assert.equal(ordinary.stdout.text.trim(),'ordinary');
});
test('late_helper_after_cancel_rejected and process reaped',async t=>{
 assert.equal(typeof execution.createResearchExec,'function');const f=await fixture(t),c=new AbortController();const manager=execution.createResearchExec({shell:f.ctx.shell,ops:f.ops,workspace:f.home,home:f.home,port:18560});t.after(()=>manager.close());
 const work=manager.run({command:'sleep 30'},{requestId:'r1',callId:'c1',signal:c.signal});await new Promise(r=>setTimeout(r,50));const id=[...f.rows.keys()][0];c.abort();
 const result=await work;assert.equal(result.status,'cancelled');await assert.rejects(manager.http({executionId:id,request:{}},()=>{}),/execution_not_active/);
});
test('native research helper uses one read budget and exit zero cannot hide HTTP failure',async t=>{
 const {installResearch}=await import('../research/runtime.mjs');const {createControls}=await import('../controls.mjs');const f=await fixture(t),hooks={},c=new AbortController();
 const requests={active:{id:'r-live',signal:c.signal}};f.ops.finish=(id,p)=>f.rows.set(id,{...f.rows.get(id),...p});
 let runtime;const server=createBridge({token:'test',handle:createControls({ops:f.ops,requests,research:{httpFromScript:body=>runtime.httpFromScript(body)}})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});writeFileSync(join(f.home,'client.token'),'test');
 const ctx={get:n=>n==='shell'?f.ctx.shell:undefined,on:(n,fn)=>hooks[n]=fn,systemPrompt:{context(){}}};
 runtime=installResearch(ctx,{ops:f.ops,requests,config:{enabled:true,available:true,workspace:f.home,home:f.home,port:server.address().port},transport:{async fetchWithOptions({url}){return {url,statusCode:502,contentType:'text/plain',encoding:'utf-8',body:{kind:'text',content:'Bad gateway'}};}}});runtime.begin(requests.active);t.after(()=>runtime.close());
 const helper=new URL('../../../tools/research/http.mjs',import.meta.url).pathname;
 const result=await hooks['tools/execute']({name:'research_exec',arguments:{command:`${process.execPath} '${helper}' --url https://example.com; true`},callId:'parent',signal:c.signal},()=>assert.fail());
 assert.equal(result.isError,true);assert.equal(result.meta.execution.exitCode,0);assert.equal(result.meta.execution.httpFailures,1);assert.equal(runtime.sources.forRequest('r-live').length,0);
 assert.equal(f.rows.get('r-live').research.usage.readCalls,1);assert.equal(f.rows.get('r-live').research.usage.researchExecCalls,1);
 const operation=[...f.rows.values()].find(r=>r.kind==='tool'&&r.callId==='parent');assert.equal(operation.exitCode,0);assert.equal(operation.status,'failed');assert.match(operation.stdout,/502/);
});
