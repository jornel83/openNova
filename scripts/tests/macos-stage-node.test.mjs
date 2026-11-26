import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,existsSync,mkdtempSync,mkdirSync,readlinkSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {stageNode} from '../macos/stage-node.mjs';

function fixture(t){
  const base=mkdtempSync(join(tmpdir(),'Nova node staging 中文 ')),source=join(base,'source'),target=join(base,'OpenNova.app/Contents/Resources/app');
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const pkg=(path,data,body='module.exports = "fixture";')=>{
    mkdirSync(join(source,path),{recursive:true});
    writeFileSync(join(source,path,'package.json'),JSON.stringify(data));writeFileSync(join(source,path,'index.js'),body);
  };
  const link=(from,to)=>{mkdirSync(dirname(join(source,from)),{recursive:true});symlinkSync(relative(dirname(join(source,from)),join(source,to)),join(source,from));};
  pkg('engine/harness/apps/cli',{name:'cli',dependencies:{'peer-plugin':'workspace:*'},devDependencies:{electron:'1'}});
  pkg('engine/harness/packages/core/plugin',{name:'peer-plugin',peerDependencies:{transitive:'1'},optionalDependencies:{'other-platform':'1'}},'module.exports = require("transitive");');
  pkg('engine/harness/node_modules/.pnpm/transitive@1/node_modules/transitive',{name:'transitive',version:'1.0.0'},'module.exports = "staged runtime";');
  link('engine/harness/apps/cli/node_modules/peer-plugin','engine/harness/packages/core/plugin');
  link('engine/harness/packages/core/plugin/node_modules/transitive','engine/harness/node_modules/.pnpm/transitive@1/node_modules/transitive');
  cpSync(source,target,{recursive:true,filter:path=>!path.split('/').includes('node_modules')});
  return {base,source,target,pkg,link};
}

test('stages workspace peers and pnpm packages with relocatable links and no root developer tools',t=>{
  const {source,target}=fixture(t),report=stageNode({source,target});
  assert.equal(report.workspacePackages,2);assert.equal(report.packages,1);assert.equal(report.skippedOptional[0].dependency,'other-platform');
  const stagedRequire=createRequire(join(target,'engine/harness/apps/cli/package.json'));
  assert.equal(stagedRequire('peer-plugin'),'staged runtime');
  const path='engine/harness/apps/cli/node_modules/peer-plugin';
  assert.equal(readlinkSync(join(source,path)),readlinkSync(join(target,path)));
  assert.ok(realpathSync(join(target,path)).startsWith(realpathSync(target)));
  assert.equal(existsSync(join(target,'engine/harness/node_modules/electron')),false);
});

test('missing required production dependency fails without changing source',t=>{
  const {source,target}=fixture(t);
  rmSync(join(source,'engine/harness/packages/core/plugin/node_modules/transitive'));
  assert.throws(()=>stageNode({source,target}),/installed_dependency_missing: peer-plugin -> transitive/);
  assert.equal(existsSync(join(source,'engine/harness/packages/core/plugin/node_modules/transitive')),false);
});

test('external absolute links cannot make a deployment depend on the build machine',t=>{
  const {source,target,base}=fixture(t);
  const external=join(base,'external');mkdirSync(external);mkdirSync(join(source,'node_modules'));
  symlinkSync(external,join(source,'node_modules/escaped'));
  assert.throws(()=>stageNode({source,target}),/absolute_dependency_symlink/);
});

test('dangling installed links are rejected instead of shipping an incomplete runtime',t=>{
  const {source,target}=fixture(t);
  mkdirSync(join(source,'node_modules'));symlinkSync('missing-package',join(source,'node_modules/broken'));
  assert.throws(()=>stageNode({source,target}),/broken_dependency_symlink/);
});

test('shared dynamic loaders retain selected pnpm hoisted platform packages without hoisting developer dependencies',t=>{
  const {source,target,pkg,link}=fixture(t);
  const store='engine/harness/node_modules/.pnpm';
  pkg('engine/harness/packages/core/plugin',{name:'peer-plugin',dependencies:{'shared-loader':'1'},optionalDependencies:{'platform-addon':'1'}},'module.exports = require("shared-loader").load("platform-addon");');
  pkg(store+'/shared-loader@1/node_modules/shared-loader',{name:'shared-loader',version:'1.0.0'},'exports.load = name => require(name);');
  pkg(store+'/platform-addon@1/node_modules/platform-addon',{name:'platform-addon',version:'1.0.0'},'module.exports = "native platform found";');
  pkg(store+'/developer-tool@1/node_modules/developer-tool',{name:'developer-tool',version:'1.0.0'});
  link('engine/harness/packages/core/plugin/node_modules/shared-loader',store+'/shared-loader@1/node_modules/shared-loader');
  link('engine/harness/packages/core/plugin/node_modules/platform-addon',store+'/platform-addon@1/node_modules/platform-addon');
  link(store+'/node_modules/platform-addon',store+'/platform-addon@1/node_modules/platform-addon');
  link(store+'/node_modules/developer-tool',store+'/developer-tool@1/node_modules/developer-tool');
  cpSync(join(source,'engine/harness/packages/core/plugin'),join(target,'engine/harness/packages/core/plugin'),{recursive:true,filter:path=>!path.split('/').includes('node_modules')});
  const report=stageNode({source,target});
  assert.equal(report.hoistedAliases,1);
  const require=createRequire(join(target,'engine/harness/apps/cli/package.json'));
  assert.equal(require('peer-plugin'),'native platform found');
  assert.equal(existsSync(join(target,store,'node_modules/developer-tool')),false);
});
