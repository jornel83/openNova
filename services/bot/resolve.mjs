// Bot and its tests share the included Harness package instances.
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {peerAnchor} from '../runtime/peers.mjs';
const root=process.env.OPENNOVA_BOT_PLUGIN,harness=process.env.OPENNOVA_HARNESS_ROOT;
if(!root||!harness)throw Error('bot_resolver_configuration_missing');
registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('@deepseek-ai/')&&context.parentURL?.startsWith(pathToFileURL(root).href+'/'))
    return next(specifier,{...context,parentURL:peerAnchor(harness,specifier)});
  return next(specifier,context);
}});
