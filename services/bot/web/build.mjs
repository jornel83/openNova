/** Bundle unchanged upstream UI components from the pinned local dependencies. */
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {dirname,join} from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {ROOT,botSettings} from '../settings.mjs';
import {loadSettings} from '../../agent/settings.mjs';

export async function buildWeb({plugin,harnessRoot,outdir}) {
  const require=createRequire(join(harnessRoot,'packages/client/ui-primitives/package.json'));
  // This version is already installed by the pinned Harness pnpm lockfile.
  const {build}=await import(pathToFileURL(join(harnessRoot,'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js')));
  await mkdir(join(outdir,'assets'),{recursive:true});
  await build({entryPoints:[join(ROOT,'services/bot/web/app.jsx')],outdir:join(outdir,'assets'),
    bundle:true,splitting:true,format:'esm',platform:'browser',target:['es2022','safari17'],jsx:'automatic',
    alias:{'@opennova/ds-bot':join(plugin,'src/client'),
      '@deepseek-ai/dsh-client-ui-primitives':require.resolve('@deepseek-ai/dsh-client-ui-primitives'),
      react:dirname(require.resolve('react/package.json')),'react-dom':dirname(require.resolve('react-dom/package.json'))},
    loader:{'.module.css':'local-css','.woff':'file','.woff2':'file','.ttf':'file','.wasm':'file'},
    define:{'process.env.NODE_ENV':'"production"'},minify:true,charset:'utf8',logLevel:'warning',legalComments:'linked',
  });
  await writeFile(join(outdir,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenNova · 对话</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>');
  await writeFile(join(outdir,'assets','DeepSeek-Bot-LICENSE.txt'),await readFile(join(plugin,'LICENSE')));
}
if(process.argv[1]===import.meta.filename){
  const b=botSettings(),s=loadSettings();
  await buildWeb({plugin:b.plugin,harnessRoot:s.harnessRoot,outdir:join(ROOT,'output/bot/web')});
  console.log('OpenNova 网页资源已构建。');
}
