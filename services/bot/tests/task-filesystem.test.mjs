import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {hasFullFilesystemAccess,resolveTaskPath} from '../tasks/filesystem.mjs';

function fixture(t){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'nova-task-filesystem-'))),workspace=join(root,'workspace'),outside=join(root,'outside');
  mkdirSync(workspace);mkdirSync(outside);mkdirSync(join(workspace,'.git'));
  writeFileSync(join(outside,'report.md'),'external fixture');writeFileSync(join(workspace,'input.md'),'local fixture');
  symlinkSync(outside,join(workspace,'external-link'));symlinkSync(workspace,join(workspace,'local-link'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return {root,workspace,outside,config:{workspace,policyVersion:2,permission:'full',mode:'edit'}};
}

test('current Full Access resolves external absolute, parent, symlink and Git paths without moving the default cwd',t=>{
  const {workspace,outside,config}=fixture(t);assert.equal(hasFullFilesystemAccess(config),true);
  assert.equal(resolveTaskPath(config,join(outside,'report.md')),join(outside,'report.md'));
  assert.equal(resolveTaskPath(config,'../outside/report.md'),join(outside,'report.md'));
  assert.equal(resolveTaskPath(config,'external-link/report.md'),join(workspace,'external-link/report.md'));
  assert.equal(resolveTaskPath(config,'.git/config'),join(workspace,'.git/config'));
  assert.equal(resolveTaskPath(config,join(outside,'new','result.md')),join(outside,'new','result.md'),'write targets need not exist');
  assert.equal(resolveTaskPath(config,'.',{directory:true}),workspace);
  assert.equal(resolveTaskPath(config,outside,{directory:true}),outside);
  assert.equal(resolveTaskPath(config,'external-link',{directory:true}),join(workspace,'external-link'));
  assert.equal(config.workspace,workspace,'access scope does not replace the independent default cwd');
});

test('read-only, legacy, missing permission and supervisor review keep their existing task boundary',t=>{
  const {workspace,outside,config}=fixture(t);
  for(const patch of [{permission:'read-only',mode:'analysis'},{policyVersion:1},{policyVersion:undefined},{permission:undefined},{managementReview:{targetTaskId:'employee'}}]){
    const scoped={...config,...patch};assert.equal(hasFullFilesystemAccess(scoped),false);
    for(const path of [join(outside,'report.md'),'../outside/report.md','external-link/report.md','.git/config'])assert.throws(()=>resolveTaskPath(scoped,path),/outside_task_workspace/,JSON.stringify(patch)+' '+path);
    assert.equal(resolveTaskPath(scoped,'input.md'),join(workspace,'input.md'));
    assert.equal(resolveTaskPath(scoped,'new/result.md'),join(workspace,'new/result.md'));
    assert.equal(resolveTaskPath(scoped,'local-link/input.md'),join(workspace,'local-link/input.md'));
  }
});

test('Full Access preserves path validation and only existing directories can be command working directories',t=>{
  const {config,outside}=fixture(t);
  for(const value of [undefined,null,0,{},'', '\0', 'a\0b'])assert.throws(()=>resolveTaskPath(config,value),/invalid_file_path/);
  for(const path of [join(outside,'report.md'),join(outside,'missing')])assert.throws(()=>resolveTaskPath(config,path,{directory:true}),/invalid_task_workdir/);
  assert.equal(resolveTaskPath(config,'/',{directory:true}),'/','host root access is subject to the current OS account, without escalation');
});
