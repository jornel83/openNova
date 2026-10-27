import {installNativeResearch} from './native-runtime.mjs';
import {installResearch as installLegacyResearch} from './legacy-runtime.mjs';
/** Native execution is the default; legacy is an explicit rollback only. */
export function installResearch(ctx,options){
 return options.config?.mode==='legacy'?installLegacyResearch(ctx,options):installNativeResearch(ctx,options);
}
