import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {browserHandler} from './web-http.mjs';
export function createBridge({token,handle,web}) {
  const browser=web?browserHandler(web,handle):null;
  return createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
    if(browser&&await browser(req,res))return;
    const reply=(status,value)=>{res.writeHead(status);res.end(JSON.stringify(value));};
    const given=Buffer.from(req.headers.authorization||''),wanted=Buffer.from('Bearer '+token);
    if(req.method!=='POST'||req.headers.origin||given.length!==wanted.length||!timingSafeEqual(given,wanted))return reply(403,{error:'unauthorized'});
    try {
      const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>100000)throw Error('request_too_large');chunks.push(chunk);}
      const raw=Buffer.concat(chunks).toString('utf8');
      const body=JSON.parse(raw||'{}');
      if(!body||typeof body!=='object'||Array.isArray(body))throw Error('invalid_request');
      reply(200,await handle(req.url,body));
    }catch(error){reply(400,{error:String(error.message||'bot_error').slice(0,300)});}
  });
}
