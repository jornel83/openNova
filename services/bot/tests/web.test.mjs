import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBridge} from '../http.mjs';
import {request} from 'node:http';

async function fixture(t) {
  const assets=mkdtempSync(join(tmpdir(),'nova-web-'));
  mkdirSync(join(assets,'assets'));writeFileSync(join(assets,'index.html'),'<!doctype html><title>OpenNova</title>');
  writeFileSync(join(assets,'assets','app.js'),'window.app=true;');
  const calls=[];
  const server=createBridge({token:'cli-only-secret',web:{assets},handle:async(path,body)=>{calls.push({path,body});return {path,body};}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();rmSync(assets,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const post=(path,body={},headers={})=>fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-OpenNova-Web':'1',...headers},body:JSON.stringify(body)});
  return {origin,post,calls};
}

test('browser serves the local chat shell without exposing the CLI bearer credential',async t=>{
  const {origin}=await fixture(t);
  const shell=await fetch(origin+'/');
  assert.equal(shell.status,200);
  assert.match(await shell.text(),/<title>OpenNova<\/title>/);
  assert.match(shell.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal((await fetch(origin+'/assets/app.js')).status,200);
  assert.notEqual((await fetch(origin+'/client.token')).status,200);
});

test('browser session requires same origin, cookie and CSRF while CLI authentication still works',async t=>{
  const {origin,post,calls}=await fixture(t);
  assert.equal((await post('/web/session',{}, {Origin:'https://example.org'})).status,403);
  assert.equal((await post('/web/session',{}, {Origin:'null'})).status,403);
  const login=await post('/web/session');assert.equal(login.status,200);
  const {csrf}=await login.json();assert.ok(csrf);
  const cookie=login.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
  const headers={Cookie:cookie.split(';')[0],'X-OpenNova-CSRF':csrf};
  assert.equal((await post('/web/api/snapshot')).status,401);
  assert.equal((await post('/web/api/approve',{id:'one'},{Cookie:headers.Cookie})).status,403);
  assert.equal((await post('/web/api/approve',{id:'one'},{...headers,Origin:'https://example.org'})).status,403);
  assert.equal(calls.length,0);
  const accepted=await post('/web/api/ask',{id:'one',text:'你好',source:'spoofed'},headers);
  assert.equal(accepted.status,200);assert.deepEqual(calls[0],{path:'/ask',body:{id:'one',text:'你好',source:'web'}});
  assert.equal((await post('/web/api/shutdown',{},headers)).status,404);
  assert.equal((await post('/api/bot',{endpoint:'send'},headers)).status,403);
  assert.equal((await fetch(origin+'/health',{method:'POST',headers:{Authorization:'Bearer cli-only-secret'},body:'{}'})).status,200);
  assert.equal((await fetch(origin+'/health',{method:'POST',headers:{Authorization:'Bearer cli-only-secret',Origin:origin},body:'{}'})).status,403);
});

test('host rebinding and cross-site bootstrap are rejected before handling any operation',async t=>{
  const {origin,post,calls}=await fixture(t);
  // fetch normalizes Host; use the wire API to exercise DNS-rebinding defense.
  const status=await new Promise((resolve,reject)=>{
    const req=request(origin+'/web/session',{method:'POST',headers:{Host:'attacker.example',Origin:origin,'Content-Type':'application/json','X-OpenNova-Web':'1'}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end('{}');
  });
  assert.equal(status,403);
  assert.equal((await post('/web/session',{}, {'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await post('/web/session',{}, {'Content-Type':'text/plain'})).status,403);
  assert.equal(calls.length,0);
});

test('Chinese input remains intact when UTF-8 characters cross HTTP chunks in either entry',async t=>{
  const {origin,post,calls}=await fixture(t);
  const login=await post('/web/session'),{csrf}=await login.json();
  const headers={Origin:origin,'Content-Type':'application/json','X-OpenNova-Web':'1',Cookie:login.headers.get('set-cookie').split(';')[0],'X-OpenNova-CSRF':csrf};
  const data=Buffer.from(JSON.stringify({id:'split-input',text:'你好'}));
  const boundary=data.indexOf(Buffer.from('你'))+1;
  for(const [path,auth] of [['/web/api/ask',headers],['/ask',{Authorization:'Bearer cli-only-secret'}]]){
    const status=await new Promise((resolve,reject)=>{
      const req=request(origin+path,{method:'POST',headers:auth},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
      req.on('error',reject);req.write(data.subarray(0,boundary));setTimeout(()=>req.end(data.subarray(boundary)),25);
    });
    assert.equal(status,200);assert.equal(calls.at(-1).body.text,'你好');
  }
});
