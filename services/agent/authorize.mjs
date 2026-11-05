/** User-driven official authorization. Passwords and credentials stay out of this UI. */
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createClient} from './chatgpt.mjs';

export function parseAuthorizationArgs(args){
  if(!args.length)return {mode:'signin'};
  if(args.length===1&&['--help','-h','--add-account','--list-accounts'].includes(args[0]))return {mode:{'--help':'help','-h':'help','--add-account':'add','--list-accounts':'list'}[args[0]]};
  if(args.length===2&&args[0]==='--select-account'&&/^[\w-]{1,100}$/.test(args[1]))return {mode:'select',profileId:args[1]};
  throw Error('invalid_authorization_arguments');
}
export async function authorizeAccount(args,{clientFactory=createClient,log=console.log,port=14556,signal}={}){
  const options=parseAuthorizationArgs(args);
  if(options.mode==='help'){log('用法：node services/agent/authorize.mjs [--add-account | --list-accounts | --select-account ID]\n默认复用已有授权；--add-account 添加并切换账号，保留原账号。登录必须由本人在官方页面完成。');return;}
  let authorizationUrl,server,loginUrl;
  const client=await clientFactory({openBrowser(url){
    if(new URL(url).origin!=='https://auth.openai.com')throw Error('unexpected_auth_origin');
    authorizationUrl=url;log(`请打开 ${loginUrl} ，在 OpenAI 页面选择要使用的账号并完成授权。`);
  }});
  if(options.mode==='list'){
    const active=await client.getSession();
    const profiles=await client.listProfiles();
    log(JSON.stringify(profiles.map(p=>({id:p.id,label:p.label,email:p.identity?.email,status:p.status,sharing:p.sharing,pending:!!p.pending,active:p.id===active.profileId})),null,2));return;
  }
  let signInOptions=options.mode==='add'?{newProfile:true}:{};
  if(options.mode==='select'){
    const profile=(await client.listProfiles()).find(p=>p.id===options.profileId);
    if(!profile)throw Error('profile_not_found');
    if(profile.status==='connected'&&profile.sharing){const selected=await client.selectProfile(profile.id);log(`已切换到保存的账号：${selected.profileLabel}`);return selected;}
    // Resume this registration without selecting it until OAuth succeeds.
    signInOptions={profileId:profile.id};
  }else if(options.mode==='signin'){
    const existing=await client.getSession();
    if(existing.status==='connected'&&existing.sharing){log('OpenNova 已授权。换账号请使用 --add-account，查看已保存账号请使用 --list-accounts。');return existing;}
  }
  try{
    server=createServer((request,response)=>{
      response.setHeader('Cache-Control','no-store');response.setHeader('Referrer-Policy','no-referrer');
      response.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
      if(request.headers.host!==`127.0.0.1:${server.address().port}`||request.method!=='GET'){response.writeHead(403);response.end();return;}
      if(request.url==='/login'&&authorizationUrl){response.writeHead(302,{Location:authorizationUrl});response.end();return;}
      response.setHeader('Content-Type','text/html; charset=utf-8');
      response.end('<!doctype html><html lang="zh"><meta charset="utf-8"><title>OpenNova 授权</title><body style="font:20px system-ui;max-width:680px;margin:80px auto"><h1>OpenNova · ChatGPT 授权</h1><p>在官方页面选择要使用的 ChatGPT 账号，并允许 OpenNova 使用其共享额度。添加账号不会删除原账号、会话或记忆。</p><p><a href="/login">Sign in with ChatGPT</a></p><p>等待本人完成登录。若显示旧账号，请先在官方页面切换账号。</p></body></html>');
    });
    await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',done);});
    loginUrl=`http://127.0.0.1:${server.address().port}/login`;
    const result=await client.signIn({...signInOptions,...(signal?{signal}:{})});
    if(result.status!=='connected'||!result.sharing)throw Error('sharing_not_enabled');
    log(`OpenNova 授权完成，当前账号：${result.profileLabel||'已连接'}。`);return result;
  }finally{authorizationUrl=undefined;if(server?.listening)await new Promise(done=>server.close(done));}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  process.umask(0o077);const controller=new AbortController();
  for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>controller.abort());
  try{await authorizeAccount(process.argv.slice(2),{signal:controller.signal});}
  catch(error){const code=error.code??error.message;console.error('授权未完成：'+(/^[a-z_]{1,80}$/.test(code)?code:'authorization_failed'));process.exitCode=1;}
  process.exit(process.exitCode??0);
}
