import {desktopApi,settings} from './client.mjs';
const probe=process.argv.includes('--probe'),pair=await desktopApi('/desktop/pair',{},probe);
console.log(`服务地址：${settings(probe).url}\n扩展目录：${new URL('../../extensions/browser',import.meta.url).pathname}\n请在扩展设置页输入一次性配对码（60 秒有效）：\n${pair.code}\n长期令牌不会显示。`);
