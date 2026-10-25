import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {desktopApi} from './client.mjs';

export async function openChrome(url,{signal,root,env=process.env}={}){
 signal?.throwIfAborted();
 const executable=env.OPENNOVA_BROWSER_EXECUTABLE,profile=env.OPENNOVA_BROWSER_USER_DATA_DIR;
 if(executable||profile){
  if(!executable||!profile)throw Error('需要同时设置 OPENNOVA_BROWSER_EXECUTABLE 和 OPENNOVA_BROWSER_USER_DATA_DIR');
  // Pairing belongs to a browser profile. Keep that profile across restarts;
  // never silently open daily Chrome when the configured browser is missing.
  const extension=join(root,'extensions/browser');
  return new Promise((resolve,reject)=>{
   const child=spawn(executable,['--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,`--load-extension=${extension}`,`--disable-extensions-except=${extension}`,...(url?[url]:['--no-startup-window'])],{stdio:'ignore',detached:true});
   child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});
  });
 }
 return new Promise((resolve,reject)=>{
  const child=spawn('/usr/bin/open',['-a','Google Chrome',...(url?[url]:[])],{stdio:'ignore',signal});
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('chrome_launch_failed')));
 });
}

/** Window creation belongs to the paired extension; the launcher never moves native apps. */
export async function prepareDesktop({config,root,health,signal,log,env=process.env,openBrowser=url=>openChrome(url,{signal,root,env}),waitMs=8000}){
 const call=(path,body={})=>desktopApi(path,body,false,{config,signal});
 const url=config.url+'/',marker=join(config.home,'ui-fallback.json');
 log('检查浏览器扩展与双窗口……');
 let state;
 try{state=await call('/desktop/status');}
 catch{signal?.throwIfAborted();log('当前 Bot 尚未启用浏览器接入；请结束当前任务后 tools/bot/run.command --stop，再用 start.command --ui 启动。');}
 if(state&&!state.connected){
  try{await openBrowser();}catch{signal?.throwIfAborted();log('未能自动打开已配置的浏览器，请检查浏览器路径、配置目录，或手动打开已配对的浏览器。');}
  const deadline=Date.now()+waitMs;
  while(!state.connected&&Date.now()<deadline){
   await delay(Math.min(300,waitMs),undefined,{signal});
   state=await call('/desktop/status');
  }
 }
 if(state?.connected){
  const result=await call('/desktop/open');
  if(result.status==='completed'){log(`工作窗口和 Nova 对话窗口已就绪：${url}`);return result;}
  // Delivery may have succeeded. Do not open a second chat after an ambiguous reply.
  if(result.status==='unknown'){log(`开窗回执未确认，请查看 Chrome。可重新运行 --ui 补齐窗口；文字入口：${url}`);return result;}
  log('浏览器开窗未完成，暂用文字入口；扩展连接恢复后可点击「打开工作窗口」。');
 }
 if(state&&!state.paired){
  log(`首次使用：在 Chrome 的 chrome://extensions 开启开发者模式，加载已解压的扩展：${join(root,'extensions/browser')}。`);
  try{const pairing=await call('/desktop/pair');log(`扩展设置：服务地址 ${config.url}；一次性配对码 ${pairing.code}（60 秒有效）。`);}
  catch{signal?.throwIfAborted();}
  log('配对码过期可运行 tools/desktop/setup.mjs 重新生成（使用与启动器相同的 OPENNOVA_BOT_HOME / PORT 设置）。');
 }else if(state)log('扩展尚未连接，请检查 Chrome 中 OpenNova 扩展的服务地址和配对状态。');
 // Repeated degraded launches should not accumulate fallback tabs. A new Bot boot
 // may open a fresh entry; manually closed tabs can be reopened using the printed URL.
 let previous;try{previous=JSON.parse(readFileSync(marker,'utf8'));}catch{}
 const boot=health.runtimeId||health.sessionId;
 if(!boot||previous?.boot!==boot){
  try{await openBrowser(url);writeFileSync(marker,JSON.stringify({boot,url}),{mode:0o600});}
  catch{signal?.throwIfAborted();log('请在浏览器手动打开下方文字入口。');}
 }
 log(`文字对话与本地文件仍可使用：${url}；网页协作待扩展连接后恢复。`);
 return {status:'degraded'};
}
