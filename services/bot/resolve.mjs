// Resolve the pinned external plugin's peers from the actual Harness installation.
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const root=process.env.OPENNOVA_BOT_PLUGIN,harness=process.env.OPENNOVA_HARNESS_ROOT;
if(!root||!harness)throw Error('bot_resolver_configuration_missing');
registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('@deepseek-ai/')&&context.parentURL?.startsWith(pathToFileURL(root).href+'/'))
    return next(specifier,{...context,parentURL:pathToFileURL(join(harness,'packages/bundle/base/package.json')).href});
  return next(specifier,context);
}});
