import {request} from 'node:http';
import {readFileSync} from 'node:fs';
import {botSettings} from '../../services/bot/settings.mjs';
export async function main(argv=process.argv.slice(2),env=process.env){
 const b=botSettings(env),args={headers:{}};
 for(let i=0;i<argv.length;i+=2){const value=argv[i+1];if(value===undefined)throw Error('missing_http_argument');
  if(argv[i]==='--url')args.url=value;else if(argv[i]==='--encoding')args.encoding=value;else if(argv[i]==='--response-type')args.responseType=value;
  else if(argv[i]==='--header'){const at=value.indexOf(':');if(at<1)throw Error('invalid_header');args.headers[value.slice(0,at).trim()]=value.slice(at+1).trim();}
  else throw Error('unknown_http_argument');
 }
 if(!env.OPENNOVA_RESEARCH_EXECUTION_ID)throw Error('research_execution_required');
 const token=readFileSync(b.tokenPath,'utf8').trim();
 const result=await new Promise((resolve,reject)=>{
  const req=request(b.url+'/research/http',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},timeout:15000},res=>{
   let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;if(text.length>100000)req.destroy(Error('helper_response_too_large'));});res.on('error',reject);res.on('end',()=>{try{const data=JSON.parse(text);if(res.statusCode!==200)throw Error(data.error||'research_http_failed');resolve(data);}catch(error){reject(error);}});
  });req.on('error',reject);req.on('timeout',()=>req.destroy(Error('research_http_timeout')));
  req.end(JSON.stringify({executionId:env.OPENNOVA_RESEARCH_EXECUTION_ID,request:args}));
 });
 process.stdout.write(JSON.stringify(result)+'\n');return result.ok?0:1;
}
if(process.argv[1]===import.meta.filename)main().then(code=>{process.exitCode=code;}).catch(error=>{console.error(error.message);process.exitCode=1;});
