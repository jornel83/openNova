import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,symlinkSync,linkSync,renameSync,statSync,realpathSync,chmodSync,openSync,closeSync,readlinkSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {spawnSync} from 'node:child_process';
import {ROOT} from '../../services/runtime/sources.mjs';
import {tryLockExclusive} from '../../engine/harness/native/system/packages/entry/lib/flock.js';
import {backupState,verifyBackup,restoreState,assertRestoreLocation,RESTORE_MARKER} from '../../tools/bot/state-backup.mjs';

async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
function fixture(t){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'nova-state-backup-'))),home=join(root,'home'),destination=join(root,'backup');
  mkdirSync(join(home,'bot/memory/team'),{recursive:true});mkdirSync(join(home,'tasks/agents/a/workspace'),{recursive:true});
  writeFileSync(join(home,'bot/state.json'),JSON.stringify({main:'chief',bots:{chief:{id:'chief'},employee:{id:'employee'}}}));
  writeFileSync(join(home,'bot/memory/team/MEMORY.md'),'保留团队记忆。\n');writeFileSync(join(home,'client.token'),'fixture-only-connection-token');
  writeFileSync(join(home,'tasks/agents/a/workspace/report.md'),'已完成的成果。\n');
  chmodSync(join(home,'tasks/agents/a/workspace/report.md'),0o400);
  const db=new DatabaseSync(join(home,'bridge.sqlite'));db.exec('PRAGMA journal_mode=WAL; CREATE TABLE background_task(id TEXT PRIMARY KEY,body TEXT);CREATE TABLE background_job(id TEXT PRIMARY KEY,body TEXT);CREATE TABLE team_report(id TEXT PRIMARY KEY,body TEXT)');
  db.prepare('INSERT INTO background_task VALUES (?,?)').run('task',JSON.stringify({id:'task',runId:'run',assignmentVersion:2,assignedBotId:'employee',status:'completed',tokenBudget:0}));
  db.prepare('INSERT INTO background_job VALUES (?,?)').run('job',JSON.stringify({id:'job',status:'completed',cleanupConfirmed:true}));
  db.prepare('INSERT INTO team_report VALUES (?,?)').run('report',JSON.stringify({id:'report',taskId:'task',runId:'run',version:3}));
  db.close();const second=new DatabaseSync(join(home,'bot/usage.sqlite'));second.exec('CREATE TABLE usage(tokens INTEGER);INSERT INTO usage VALUES(1234)');second.close();
  t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,home,destination};
}

test('offline backup and staging restore preserve identities, task versions, memory and all SQLite databases',async t=>{
  const f=fixture(t),config=join(f.root,'config.json');writeFileSync(config,'{"example":"local configuration"}');
  const before=readFileSync(join(f.home,'bridge.sqlite'));
  const result=await backupState({...f,port:await freePort(),references:[config]});assert.equal(result.databases,2);assert.equal(existsSync(join(f.home,'bot/state.lock')),false);
  const manifest=await verifyBackup({directory:f.destination});assert.equal(manifest.originalHome,f.home);assert.equal(manifest.references[0].path,config);assert.equal(manifest.references[0].sha256.length,64);
  assert.equal(existsSync(join(f.destination,'payload/config.json')),false,'configuration references do not copy credential/config content');
  assert.equal(statSync(f.destination).mode&0o777,0o700);assert.equal(statSync(join(f.destination,'payload/client.token')).mode&0o777,0o600);
  assert.deepEqual(readFileSync(join(f.home,'bridge.sqlite')),before,'snapshot must not alter source database');
  const destination=join(f.root,'restored');await restoreState({directory:f.destination,destination});
  assert.equal(readFileSync(join(destination,'bot/memory/team/MEMORY.md'),'utf8'),'保留团队记忆。\n');
  assert.equal(statSync(join(destination,'tasks/agents/a/workspace/report.md')).mode&0o777,0o400,'readonly artifacts stay readonly');
  assert.deepEqual(readFileSync(join(destination,'bot/state.json')),readFileSync(join(f.home,'bot/state.json')));
  const db=new DatabaseSync(join(destination,'bridge.sqlite'),{readOnly:true});
  assert.deepEqual(JSON.parse(db.prepare('SELECT body FROM background_task').get().body),{id:'task',runId:'run',assignmentVersion:2,assignedBotId:'employee',status:'completed',tokenBudget:0});assert.equal(JSON.parse(db.prepare('SELECT body FROM team_report').get().body).version,3);db.close();
  const usage=new DatabaseSync(join(destination,'bot/usage.sqlite'),{readOnly:true});assert.equal(usage.prepare('SELECT tokens FROM usage').get().tokens,1234);usage.close();
  assert.throws(()=>assertRestoreLocation(destination),/restore_staging_not_launchable/);
  renameSync(f.home,join(f.root,'original-preserved'));renameSync(destination,f.home);assert.doesNotThrow(()=>assertRestoreLocation(f.home));
  assert.equal(readFileSync(join(f.root,'original-preserved/client.token'),'utf8'),'fixture-only-connection-token');
});

