/** Content-based build freshness also works in a source archive without .git. */
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,lstatSync,readlinkSync,realpathSync,existsSync,mkdirSync,writeFileSync,globSync} from 'node:fs';
import {join,relative,dirname,sep} from 'node:path';
import {ROOT,runtimeSources} from '../services/runtime/sources.mjs';

const roots=['engine/harness','engine/bot/ds-bot','engine/siwc','services','scripts','tools','skills','config','patches','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','upstream.lock.json'];
const ignored=new Set(['node_modules','.git','lib','dist','output','target','coverage','.superpowers','__pycache__','.pytest_cache','.dsh-build','.cache']);
const recordPath=root=>join(root,'output/build/manifest.json');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

export function sourceDigest(root=ROOT) {
  const digest=createHash('sha256'),realRoot=realpathSync(root);
  function visit(path) {
    const name=path.split(/[\\/]/).at(-1);
    if(ignored.has(name)||name.endsWith('.tsbuildinfo')||name.endsWith('.local.json')||name==='.DS_Store'||name.startsWith('.env')||!existsSync(path))return;
    const stat=lstatSync(path),label=relative(root,path).replaceAll('\\','/');
    if(stat.isDirectory()){for(const child of readdirSync(path).sort())visit(join(path,child));}
    else if(stat.isFile())digest.update(label+'\0').update(readFileSync(path)).update('\0');
    else if(stat.isSymbolicLink()){
      if(!realpathSync(path).startsWith(realRoot+sep))throw Error('external_source_symlink: '+label);
      digest.update(label+'\0link\0'+readlinkSync(path)+'\0');
    }
  }
  for(const path of roots)visit(join(root,path));
  return digest.digest('hex');
}

export const BUILD_ARTIFACTS=[
  'engine/harness/apps/cli/lib/bin.js','engine/harness/packages/sdk/client/lib/index.js',
  'engine/harness/packages/llm/llm/lib/index.js','engine/bot/ds-bot/client.js',
  'engine/siwc/packages/local/dist/index.js','engine/siwc/packages/local/dist/items.js',
  'output/bot/web/index.html','output/bot/web/assets/app.js','output/bot/web/assets/app.css',
];

export function buildArtifacts(root=ROOT) {
  const files=new Set(BUILD_ARTIFACTS);
  if(process.platform==='darwin')files.add('output/bin/siwc-keychain');
  for(const pattern of ['engine/harness/apps/*/{lib,dist}/**/*','engine/harness/packages/*/*/lib/**/*',
    'engine/harness/vendor/*/lib/**/*','engine/harness/native/system/packages/*/{lib,prebuilds}/**/*',
    'engine/harness/native/system/packages/*/*.node','output/bot/web/**/*','engine/siwc/packages/local/dist/**/*']) {
    for(const path of globSync(pattern,{cwd:root}))if(lstatSync(join(root,path)).isFile())files.add(path);
  }
  return [...files].sort();
}

export function recordBuild(root=ROOT,artifacts=buildArtifacts(root)) {
  const sources=runtimeSources(root),record={schemaVersion:1,sourceDigest:sourceDigest(root),
    upstream:{harness:sources.manifest.components.harness.revision,bot:sources.manifest.components.bot.revision,siwc:sources.manifest.components.siwc.revision},
    nodeMajor:Number(process.versions.node.split('.')[0]),
    artifacts:Object.fromEntries(artifacts.map(path=>[path,hash(readFileSync(join(root,path)))]))};
  mkdirSync(dirname(recordPath(root)),{recursive:true});writeFileSync(recordPath(root),JSON.stringify(record,null,2)+'\n');
  return record;
}

export function checkBuild(root=ROOT) {
  try {
    const record=JSON.parse(readFileSync(recordPath(root),'utf8'));
    if(record.schemaVersion!==1||record.nodeMajor!==Number(process.versions.node.split('.')[0])||record.sourceDigest!==sourceDigest(root))return {ready:false,reason:'source_or_runtime_changed'};
    if(!Object.keys(record.artifacts).length||Object.entries(record.artifacts).some(([path,digest])=>hash(readFileSync(join(root,path)))!==digest))return {ready:false,reason:'artifacts_changed'};
    return {ready:true,sourceDigest:record.sourceDigest,upstream:record.upstream};
  }catch{return {ready:false,reason:'build_missing_or_incomplete'};}
}
