import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {request} from 'node:http';
import {botSettings,ROOT} from '../../services/bot/settings.mjs';
export function settings(probe=false){return probe?{url:'http://127.0.0.1:18562',home:join(ROOT,'output/desktop-m0'),tokenPath:join(ROOT,'output/desktop-m0/client.token')}:botSettings();}
export async function desktopApi(path,body={},probe=false,{config=settings(probe),signal,timeout=20000}={}){
 const token=readFileSync(config.tokenPath,'utf8').trim();
 return new Promise((resolve,reject)=>{const req=request(config.url+path,{agent:false,signal,method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},timeout},res=>{let raw='';res.on('error',reject);res.on('data',x=>{raw+=x;if(raw.length>2_000_000)req.destroy(Error('response_too_large'));});res.on('end',()=>{try{const value=JSON.parse(raw);if(res.statusCode!==200)throw Error(value.error);resolve(value);}catch(e){reject(e);}});});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('desktop_timeout')));req.end(JSON.stringify(body));});
}
if(process.argv[1]&&resolve(process.argv[1])===import.meta.filename){
 const args=process.argv.slice(2),probe=args.includes('--probe'),command=args.find(x=>x!=='--probe')||'status';
 if(!['status','windows','read','open','context'].includes(command))throw Error('usage: client.mjs [--probe] status|windows|read|context|open URL');
 const url=args[args.indexOf(command)+1];
 console.log(JSON.stringify(await desktopApi('/desktop/'+command,command==='open'?{url}:{},probe),null,2));
}
