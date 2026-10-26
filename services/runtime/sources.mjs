/** Repository-owned runtime source locations; never consult machine checkout paths. */
import {readFileSync,existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');

export function runtimeSources(root=ROOT) {
  let manifest;
  try {
    manifest=JSON.parse(readFileSync(join(root,'upstream.lock.json'),'utf8'));
    const {harness,bot}=manifest.components;
    if(manifest.schemaVersion!==1||harness.path!=='engine/harness'||bot.path!=='engine/bot'||bot.packagePath!=='ds-bot'
      ||![harness,bot].every(c=>/^[0-9a-f]{40}$/.test(c.revision)&&typeof c.version==='string'))throw Error();
  }catch {throw Error('invalid_engine_manifest: restore upstream.lock.json from the OpenNova source distribution');}
  return {root:resolve(root),manifest,harnessRoot:resolve(root,'engine/harness'),botRoot:resolve(root,'engine/bot/ds-bot')};
}

export function checkEngineSources(root=ROOT) {
  const sources=runtimeSources(root);
  for(const [id,path,name] of [['harness',sources.harnessRoot,'@deepseek-ai/dsh-root'],['bot',sources.botRoot,'ds-bot']]) {
    let pkg;
    try{pkg=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));}
    catch{throw Error(`bundled_${id}_source_missing: use a complete OpenNova checkout or source archive`);}
    if(pkg.name!==name||pkg.version!==sources.manifest.components[id].version)throw Error(`bundled_${id}_version_mismatch`);
    if(!existsSync(join(path,'LICENSE')))throw Error(`bundled_${id}_license_missing`);
  }
  return sources;
}

export function requireBuiltHarness(root=ROOT) {
  const sources=checkEngineSources(root);
  for(const entry of ['apps/cli/lib/bin.js','packages/sdk/client/lib/index.js','packages/llm/llm/lib/index.js']) {
    if(!existsSync(join(sources.harnessRoot,entry)))throw Error('harness_build_missing: run pnpm setup and pnpm build in OpenNova');
  }
  return sources;
}
