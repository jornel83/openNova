import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {harnessDependency,assertHarnessReady} from '../dependencies.mjs';
const sha='a'.repeat(40);
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'opennova-dependency-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const git=(...a)=>execFileSync('git',['-C',root,...a],{encoding:'utf8'}).trim();
 git('init','-q');mkdirSync(join(root,'config'));
 writeFileSync(join(root,'config/runtime-versions.json'),JSON.stringify({harness:{path:'third_party/deepseek-harness',url:'git@example.invalid:harness.git',pnpm:'11.28.5'}}));
 return {root,git};
}
test('version comes from the staged gitlink, not a second SHA constant',t=>{
 const {root,git}=fixture(t);git('update-index','--add','--cacheinfo',`160000,${sha},third_party/deepseek-harness`);
 assert.equal(harnessDependency(root).revision,sha);
 const next='b'.repeat(40);git('update-index','--cacheinfo',`160000,${next},third_party/deepseek-harness`);
 assert.equal(harnessDependency(root).revision,next);
});
test('missing or non-submodule entries cannot become a runtime dependency',t=>{
 const {root,git}=fixture(t);
 assert.throws(()=>harnessDependency(root),/harness_gitlink_missing/);
 const blob=git('hash-object','-w','--stdin');git('update-index','--add','--cacheinfo',`100644,${blob},third_party/deepseek-harness`);
 assert.throws(()=>harnessDependency(root),/harness_gitlink_missing/);
});
test('runtime rejects an empty directory resolving to its parent repository',t=>{
 const {root,git}=fixture(t);git('update-index','--add','--cacheinfo',`160000,${sha},third_party/deepseek-harness`);
 const checkout=join(root,'third_party/deepseek-harness');mkdirSync(checkout,{recursive:true});
 assert.throws(()=>assertHarnessReady(checkout,root),/harness_not_initialized/);
});
test('runtime rejects stale build receipts even when lib files exist',t=>{
 const {root,git}=fixture(t),checkout=join(root,'third_party/deepseek-harness');mkdirSync(checkout,{recursive:true});
 const sub=(...a)=>execFileSync('git',['-C',checkout,...a],{encoding:'utf8'}).trim();
 sub('init','-q');sub('-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','initial');
 const revision=sub('rev-parse','HEAD');git('update-index','--add','--cacheinfo',`160000,${revision},third_party/deepseek-harness`);
 for(const file of ['apps/cli/lib/bin.js','packages/sdk/client/lib/index.js','packages/llm/llm/lib/index.js']){
  const path=join(checkout,file);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,'');
 }
 mkdirSync(join(root,'output/deps'),{recursive:true});
 const receipt=join(root,'output/deps/harness-build.json');
 writeFileSync(receipt,JSON.stringify({root:realpathSync(checkout),revision:sha,pnpm:'11.28.5'}));
 assert.throws(()=>assertHarnessReady(checkout,root),/harness_build_stale/);
 writeFileSync(receipt,JSON.stringify({root:realpathSync(checkout),revision,pnpm:'11.28.5'}));
 assert.equal(assertHarnessReady(checkout,root).revision,revision);
});
