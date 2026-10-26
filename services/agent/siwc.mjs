/** Both model paths load the repository-owned SDK, including its tracked extension. */
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {ROOT} from '../runtime/sources.mjs';

export function siwcModule(root=ROOT) {
  const dist=join(root,'engine/siwc/packages/local/dist');
  if(!['index.js','items.js'].every(file=>existsSync(join(dist,file))))
    throw Object.assign(Error('siwc_build_missing: run pnpm run setup, then pnpm run build'),{code:'siwc_build_missing'});
  return join(dist,'index.js');
}
