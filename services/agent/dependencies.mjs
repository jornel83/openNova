/** Harness source version belongs to the superproject gitlink, not a second pin. */
import {execFileSync} from 'node:child_process';
import {readFileSync,existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
export const HARNESS_FILES=['apps/cli/lib/bin.js','packages/sdk/client/lib/index.js','packages/llm/llm/lib/index.js'];

export function harnessDependency(root=ROOT){
  const spec=JSON.parse(readFileSync(join(root,'config/runtime-versions.json'),'utf8')).harness;
  const entries=git(root,'ls-files','--stage','--',spec.path).split('\n');
  const match=entries.length===1&&entries[0].match(/^160000 ([a-f0-9]{40}) 0\t(.+)$/);
  if(!match||match[2]!==spec.path)throw Error('harness_gitlink_missing: initialize a Git checkout with its pinned submodule');
  return {...spec,revision:match[1]};
}

export function assertHarnessReady(harnessRoot,root=ROOT){
  const spec=harnessDependency(root);
  if(!existsSync(join(harnessRoot,'.git'))||realpathSync(git(harnessRoot,'rev-parse','--show-toplevel'))!==realpathSync(harnessRoot)){
    throw Error('harness_not_initialized: run python3.11 tools/setup/bootstrap.py --install');
  }
  if(git(harnessRoot,'rev-parse','HEAD')!==spec.revision)throw Error('harness_revision_mismatch');
  if(!HARNESS_FILES.every(file=>existsSync(join(harnessRoot,file))))throw Error('harness_build_missing');
  let receipt;
  try{receipt=JSON.parse(readFileSync(join(root,'output/deps/harness-build.json'),'utf8'));}catch{}
  if(receipt?.root!==realpathSync(harnessRoot)||receipt?.revision!==spec.revision||receipt?.pnpm!==spec.pnpm){
    throw Error('harness_build_stale: run python3.11 tools/setup/bootstrap.py --install');
  }
  return spec;
}
