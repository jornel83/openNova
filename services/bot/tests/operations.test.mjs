import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Operations} from '../operations.mjs';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'nova-bot-test-')), workspace=join(root,'workspace');
  mkdirSync(workspace);writeFileSync(join(workspace,'brief.md'),'before\n');
  const open=()=>new Operations({home:join(root,'data'),workspace});
  let ops=open();t.after(()=>{ops.close();rmSync(root,{recursive:true,force:true});});
  return {workspace,get ops(){return ops;},restart(){ops.close();ops=open();return ops;}};
}
test('file proposals wait for confirmation, survive restart and apply only once',t=>{
  const f=fixture(t),p=f.ops.proposeFile('brief.md','after\n');
  assert.equal(readFileSync(join(f.workspace,'brief.md'),'utf8'),'before\n');
  assert.match(p.diff,/-before/);assert.match(p.diff,/\+after/);
  f.restart().approveFile(p.id);
  assert.equal(readFileSync(join(f.workspace,'brief.md'),'utf8'),'after\n');
  writeFileSync(join(f.workspace,'brief.md'),'user edit\n');
  assert.equal(f.ops.approveFile(p.id).status,'applied');
  assert.equal(f.ops.readFile('brief.md'),'user edit\n');
});
test('concurrent edit is a conflict, including restart',t=>{
  const f=fixture(t),p=f.ops.proposeFile('brief.md','after');
  writeFileSync(join(f.workspace,'brief.md'),'changed');
  assert.throws(()=>f.restart().approveFile(p.id),/file_conflict/);
  assert.equal(f.ops.readFile('brief.md'),'changed');
});
test('directory traversal, symlinks and oversize writes are refused',t=>{
  const f=fixture(t);symlinkSync('/tmp',join(f.workspace,'escape'));
  for(const name of ['../outside','/tmp/out','escape/out'])assert.throws(()=>f.ops.proposeFile(name,'x'),/workspace|path/);
  assert.throws(()=>f.ops.proposeFile('big.md','x'.repeat(65537)),/too_large/);
});
test('controlled task survives reopen and explicit cancellation persists',t=>{
  const f=fixture(t),task=f.ops.startTask('test',1000,100);
  assert.equal(f.restart().task(task.id,500).status,'running');
  assert.equal(f.ops.task(task.id,1100).status,'completed');
  const other=f.ops.startTask('cancel',1000,100);
  assert.equal(f.ops.cancelTask(other.id,500).status,'cancelled');
  assert.equal(f.restart().task(other.id,9999).status,'cancelled');
});
test('request identity is durable and never aliases different input',t=>{
  const f=fixture(t);f.ops.submit('req-one','hello','voice');
  assert.equal(f.restart().submit('req-one','hello','voice').duplicate,true);
  assert.throws(()=>f.ops.submit('req-one','different','voice'),/request_conflict/);
  f.ops.finish('req-one',{status:'completed',text:'world'});
  assert.equal(f.restart().request('req-one').text,'world');
});
test('edit after applying intent but before final rename is preserved',t=>{
  const f=fixture(t),p=f.ops.proposeFile('brief.md','after'),put=f.ops.put.bind(f.ops);
  f.ops.put=r=>{const value=put(r);if(r.status==='applying')writeFileSync(join(f.workspace,'brief.md'),'late edit');return value;};
  assert.throws(()=>f.ops.approveFile(p.id),/file_conflict/);
  assert.equal(f.ops.readFile('brief.md'),'late edit');
});
test('retirement history and unfinished recovery do not silently stop at 200 records',t=>{
  const f=fixture(t);for(let i=0;i<205;i++)f.ops.retireMemory('fact-'+i,['id-'+i]);
  assert.equal(f.restart().retired().length,205);
});

test('direct file edits are already saved when the tool returns and retain an audit diff',t=>{
  const f=fixture(t),result=f.ops.writeFile('brief.md','直接执行成功\n');
  assert.equal(readFileSync(join(f.workspace,'brief.md'),'utf8'),'直接执行成功\n');
  assert.equal(result.status,'applied');assert.equal(result.executionMode,'direct');
  assert.match(result.diff,/-before/);assert.match(result.diff,/\+直接执行成功/);
  assert.equal(f.restart().get(result.id).status,'applied');
});

test('restart recovers an interrupted direct write without executing historical manual proposals',t=>{
  const f=fixture(t),old=f.ops.proposeFile('brief.md','old proposal');
  const direct=f.ops.proposeFile('new.md','direct result','direct');
  f.restart().recoverDirectFiles();
  assert.equal(f.ops.readFile('new.md'),'direct result');
  assert.equal(f.ops.get(direct.id).status,'applied');
  assert.equal(f.ops.get(old.id).status,'pending');
  assert.equal(f.ops.readFile('brief.md'),'before\n');
});
