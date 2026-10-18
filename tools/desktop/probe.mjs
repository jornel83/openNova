/** M0 fixture host: production HTTP auth + desktop controller, no model or microphone. */
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {createBridge} from '../../services/bot/http.mjs';
import {createDesktop} from '../../services/bot/desktop/controller.mjs';
import {settings} from './client.mjs';
process.umask(0o077);const config=settings(true);mkdirSync(config.home,{recursive:true,mode:0o700});
if(!existsSync(config.tokenPath))writeFileSync(config.tokenPath,randomBytes(32).toString('hex'),{mode:0o600});
let desktop;
const server=createBridge({token:readFileSync(config.tokenPath,'utf8').trim(),handle:(path,body)=>desktop.handle(path,body),extension:async(req,res)=>{
 if(await desktop.handleHttp(req,res))return true;
 if(req.method==='GET'&&req.headers.host==='127.0.0.1:18562'&&['/','/fixture'].includes(req.url.split('?')[0])){
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
  res.end(req.url.startsWith('/fixture')?readFileSync(new URL('../../extensions/browser/tests/fixtures/work-page.html',import.meta.url)):'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Nova · M0 验证窗口</title><style>body{background:#101725;color:#e7eef8;font:18px system-ui;padding:24px}textarea{width:95%;height:120px}</style><h1>Nova · M0</h1><p>此窗口用于验证工作页绑定。完整 Bot 文本协作在 M1 接入。</p><label>点击这里测试保留左侧选区：<textarea></textarea></label></html>');return true;
 }return false;
}});
desktop=createDesktop({server,home:config.home,chatUrl:config.url+'/'});
server.listen(18562,'127.0.0.1',()=>console.log('M0 浏览器验证服务：http://127.0.0.1:18562；不启动模型或麦克风。'));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await desktop.close();server.closeAllConnections();server.close();});
