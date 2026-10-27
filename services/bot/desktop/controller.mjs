import {randomUUID} from 'node:crypto';
import {createWorkContext} from './context.mjs';
import {createBrowserBridge} from './browser.mjs';
export function createDesktop(options){
 const context=options.context||createWorkContext();
 const bridge=createBrowserBridge({...options,onContext:(value,flags)=>{context.updateBrowser(value,flags);options.onContext?.(value,flags);}});
 return {...bridge,context,async handle(path,body){
  if(path==='/desktop/chat')return bridge.execute({id:randomUUID(),method:'chat.show',args:{},deadlineAt:Date.now()+15000});
  if(path==='/desktop/context')return context.snapshot();
  if(path==='/desktop/pair')return bridge.pairing();
  if(path==='/desktop/status')return {...bridge.status(),context:context.snapshot()};
  if(path==='/desktop/windows'||path==='/desktop/open'&&!Object.hasOwn(body,'url'))return bridge.ensureWindows({...body,chatUrl:options.chatUrl,activate:body.activate===true});
  if(['read','open','click','fill','scroll','close'].some(method=>path==='/desktop/'+method))return bridge.execute({id:body.id||randomUUID(),method:path.slice('/desktop/'.length),page:body.page,args:body,deadlineAt:Date.now()+15000});
  throw Error('unknown_desktop_route');
 }};
}
