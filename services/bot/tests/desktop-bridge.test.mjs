import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {WebSocket} from '../desktop/node_modules/ws/wrapper.mjs';
import {createBridge} from '../http.mjs';
import {createBrowserBridge} from '../desktop/browser.mjs';
const origin='chrome-extension://'+'a'.repeat(32);
async function fixture(t,options={}){
 const home=mkdtempSync(join(tmpdir(),'nova-browser-'));let bridge,time=100;
 const server=createBridge({token:'cli-only',handle:async()=>({ok:true}),extension:(q,s)=>bridge.handleHttp(q,s)});
 bridge=createBrowserBridge({server,home,now:()=>time,authTimeoutMs:60,...options});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{await bridge.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(home,{recursive:true,force:true});});
 const pair=(code,o=origin)=>fetch(url+'/browser/pair',{method:'POST',headers:{Origin:o,'Content-Type':'application/json'},body:JSON.stringify({code})});
 const connect=async(token)=>{const ws=new WebSocket(url.replace('http','ws')+'/browser/bridge',{origin});await once(ws,'open');if(token){const ready=once(ws,'message');ws.send(JSON.stringify({type:'auth',token}));assert.equal(JSON.parse((await ready)[0]).type,'ready');}return ws;};
 return {home,url,bridge,pair,connect,tick:n=>time+=n};
}
test('pairing is one-use, expires, binds Origin, and never changes CLI auth',async t=>{
 const f=await fixture(t),code=f.bridge.pairing().code;
 assert.equal((await f.pair(code,'https://evil.example')).status,403);
 f.tick(60001);assert.equal((await f.pair(code)).status,403);
 const good=f.bridge.pairing().code,res=await f.pair(good),{token}=await res.json();assert.equal(res.status,200);assert.ok(token);
 assert.equal((await f.pair(good)).status,403);
 assert.ok(!readFileSync(join(f.home,'browser-credential.json'),'utf8').includes(token));
 assert.equal(statSync(join(f.home,'browser-credential.json')).mode&0o777,0o600);
 assert.equal((await fetch(f.url+'/health',{method:'POST',headers:{Authorization:'Bearer '+token}})).status,403);
 const ws=new WebSocket(f.url.replace('http','ws')+'/browser/bridge',{origin:'https://evil.example'});
 await once(ws,'error');
 const socket=await f.connect(token);socket.close();
});
test('unauthenticated sockets receive no commands and expire',async t=>{
 const f=await fixture(t),ws=await f.connect();const frames=[];ws.on('message',x=>frames.push(x));
 const closed=once(ws,'close');assert.equal((await f.bridge.execute({id:'one',method:'read'})).error,'browser_disconnected');await closed;assert.deepEqual(frames,[]);
});
test('same command executes once; connection loss is unknown and never replayed',async t=>{
 const f=await fixture(t),{token}=await (await f.pair(f.bridge.pairing().code)).json(),ws=await f.connect(token);
 let sends=0;ws.on('message',x=>{const m=JSON.parse(x);if(m.type==='command'){sends++;ws.send(JSON.stringify({type:'result',result:{id:m.command.id,status:'completed',windows:{workWindowId:1}}}));}});
 const command={id:'same',requestId:'r',method:'windows.ensure',args:{}};
 const [a,b]=await Promise.all([f.bridge.execute(command),f.bridge.execute(command)]);assert.deepEqual(a,b);assert.equal(sends,1);
 assert.equal((await f.bridge.execute({...command,args:{different:true}})).error,'command_id_conflict');
 ws.removeAllListeners('message');const received=once(ws,'message');const pending=f.bridge.execute({id:'lost',method:'open',args:{url:'https://example.com'}});await received;ws.terminate();assert.equal((await pending).status,'unknown');
 const second=await f.connect(token);let replayed=0;second.on('message',()=>replayed++);
 assert.equal((await f.bridge.execute({id:'lost',method:'open',args:{url:'https://example.com'}})).status,'unknown');assert.equal(replayed,0);
});
test('malformed or oversized extension frames disconnect; pending actions settle',async t=>{
 const f=await fixture(t),{token}=await (await f.pair(f.bridge.pairing().code)).json(),ws=await f.connect(token);
 const closed=once(ws,'close');ws.send('x'.repeat(131073));await closed;assert.equal(f.bridge.status().connected,false);
});
test('obsolete authenticated sockets cannot publish context after replacement',async t=>{
 const contexts=[],f=await fixture(t,{onContext:c=>contexts.push(c)}),{token}=await (await f.pair(f.bridge.pairing().code)).json();
 const old=await f.connect(token);old._socket.pause();await f.connect(token);
 const page={bindingId:'obsolete',tabId:1,documentId:'d',revision:0,url:'https://example.com',title:'Old page',readable:true};
 old.send(JSON.stringify({type:'context',activate:true,context:{page,selection:null}}));
 const closed=once(old,'close');old._socket.resume();await closed;
 assert.equal(contexts.some(c=>c.page?.bindingId==='obsolete'),false);
});
test('close scope and PageRef cross the authenticated WebSocket bridge',async t=>{
 const f=await fixture(t),{token}=await (await f.pair(f.bridge.pairing().code)).json(),ws=await f.connect(token);
 ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='command'){
  assert.equal(m.command.method,'close');assert.equal(m.command.args.scope,'window');assert.equal(m.command.page.tabId,7);
  ws.send(JSON.stringify({type:'result',result:{id:m.command.id,status:'completed',action:'close',scope:'window',page:null}}));
 }});
 const r=await f.bridge.execute({id:'close',method:'close',page:{tabId:7},args:{scope:'window'}});
 assert.equal(r.status,'completed');assert.equal(r.page,null);
});
test('chat.show can be dispatched without any work page reference',async t=>{
 const f=await fixture(t),{token}=await (await f.pair(f.bridge.pairing().code)).json(),ws=await f.connect(token);
 ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='command'){
  assert.equal(m.command.method,'chat.show');assert.equal(m.command.page,undefined);
  ws.send(JSON.stringify({type:'result',result:{id:m.command.id,status:'completed',windows:{chatWindowId:7,created:true}}}));
 }});
 assert.equal((await f.bridge.execute({id:'show',method:'chat.show',args:{}})).status,'completed');
});