test('running host, existing locks and uncertain worker cleanup prevent a backup',async t=>{
  const f=fixture(t),server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{await assert.rejects(backupState({...f,port:server.address().port}),/host_must_be_stopped/);}finally{await new Promise(r=>server.close(r));}
  const port=await freePort();writeFileSync(join(f.home,'bot/state.lock'),'live-or-unknown-owner');
  await assert.rejects(backupState({...f,port}),/state_lock_present/);assert.equal(readFileSync(join(f.home,'bot/state.lock'),'utf8'),'live-or-unknown-owner');rmSync(join(f.home,'bot/state.lock'));
  const session=join(f.home,'harness/sessions/example/session.lock');mkdirSync(join(session,'..'),{recursive:true});const fd=openSync(session,'w',0o600);
  try{await tryLockExclusive(fd);await assert.rejects(backupState({...f,port}),/session_lock_active/);}finally{closeSync(fd);}
  await backupState({...f,port});const manifest=await verifyBackup({directory:f.destination});assert.ok(manifest.omitted.includes('harness/sessions/example/session.lock'));assert.equal(existsSync(session),true);rmSync(f.destination,{recursive:true});
  const db=new DatabaseSync(join(f.home,'bridge.sqlite'));db.prepare('UPDATE background_job SET body=?').run(JSON.stringify({status:'interrupted',cleanupConfirmed:false}));db.close();
  await assert.rejects(backupState({...f,port}),/task_cleanup_unconfirmed/);assert.equal(existsSync(f.destination),false);assert.equal(existsSync(join(f.home,'bot/state.lock')),false);
});

test('SQLite backup includes committed WAL content without copying transient sidecars',async t=>{
  const f=fixture(t),db=new DatabaseSync(join(f.home,'bridge.sqlite'));db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  db.prepare('INSERT INTO team_report VALUES (?,?)').run('report-wal',JSON.stringify({id:'report-wal',version:4}));
  try{
    assert.ok(statSync(join(f.home,'bridge.sqlite-wal')).size>0);await backupState({...f,port:await freePort()});
    const manifest=await verifyBackup({directory:f.destination});assert.ok(manifest.omitted.includes('bridge.sqlite-wal'));
    const snapshot=new DatabaseSync(join(f.destination,'payload/bridge.sqlite'),{readOnly:true});
    try{assert.equal(JSON.parse(snapshot.prepare('SELECT body FROM team_report WHERE id=?').get('report-wal').body).version,4);}finally{snapshot.close();}
    assert.equal(existsSync(join(f.destination,'payload/bridge.sqlite-wal')),false);
  }finally{db.close();}
});

test('a writer changing state during copying invalidates and removes the incomplete backup',async t=>{
  const f=fixture(t),path=join(f.home,'bot/state.json');writeFileSync(join(f.home,'z-large.bin'),Buffer.alloc(16*1024*1024));
  let changes=0;const timer=setInterval(()=>writeFileSync(path,JSON.stringify({changes:++changes})),1);
  try{await assert.rejects(backupState({...f,port:await freePort()}),/state_changed_during_backup/);}finally{clearInterval(timer);}
  assert.ok(changes>0);assert.equal(existsSync(f.destination),false);assert.equal(existsSync(join(f.home,'bot/state.lock')),false);
});

test('backup rejects hard links, special permissions, repository destinations and existing data',async t=>{
  const f=fixture(t),port=await freePort();
  linkSync(join(f.home,'client.token'),join(f.home,'alias'));await assert.rejects(backupState({...f,port}),/unsupported_state_entry/);rmSync(join(f.home,'alias'));
  chmodSync(join(f.home,'client.token'),0o200);await assert.rejects(backupState({...f,port}),/state_file_not_owner_readable/);chmodSync(join(f.home,'client.token'),0o600);
  chmodSync(join(f.home,'client.token'),0o4600);await assert.rejects(backupState({...f,port}),/unsupported_state_permissions/);chmodSync(join(f.home,'client.token'),0o600);
  await assert.rejects(backupState({...f,port,destination:join(ROOT,'output','backup-not-allowed')}),/state_path_must_be_external/);
  mkdirSync(f.destination);writeFileSync(join(f.destination,'keep'),'existing');await assert.rejects(backupState({...f,port}),/backup_destination_must_be_new/);assert.equal(readFileSync(join(f.destination,'keep'),'utf8'),'existing');
});

