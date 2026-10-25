import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {once} from 'node:events';
import {WebSocket} from '../desktop/node_modules/ws/wrapper.mjs';
import {createBridge} from '../http.mjs';import {createDesktop} from '../desktop/controller.mjs';

test('authenticated desktop open ensures windows with trusted chat URL and preserves URL navigation compatibility',async t=>{
 const home=mkdtempSync(join(tmpdir(),'nova-desktop-start-'));let desktop;
 const server=createBridge({token:'cli-only',handle:(p,b)=>desktop.handle(p,b),extension:(q,s)=>desktop.handleHttp(q,s)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 desktop=createDesktop({server,home,chatUrl:base+'/'});
 t.after(async()=>{await desktop.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(home,{recursive:true,force:true});});
 const origin='chrome-extension://'+'a'.repeat(32);
 const pair=await fetch(base+'/browser/pair',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({code:desktop.pairing().code})});
 const {token}=await pair.json();const ws=new WebSocket(base.replace('http','ws')+'/browser/bridge',{origin});
 await once(ws,'open');const ready=once(ws,'message');ws.send(JSON.stringify({type:'auth',token}));await ready;
 const sent=[];ws.on('message',raw=>{const msg=JSON.parse(raw);if(msg.type==='command'){sent.push(msg.command);ws.send(JSON.stringify({type:'result',result:{id:msg.command.id,status:'completed'}}));}});
 const post=body=>fetch(base+'/desktop/open',{method:'POST',headers:{Authorization:'Bearer cli-only'},body:JSON.stringify(body)});
 assert.equal((await post({})).status,200);assert.equal(sent[0].method,'windows.ensure');assert.equal(sent[0].args.chatUrl,base+'/');assert.equal(sent[0].args.activate,false);
 await post({chatUrl:'http://127.0.0.1:9999/'});assert.equal(sent[1].args.chatUrl,base+'/');
 await post({url:'https://example.com/'});assert.equal(sent[2].method,'open');assert.equal(sent[2].args.url,'https://example.com/');
 const chat=await fetch(base+'/desktop/chat',{method:'POST',headers:{Authorization:'Bearer cli-only'},body:JSON.stringify({chatUrl:'https://evil.example/',page:{tabId:999}})});
 assert.equal(chat.status,200);assert.equal(sent.at(-1).method,'chat.show');assert.deepEqual(sent.at(-1).args,{});assert.equal(sent.at(-1).page,undefined);
 const count=sent.length;assert.equal((await fetch(base+'/desktop/open',{method:'POST',headers:{Origin:base,Authorization:'Bearer cli-only'},body:'{}'})).status,403);assert.equal(sent.length,count);
});
