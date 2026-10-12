import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';

export function toolsModule(root=fileURLToPath(new URL('../../',import.meta.url))) {
  const revision=JSON.parse(readFileSync(join(root,'config/runtime-versions.json'),'utf8')).siwc.revision;
  const hash=createHash('sha256').update(readFileSync(join(root,'patches/siwc/0001-stream-items.patch'))).digest('hex');
  const directory=resolve(root,'output/deps/siwc',`${revision.slice(0,12)}-${hash.slice(0,12)}`);
  try {
    const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
    if(manifest.revision!==revision||manifest.patch_sha256!==hash||!existsSync(join(directory,'packages/local/dist/items.js')))throw Error();
    return join(directory,'packages/local/dist/index.js');
  } catch {throw new Error('siwc_tools_extension_missing');}
}
