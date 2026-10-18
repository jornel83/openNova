/** Browser access is separate from the CLI bearer API and stays on loopback. */
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';

const routes=new Set(['snapshot','document-open','ask','result','cancel','approvals','approve','reject']);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.svg':'image/svg+xml'};
const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};

export function browserHandler({assets},handle) {
  const cookie=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
  const root=resolve(assets);
  return async(req,res)=>{
    const path=req.url?.split('?')[0];
    if(path!=='/'&&!path?.startsWith('/assets/')&&!path?.startsWith('/web/'))return false;
    const host=req.headers.host,port=req.socket.localPort;
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host)){json(res,403,{error:'unauthorized'});return true;}
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(req.method==='GET'&&(path==='/'||path.startsWith('/assets/'))){
      const file=path==='/'?resolve(root,'index.html'):resolve(root,'.'+path);
      if(!file.startsWith(root+sep)||!/^\/[\w./-]*$/.test(path)||path.split('/').includes('..')){json(res,404,{error:'not_found'});return true;}
      try{const data=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream'});res.end(data);}
      catch{json(res,404,{error:'web_assets_unavailable'});}
      return true;
    }
    if(req.method!=='POST'||req.headers.origin!==`http://${host}`||req.headers['x-opennova-web']!=='1'
      ||(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin')
      ||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')){
      json(res,403,{error:'unauthorized'});return true;
    }
    if(path==='/web/session'){
      res.setHeader('Set-Cookie',`opennova_web=${cookie}; HttpOnly; SameSite=Strict; Path=/web/`);
      json(res,200,{csrf});return true;
    }
    const supplied=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('opennova_web='))?.slice(13);
    if(!equal(supplied,cookie)){json(res,401,{error:'web_session_expired'});return true;}
    if(!equal(req.headers['x-opennova-csrf'],csrf)){json(res,403,{error:'unauthorized'});return true;}
    const name=path.slice('/web/api/'.length);
    if(!path.startsWith('/web/api/')||!routes.has(name)){json(res,404,{error:'unknown_route'});return true;}
    try{
      const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>100000)throw Error('request_too_large');chunks.push(chunk);}
      const raw=Buffer.concat(chunks).toString('utf8');
      const body=JSON.parse(raw||'{}');
      if(!body||typeof body!=='object'||Array.isArray(body))throw Error('invalid_request');
      if(name==='ask')body.source='web';
      json(res,200,await handle('/'+name,body));
    }catch(error){json(res,400,{error:String(error.message||'bot_error').slice(0,300)});}
    return true;
  };
}
