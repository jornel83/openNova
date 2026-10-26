/** Resolve source-contained Harness peers through their own package exports. */
import {globSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const catalogs=new Map();
export function peerAnchor(harness,specifier) {
  if(!catalogs.has(harness)){
    const packages=new Map();
    for(const pattern of ['vendor/*/package.json','packages/*/*/package.json','native/system/package.json','native/system/packages/*/package.json','apps/*/package.json']){
      for(const file of globSync(pattern,{cwd:harness})){
        const path=join(harness,file),pkg=JSON.parse(readFileSync(path,'utf8'));
        if(pkg.exports&&pkg.name)packages.set(pkg.name,pathToFileURL(path).href);
      }
    }
    catalogs.set(harness,packages);
  }
  const name=specifier.split('/').slice(0,2).join('/');
  return catalogs.get(harness).get(name)||pathToFileURL(join(harness,'packages/bundle/base/package.json')).href;
}
