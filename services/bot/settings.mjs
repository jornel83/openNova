import {homedir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runtimeSources} from '../runtime/sources.mjs';
import {runtimePaths,writableRuntimePath} from '../runtime/paths.mjs';
export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const BOT_REV=runtimeSources().manifest.components.bot.revision;
export const HARNESS_REV=runtimeSources().manifest.components.harness.revision;
export function botSettings(env=process.env) {
  const paths=runtimePaths(env),home=paths.botHome;
  const port=Number(env.OPENNOVA_BOT_PORT||18560),webPort=Number(env.OPENNOVA_BOT_WEB_PORT||18561);
  if(![port,webPort].every(n=>Number.isInteger(n)&&n>1024&&n<65536)||port===webPort)throw Error('invalid_bot_ports');
  const replyMode=env.OPENNOVA_REPLY_MODE||'streaming';
  if(!['streaming','settled'].includes(replyMode))throw Error('invalid_reply_mode');
  const credentialRoot=paths.packaged?join(paths.dataRoot,'config'):join(homedir(),'.config/opennova');
  return {home,port,webPort,replyMode,videoKeyPath:writableRuntimePath(env.OPENNOVA_ARK_KEY_FILE||join(credentialRoot,'ark.key'),env),githubTokenPath:writableRuntimePath(env.OPENNOVA_GITHUB_TOKEN_FILE||join(credentialRoot,'github.token'),env),workspace:paths.workspace,legacyWorkspace:join(home,'project'),tokenPath:join(home,'client.token'),
    plugin:runtimeSources().botRoot,url:`http://127.0.0.1:${port}`};
}
