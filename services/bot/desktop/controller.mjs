import {randomUUID} from 'node:crypto';
import {createWorkContext} from './context.mjs';
import {createBrowserBridge} from './browser.mjs';
export function createDesktop(options){
 const context=createWorkContext();
 const bridge=createBrowserBridge({...options,onContext:(value,flags)=>{context.updateBrowser(value,flags);options.onContext?.(value,flags);}});
 return {...bridge,async handle(path,body){
  if(path==='/desktop/context')return context.snapshot();
  if(path==='/desktop/pair')return bridge.pairing();
  if(path==='/desktop/status')return {...bridge.status(),context:context.snapshot()};
  if(path==='/desktop/windows')return bridge.ensureWindows({chatUrl:options.chatUrl,...body});
  if(path==='/desktop/read'||path==='/desktop/open')return bridge.execute({id:body.id||randomUUID(),method:path.slice('/desktop/'.length),page:body.page,args:body,deadlineAt:Date.now()+15000});
  throw Error('unknown_desktop_route');
 }};
}
