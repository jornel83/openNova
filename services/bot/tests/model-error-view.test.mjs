import test from 'node:test';
import assert from 'node:assert/strict';
import {errorText} from '../web/api.mjs';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ROOT} from '../settings.mjs';
test('failed request view uses model diagnostic instead of generic failed status',()=>{
 const text=errorText({code:'failed',message:'api_error',diagnostic:{code:'api_error',stage:'conversation',status:403,requestId:'req_access_123'}});
 assert.match(text,/HTTP 403/);assert.match(text,/权限/);assert.match(text,/req_access_123/);
 assert.match(errorText({diagnostic:{code:'api_error',status:429}}),/限流|受限/);
 assert.match(errorText({diagnostic:{code:'api_error',status:503}}),/服务/);
});
test('text CLI reports the model HTTP status and service trace ID from the Bot result',async t=>{
 const home=mkdtempSync(join(tmpdir(),'nova-cli-error-'));writeFileSync(join(home,'client.token'),'test-only');
 const server=createServer((req,res)=>{req.resume();res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/result'?{status:'failed',error:'api_error',diagnostic:{code:'api_error',status:403,requestId:'req_cli_123'}}:{}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();server.close();rmSync(home,{recursive:true,force:true});});
 const result=await new Promise(resolve=>execFile(process.execPath,[join(ROOT,'tools/bot/client.mjs'),'--ask','test'],{env:{...process.env,OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(server.address().port),OPENNOVA_BOT_WEB_PORT:String(server.address().port===18561?18562:18561)},timeout:10000},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
 assert.equal(result.error?.code,1);assert.match(result.stderr,/HTTP 403/);assert.match(result.stderr,/req_cli_123/);
});
