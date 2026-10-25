import {homedir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const BOT_REV='20ebc9213cbbde7249d71786765f86be00dc6663';
export const HARNESS_REV='bf89008192b279f9928aa4578aed183a7547a9d2';
export function botSettings(env=process.env) {
  const home=resolve(env.OPENNOVA_BOT_HOME||join(homedir(),'.local/share/opennova/bot-spike'));
  const port=Number(env.OPENNOVA_BOT_PORT||18560),webPort=Number(env.OPENNOVA_BOT_WEB_PORT||18561);
  if(![port,webPort].every(n=>Number.isInteger(n)&&n>1024&&n<65536)||port===webPort)throw Error('invalid_bot_ports');
  return {home,port,webPort,workspace:ROOT,legacyWorkspace:join(home,'project'),tokenPath:join(home,'client.token'),
    plugin:join(ROOT,'output/deps/deepseek-bot',BOT_REV,'ds-bot'),url:`http://127.0.0.1:${port}`};
}