test('relative and external symbolic links remain references, dependency locks are data, and link-parent writes are rejected',async t=>{
  const f=fixture(t),external=join(f.root,'external'),destination=join(f.root,'restore');mkdirSync(external);writeFileSync(join(external,'secret.txt'),'external contents must not be copied');
  symlinkSync('client.token',join(f.home,'relative-link'));symlinkSync(external,join(f.home,'external-link'),'dir');
  for(const name of ['uv.lock','Cargo.lock','poetry.lock'])writeFileSync(join(f.home,name),'dependency-lock-data');
  await backupState({...f,port:await freePort()});const manifest=await verifyBackup({directory:f.destination});
  assert.equal(manifest.files.filter(e=>e.type==='symlink').length,2);assert.ok(!manifest.files.some(e=>e.path.startsWith('external-link/')));
  for(const name of ['uv.lock','Cargo.lock','poetry.lock'])assert.equal(readFileSync(join(f.destination,'payload',name),'utf8'),'dependency-lock-data');
  await restoreState({directory:f.destination,destination});assert.equal(readlinkSync(join(destination,'relative-link')),'client.token');assert.equal(readlinkSync(join(destination,'external-link')),external);assert.equal(lstatSync(join(destination,'external-link')).isSymbolicLink(),true);
  const file=join(f.destination,'manifest.json');manifest.files.push({path:'external-link/secret.txt',type:'file',mode:0o600,size:1,sha256:'0'.repeat(64)});writeFileSync(file,JSON.stringify(manifest));
  await assert.rejects(restoreState({directory:f.destination,destination:join(f.root,'malicious-restore')}),/unsafe_backup_parent/);
  assert.equal(readFileSync(join(external,'secret.txt'),'utf8'),'external contents must not be copied');assert.equal(existsSync(join(f.root,'malicious-restore')),false);
  mkdirSync(join(f.home,'.git'));writeFileSync(join(f.home,'.git/index.lock'),'git-writer');await assert.rejects(backupState({...f,destination:join(f.root,'git-locked-backup'),port:await freePort()}),/state_lock_present/);
});

test('corruption, injected entries, traversal and symlink payloads fail before restoration',async t=>{
  const f=fixture(t);await backupState({...f,port:await freePort()});const path=join(f.destination,'manifest.json'),original=readFileSync(path,'utf8'),target=join(f.root,'restore');
  const token=join(f.destination,'payload/client.token'),bytes=readFileSync(token);writeFileSync(token,'tampered');
  await assert.rejects(restoreState({directory:f.destination,destination:target}),/backup_hash_mismatch/);assert.equal(existsSync(target),false);writeFileSync(token,bytes);
  writeFileSync(join(f.destination,'payload/unlisted'),'extra');await assert.rejects(verifyBackup({directory:f.destination}),/backup_entries_changed/);rmSync(join(f.destination,'payload/unlisted'));
  const manifest=JSON.parse(original);manifest.files[0].path='../outside';writeFileSync(path,JSON.stringify(manifest));await assert.rejects(restoreState({directory:f.destination,destination:target}),/unsafe_backup_manifest/);assert.equal(existsSync(target),false);writeFileSync(path,original);
  rmSync(token);symlinkSync(join(f.home,'client.token'),token);await assert.rejects(verifyBackup({directory:f.destination}),/backup_entries_changed/);
});

test('restore refuses an existing directory and launcher rejects staging before connecting to any host',async t=>{
  const f=fixture(t);await backupState({...f,port:await freePort()});const destination=join(f.root,'restored');await restoreState({directory:f.destination,destination});
  const marker=readFileSync(join(destination,RESTORE_MARKER));await assert.rejects(restoreState({directory:f.destination,destination}),/restore_destination_must_be_new/);assert.deepEqual(readFileSync(join(destination,RESTORE_MARKER)),marker);
  const result=spawnSync(process.execPath,[join(ROOT,'services/bot/launch.mjs'),'--no-ui'],{env:{...process.env,OPENNOVA_BOT_HOME:destination},encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/restore_staging_not_launchable/);
  // Read-only status and the existing stop command bypass the location guard.
  const help=spawnSync(process.execPath,[join(ROOT,'services/bot/launch.mjs'),'--help'],{env:{...process.env,OPENNOVA_BOT_HOME:destination},encoding:'utf8'});assert.equal(help.status,0);assert.doesNotMatch(help.stderr,/restore_staging_not_launchable/);
});
