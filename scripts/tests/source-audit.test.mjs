import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {auditSourceTree} from '../source-audit.mjs';

function fixture(t){const root=mkdtempSync(join(tmpdir(),'nova source audit '));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'services'));return root;}
test('source export accepts internal links and public/installable dependencies without Git',t=>{
  const root=fixture(t);writeFileSync(join(root,'services/code.mjs'),'export {};');
  symlinkSync('code.mjs',join(root,'services/alias.mjs'));
  writeFileSync(join(root,'package.json'),JSON.stringify({dependencies:{local:'file:services',public:'^1.0.0',workspace:'workspace:*'}}));
  const result=auditSourceTree(root);assert.equal(result.symlinks,1);assert.equal(result.localDependencies,1);
});
test('source audit rejects external and dangling links but excludes installed dependencies',t=>{
  const root=fixture(t);mkdirSync(join(root,'node_modules'));symlinkSync('/missing',join(root,'node_modules/installed'));
  auditSourceTree(root);
  symlinkSync(tmpdir(),join(root,'services/external'));
  assert.throws(()=>auditSourceTree(root),/external_source_symlink/);
  rmSync(join(root,'services/external'));symlinkSync('missing',join(root,'services/dangling'));
  assert.throws(()=>auditSourceTree(root),/broken_source_symlink/);
});
test('declared package dependencies cannot point to sibling checkouts',t=>{
  const root=fixture(t);writeFileSync(join(root,'package.json'),JSON.stringify({pnpm:{overrides:{dependency:'link:../foreign'}}}));
  assert.throws(()=>auditSourceTree(root),/external_local_dependency/);
});
test('nested repositories or submodules are not standalone source',t=>{
  const root=fixture(t);writeFileSync(join(root,'services/.git'),'gitdir: /external/git');
  assert.throws(()=>auditSourceTree(root),/embedded_repository/);
});
test('pnpm workspace local overrides must also stay inside the source export',t=>{
  const root=fixture(t);writeFileSync(join(root,'pnpm-workspace.yaml'),"overrides:\n  dep: 'link:../foreign'\n");
  assert.throws(()=>auditSourceTree(root),/external_local_dependency/);
});
test('local declarations canonicalize symlinks even in excluded dependency directories',t=>{
  const root=fixture(t);mkdirSync(join(root,'node_modules'));symlinkSync(tmpdir(),join(root,'node_modules/external-code'));
  writeFileSync(join(root,'package.json'),JSON.stringify({dependencies:{external:'file:node_modules/external-code'}}));
  assert.throws(()=>auditSourceTree(root),/external_local_dependency/);
});
test('relative workspace dependencies cannot select a sibling checkout',t=>{
  const root=fixture(t);writeFileSync(join(root,'package.json'),JSON.stringify({dependencies:{external:'workspace:../foreign'}}));
  assert.throws(()=>auditSourceTree(root),/external_local_dependency/);
});
test('workspace package selectors reject external roots in both manifest formats',t=>{
  const root=fixture(t);writeFileSync(join(root,'pnpm-workspace.yaml'),"packages: ['../foreign']\n");
  assert.throws(()=>auditSourceTree(root),/external_workspace_package/);
  rmSync(join(root,'pnpm-workspace.yaml'));writeFileSync(join(root,'package.json'),JSON.stringify({workspaces:['../foreign']}));
  assert.throws(()=>auditSourceTree(root),/external_workspace_package/);
});
test('YAML aliases and quoted paths are parsed before checking their boundaries',t=>{
  const root=fixture(t);writeFileSync(join(root,'pnpm-workspace.yaml'),'outside: &path "../foreign"\npackages: [*path]\n');
  assert.throws(()=>auditSourceTree(root),/external_workspace_package/);
});
