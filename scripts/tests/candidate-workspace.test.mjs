import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,symlinkSync,statSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareCandidate,buildCandidate} from '../candidate/workspace.mjs';
import {prepareWorkspace} from '../../services/bot/tasks/workspace.mjs';
import {candidatePatch} from '../../services/bot/team/candidate-patch.mjs';

const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function fixture(t){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'opennova-candidate-workspace-')));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const source=join(home,'project'),attemptDir=join(home,'receipts'),candidate=join(home,'candidate');
  mkdirSync(source);mkdirSync(attemptDir);git(source,'init','-q');
  writeFileSync(join(source,'.gitignore'),'node_modules/\n.env\noutput/\n');writeFileSync(join(source,'package.json'),'{}');
  writeFileSync(join(source,'pnpm-lock.yaml'),'lockfileVersion: 9\n');writeFileSync(join(source,'old'),'old');
  writeFileSync(join(source,'.env'),'local private data');
  git(source,'add','.');git(source,'-c','user.name=Nova','-c','user.email=nova@localhost','commit','-qm','initial');
  writeFileSync(join(source,'dirty'),'host edit');git(source,'add','dirty');writeFileSync(join(source,'dirty'),'user change since staging');
  const modules=join(source,'node_modules');
  mkdirSync(join(modules,'.pnpm','sample','node_modules','sample'),{recursive:true});mkdirSync(join(modules,'.bin'));
  writeFileSync(join(modules,'.pnpm','sample','node_modules','sample','index.js'),'installed bytes');
  symlinkSync('.pnpm/sample/node_modules/sample',join(modules,'sample'));
  writeFileSync(join(modules,'.bin','sample'),'#!/bin/sh\nbasedir=$(dirname "$0")\nexport NODE_PATH="/old/path/node_modules/.pnpm/sample/node_modules"\nexec "$basedir_abs/../sample/index.js" "$@"\n# cmd-shim-target=/old/path/node_modules/sample/index.js\n');
  const workspace=await prepareWorkspace({source,home:join(home,'assignment'),taskId:'test',mode:'edit'});
  writeFileSync(join(workspace.path,'new.bin'),Buffer.from([0,255,42]));
  rmSync(join(workspace.path,'old'));
  chmodSync(join(workspace.path,'dirty'),0o755);
  return {workspace,candidate,attemptDir,dependencySource:source,home};
}
test('uses the assigned dirty baseline, exact binary patch and private copies of lock-matching modules',async t=>{
  const options=await fixture(t),{workspace,candidate,attemptDir,dependencySource:source}=options;
  const indexBefore=git(source,'write-tree'),expected=candidatePatch(workspace);
  const s=await prepareCandidate(options);
  assert.notEqual(workspace.base,workspace.sourceHead);
  assert.equal(s.workerPatchSha256,expected.sha256);assert.ok(expected.bytes.equals(readFileSync(join(attemptDir,'worker.patch'))));
  assert.equal(s.workerTree,git(candidate,'write-tree'));
  assert.equal(s.baseTree,git(candidate,'rev-parse','HEAD^{tree}'));
  assert.equal(git(source,'write-tree'),indexBefore);
  assert.equal(git(candidate,'rev-parse','--is-shallow-repository'),'true');
  assert.equal(git(candidate,'remote'),'');assert.equal(existsSync(join(candidate,'.git','objects','info','alternates')),false);
  assert.equal(existsSync(join(candidate,'.env')),false);assert.equal(existsSync(join(candidate,'old')),false);
  assert.deepEqual(readFileSync(join(candidate,'new.bin')),Buffer.from([0,255,42]));
  assert.ok(statSync(join(candidate,'dirty')).mode&0o111);
  writeFileSync(join(candidate,'node_modules','sample','index.js'),'modified');
  assert.equal(readFileSync(join(source,'node_modules','sample','index.js'),'utf8'),'installed bytes');
  assert.doesNotMatch(readFileSync(join(candidate,'node_modules','.bin','sample'),'utf8'),/\/old\/path/);
});
test('changed dependency locks, an external module symlink or an unsafe candidate destination stop preparation',async t=>{
  for(const issue of ['lock','link','destination','base']){
    const o=await fixture(t);
    if(issue==='lock')writeFileSync(join(o.workspace.path,'pnpm-lock.yaml'),'incompatible');
    if(issue==='link')symlinkSync(o.dependencySource,join(o.dependencySource,'node_modules','other'));
    if(issue==='destination')o.candidate=join(o.workspace.source,'bad');
    if(issue==='base')o.workspace.snapshotTree=o.workspace.sourceHead;
    await assert.rejects(prepareCandidate(o),/candidate_(?:dependency_lock_mismatch|external_link|requires_isolated_directory|assignment_base_mismatch)/);
  }
});
test('only the recorded executable for the same Swift source can be reused by the macOS build',{skip:process.platform!=='darwin'},async t=>{
  const sha=data=>createHash('sha256').update(data).digest('hex');
  for(const scenario of ['match','candidateSwiftChanged','installedSwiftChanged','tampered','notExecutable','symlink','invalidSchema']){
    const o=await fixture(t),seed=o.dependencySource,swift='services/agent/keychain.swift',helper='output/bin/siwc-keychain';
    for(const root of [seed,o.workspace.path])mkdirSync(join(root,'services','agent'),{recursive:true});
    writeFileSync(join(seed,swift),scenario==='installedSwiftChanged'?'different seed':'source');
    writeFileSync(join(o.workspace.path,swift),scenario==='candidateSwiftChanged'?'modified candidate':'source');
    mkdirSync(join(seed,'output','bin'),{recursive:true});
    writeFileSync(join(seed,helper),scenario==='tampered'?'modified binary':'binary',{mode:scenario==='notExecutable'?0o600:0o700});
    const record={schemaVersion:scenario==='invalidSchema'?2:1,sourceSha256:sha('source'),binarySha256:sha('binary')};
    writeFileSync(join(seed,helper+'.build.json'),JSON.stringify(record));
    if(scenario==='symlink'){
      rmSync(join(seed,helper));writeFileSync(join(seed,'linked-helper'),'binary',{mode:0o700});symlinkSync(join(seed,'linked-helper'),join(seed,helper));
    }
    const {keychainHelper}=await prepareCandidate(o);
    if(scenario==='match'){
      assert.deepEqual(keychainHelper,{mode:'verified-installed-copy',sourceSha256:record.sourceSha256,binarySha256:record.binarySha256});
      const target=join(o.candidate,helper);
      assert.notEqual(statSync(target).ino,statSync(join(seed,helper)).ino);
      assert.equal(statSync(target).mode&0o777,0o700);assert.equal(readFileSync(target,'utf8'),'binary');
      assert.deepEqual(JSON.parse(readFileSync(target+'.build.json','utf8')),record);
      writeFileSync(target,'edited copy');assert.equal(readFileSync(join(seed,helper),'utf8'),'binary');
    }else{
      assert.equal(keychainHelper.mode,'build-from-source',scenario);
      assert.equal(existsSync(join(o.candidate,helper)),false,scenario);
    }
  }
});
test('build and doctor use candidate cwd and keep failed or unexpected audio observations',async t=>{
  const {candidate,attemptDir}=await fixture(t);mkdirSync(candidate);
  for(const failure of ['none','failedBuild','doctorNotReady','audio']){
    const sub=join(attemptDir,failure);mkdirSync(sub);const calls=[],receipt={};
    const work=buildCandidate({candidate,attemptDir:sub,env:{EXAMPLE:'test'},receipt,run:async o=>{
      const name=o.args.at(-1);calls.push(name);assert.equal(o.cwd,candidate);assert.equal(o.env.EXAMPLE,'test');assert.match(o.env.NODE_OPTIONS,/no-audio/);
      writeFileSync(o.logPath,name==='doctor'?JSON.stringify({build:{ready:failure!=='doctorNotReady'}}):'built');
      if(failure==='audio')writeFileSync(o.env.OPENNOVA_PROBE_CALLS,'{"method":"spawn","entry":"audio"}\n');
      return {exitCode:failure==='failedBuild'?7:0};
    }});
    if(failure==='none'){await work;assert.deepEqual(calls,['build','doctor']);assert.equal(receipt.doctor.ready,true);}
    else{await assert.rejects(work,/candidate_(build_failed|doctor_not_ready)/);if(failure==='failedBuild')assert.equal(receipt.build.exitCode,7);if(failure==='audio')assert.equal(receipt.build.calls.length,1);}
  }
});
