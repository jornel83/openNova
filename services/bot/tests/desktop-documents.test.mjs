import test from 'node:test';import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {mkdtempSync,rmSync,writeFileSync,realpathSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Operations} from '../operations.mjs';import {createWorkContext} from '../desktop/context.mjs';import {createDocumentOpener} from '../desktop/documents.mjs';
function fixture(t,{finish=true,code=0,stderr='',timeoutMs=10000}={}){
 const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-documents-'))),workspace=join(home,'project'),ops=new Operations({home,workspace}),context=createWorkContext(),calls=[];
 const spawnOpen=(...args)=>{const child=new EventEmitter();child.stderr=new PassThrough();child.kill=()=>{child.killed=true;};calls.push({args,child});if(finish)setImmediate(()=>{child.stderr.write(stderr);child.emit('close',code,null);});return child;};
 const opener=createDocumentOpener({workspace,ops,context,spawnOpen,timeoutMs});
 t.after(()=>{ops.close();rmSync(home,{recursive:true,force:true});});return {workspace,ops,context,calls,opener,spawnOpen};
}
test('document paths are literal argv, private model environment never reaches open, only dispatch selects file',async t=>{
 const f=fixture(t),name='方案 空格\'"$(touch BAD);.txt';writeFileSync(join(f.workspace,name),'内容');
 const r=await f.opener.open({id:'open-1',requestId:'req',path:name});
 assert.equal(r.status,'dispatched');assert.equal(r.file.contentAccess,'text_file');assert.equal(f.context.capture().file.name,name);
 const [program,args,options]=f.calls[0].args;assert.equal(program,'/usr/bin/open');assert.deepEqual(args,['--',join(f.workspace,name)]);assert.equal(options.shell,false);
 assert.ok(!Object.keys(options.env).some(k=>/TOKEN|KEY|SECRET/.test(k)));assert.equal(f.ops.get('open-1').requestId,'req');
});
test('same id opens once, different target conflicts, restarted uncertain commands never replay',async t=>{
 const f=fixture(t);writeFileSync(join(f.workspace,'test.md'),'# Test');
 const a={id:'one',path:'test.md'},r=await f.opener.open(a);assert.deepEqual(await f.opener.open(a),r);assert.equal(f.calls.length,1);
 await assert.rejects(f.opener.open({...a,path:'other.md'}),/command_id_conflict/);
 f.ops.put({id:'crashed',kind:'tool',operation:'document_open',status:'running',fingerprint:JSON.stringify({path:'test.md',applicationId:null}),createdAt:1});
 const next=createDocumentOpener({...f,spawnOpen:f.spawnOpen});assert.equal((await next.open({id:'crashed',path:'test.md'})).status,'unknown');assert.equal(f.calls.length,1);
});
test('cancel before dispatch never spawns; cancellation after dispatch never closes the user application',async t=>{
 const f=fixture(t,{finish:false});writeFileSync(join(f.workspace,'test.txt'),'a');const c=new AbortController();c.abort();
 assert.equal((await f.opener.open({id:'before',path:'test.txt'},{signal:c.signal})).status,'cancelled');assert.equal(f.calls.length,0);
 const after=new AbortController(),pending=f.opener.open({id:'after',path:'test.txt'},{signal:after.signal});after.abort();
 assert.equal((await pending).status,'unknown');assert.equal(f.calls.length,1);assert.equal(f.calls[0].args[0],'/usr/bin/open');assert.equal(f.context.capture().kind,'none');
});
test('timeout is unknown and not automatically replayed; failure preserves previous context',async t=>{
 const f=fixture(t,{finish:false,timeoutMs:10});writeFileSync(join(f.workspace,'test.txt'),'a');f.context.selectFile({id:'old',path:'/tmp/old.txt'});
 const a={id:'timeout',path:'test.txt'};assert.equal((await f.opener.open(a)).status,'unknown');assert.equal((await f.opener.open(a)).status,'unknown');assert.equal(f.calls.length,1);assert.equal(f.context.capture().file.id,'old');
});
test('missing/local/type errors do not launch; source code uses a text editor, never an interpreter',async t=>{
 const f=fixture(t);
 for(const [path,error] of [['missing.pdf','file_not_found'],['studio:/tmp/a.pdf','file_not_local'],['https://example.com/a.pdf','file_not_local'],['shortcuts://run','file_not_local']])assert.equal((await f.opener.open({id:path,path})).error,error);
 for(const name of ['app.dmg','install.pkg','run.command']){writeFileSync(join(f.workspace,name),'x');assert.equal((await f.opener.open({id:name,path:name})).error,'unsupported_file_type');}
 assert.equal(f.calls.length,0);writeFileSync(join(f.workspace,'script.py'),'print(1)');
 assert.equal((await f.opener.open({id:'python',path:'script.py'})).status,'dispatched');assert.deepEqual(f.calls[0].args[1],['-t','--',join(f.workspace,'script.py')]);
 assert.equal((await f.opener.open({id:'bad-app',path:'script.py',applicationId:'org.python.Python'})).error,'source_requires_editor');assert.equal(f.calls.length,1);
});
test('unsupported document body and unavailable explicit app are reported truthfully',async t=>{
 const f=fixture(t,{code:1,stderr:'Unable to find application named com.example.Missing'});writeFileSync(join(f.workspace,'test.pdf'),'%PDF');
 assert.equal((await f.opener.open({id:'missing-app',path:'test.pdf',applicationId:'com.example.Missing'})).error,'application_not_found');assert.equal(f.context.capture().kind,'none');
 const ok=fixture(t);writeFileSync(join(ok.workspace,'test.pdf'),'%PDF');const r=await ok.opener.open({id:'pdf',path:'test.pdf'});assert.equal(r.file.contentAccess,'not_connected');
});
test('host recovery preserves unknown dispatch and file reference reports saved-disk changes',async t=>{
 const {recoverToolRuns}=await import('../project.mjs');const {inspectFileReference}=await import('../desktop/documents.mjs');
 const f=fixture(t);f.ops.put({id:'in-flight',kind:'tool',operation:'document_open',status:'running'});recoverToolRuns(f.ops);
 assert.equal(f.ops.get('in-flight').status,'unknown');
 writeFileSync(join(f.workspace,'saved.md'),'old');const r=await f.opener.open({id:'saved',path:'saved.md'});writeFileSync(join(f.workspace,'saved.md'),'new longer content');
 assert.equal(inspectFileReference(r.file).diskStatus,'changed');rmSync(r.file.path);assert.equal(inspectFileReference(r.file).invalid,true);
});
