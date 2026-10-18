import {WebSocketServer,WebSocket} from 'ws';
import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {VERSION,MAX_PACKET,METHODS,extensionOrigin,id,pageContext,result} from './protocol.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function createBrowserBridge({server,home,onContext=()=>{},now=Date.now,authTimeoutMs=5000}) {
 mkdirSync(home,{recursive:true,mode:0o700});
 const credentialPath=join(home,'browser-credential.json'),journalPath=join(home,'browser-commands.json');
 const read=(path,fallback)=>{try{return JSON.parse(readFileSync(path,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
 const write=(path,value)=>{writeFileSync(path+'.tmp',JSON.stringify(value),{mode:0o600});renameSync(path+'.tmp',path);};
 let credential=read(credentialPath,null),pair=null,active=null,closed=false;
 const journal=new Map(read(journalPath,[]).map(([key,value])=>[key,{...value,result:{id:key,status:'unknown',error:'host_restarted'}}]));
 const pending=new Map(),sockets=new Set();
 const persist=()=>write(journalPath,[...journal].map(([key,v])=>[key,{fingerprint:v.fingerprint}]));
 const wss=new WebSocketServer({noServer:true,maxPayload:MAX_PACKET,perMessageDeflate:false});
 function settle(key,value){const p=pending.get(key);if(!p)return;pending.delete(key);clearTimeout(p.timer);p.signal?.removeEventListener('abort',p.abort);journal.get(key).result=value;p.resolve(value);}
 function lost(ws){if(active!==ws)return;active=null;for(const key of pending.keys())settle(key,{id:key,status:'unknown',error:'browser_disconnected_after_send'});onContext({page:null,selection:null},{disconnected:true});}
 function attach(ws,req){
   sockets.add(ws);ws.on('error',()=>lost(ws));let authenticated=false,lastSeen=now();
   const timeout=setTimeout(()=>ws.close(1008,'authentication_required'),authTimeoutMs);
   const heartbeat=setInterval(()=>{if(now()-lastSeen>60000)return ws.terminate();if(authenticated&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'ping'}));},20000);heartbeat.unref();
   ws.on('close',()=>{clearTimeout(timeout);clearInterval(heartbeat);sockets.delete(ws);lost(ws);});
   ws.on('message',raw=>{try{
     const m=JSON.parse(raw);lastSeen=now();
     if(!authenticated){
       if(m.type!=='auth'||typeof m.token!=='string'||m.token.length>200||!credential||req.headers.origin!==credential.origin||!equal(hash(m.token),credential.hash))return ws.close(1008,'unauthorized');
       clearTimeout(timeout);authenticated=true;if(active){const old=active;lost(old);old.close(1000,'replaced');}active=ws;ws.send(JSON.stringify({type:'ready',version:VERSION}));return;
     }
     if(m.type==='pong')return;
     if(m.type==='result'){const r=result(m.result);settle(r.id,r);return;}
     if(m.type==='context'){onContext(pageContext(m.context),{activate:m.activate===true});return;}
     throw Error('invalid_message');
   }catch{ws.close(1008,'invalid_message');}});
 }
 const upgrade=(req,socket,head)=>{
   if(req.url!=='/browser/bridge')return socket.destroy();
   if(closed||!validHost(req)||!extensionOrigin(req.headers.origin)||credential&&credential.origin!==req.headers.origin){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return socket.destroy();}
   wss.handleUpgrade(req,socket,head,ws=>attach(ws,req));
 };
 server.on('upgrade',upgrade);
 function validHost(req){return req.headers.host===`127.0.0.1:${server.address()?.port}`;}
 async function handleHttp(req,res){
   if(req.url!=='/browser/pair')return false;
   const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));return true;};
   if(!validHost(req)||!extensionOrigin(req.headers.origin))return reply(403,{error:'unauthorized'});
   res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');
   if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','POST');res.setHeader('Access-Control-Allow-Headers','Content-Type');return reply(204,{});}
   if(req.method!=='POST')return reply(405,{error:'method_not_allowed'});
   try{
     let raw='',length=0;for await(const chunk of req){length+=chunk.length;if(length>2048)return reply(413,{error:'request_too_large'});raw+=chunk;}
     const {code}=JSON.parse(raw);
     if(!pair||now()>pair.expiresAt||!equal(code,pair.code))return reply(403,{error:'pairing_code_invalid_or_expired'});
     pair=null;const token=randomBytes(32).toString('hex');credential={origin:req.headers.origin,hash:hash(token)};write(credentialPath,credential);
     if(active){const old=active;lost(old);old.close(1000,'paired_again');}
     return reply(200,{token,version:VERSION});
   }catch{return reply(400,{error:'invalid_request'});}
 }
 function execute(command,{signal}={}){
   const fail=error=>Promise.resolve({id:command?.id||'',status:'failed',error});
   if(!command||!id(command.id)||!METHODS.has(command.method))return fail('invalid_command');
   const fingerprint=hash(JSON.stringify({method:command.method,args:command.args||{},page:command.page||null,requestId:command.requestId||null}));
   if(journal.has(command.id)){const old=journal.get(command.id);return old.fingerprint!==fingerprint?fail('command_id_conflict'):old.promise||Promise.resolve(old.result);}
   if(signal?.aborted)return Promise.resolve({id:command.id,status:'cancelled'});
   if(!active||active.readyState!==WebSocket.OPEN)return fail('browser_disconnected');
   const deadlineAt=command.deadlineAt??now()+15000;
   if(deadlineAt<=now())return Promise.resolve({id:command.id,status:'cancelled',error:'deadline_exceeded'});
   const frame=JSON.stringify({type:'command',command:{...command,args:command.args||{},deadlineAt}});
   if(Buffer.byteLength(frame)>MAX_PACKET)return fail('command_too_large');
   if(journal.size>=2048)return fail('command_journal_full');
   let resolve;const promise=new Promise(r=>resolve=r);journal.set(command.id,{fingerprint,promise});persist();
   const abort=()=>{if(active?.readyState===WebSocket.OPEN)active.send(JSON.stringify({type:'cancel',id:command.id}));settle(command.id,{id:command.id,status:'unknown',error:'cancelled_after_send'});};
   const timer=setTimeout(()=>{if(active?.readyState===WebSocket.OPEN)active.send(JSON.stringify({type:'cancel',id:command.id}));settle(command.id,{id:command.id,status:'unknown',error:'deadline_exceeded_after_send'});},Math.min(deadlineAt-now(),30000));
   pending.set(command.id,{resolve,timer,abort,signal});signal?.addEventListener('abort',abort,{once:true});
   active.send(frame,error=>{if(error)settle(command.id,{id:command.id,status:'unknown',error:'send_failed'});});return promise;
 }
 return {handleHttp,execute,
   pairing(){pair={code:randomBytes(24).toString('hex'),expiresAt:now()+60000};return {...pair};},
   ensureWindows:options=>execute({id:randomUUID(),method:'windows.ensure',args:options}),
   status:()=>({paired:!!credential,connected:!!active,extensionOrigin:credential?.origin||null,pending:pending.size}),
   async close(){closed=true;server.off('upgrade',upgrade);if(active)lost(active);for(const ws of sockets)ws.terminate();await new Promise(r=>wss.close(r));},
 };
}
