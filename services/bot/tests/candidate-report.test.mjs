import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmodSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {builtinChecks} from '../team/candidate-profile.mjs';
import {candidateIndexClean,candidatePatch,candidatePatchDigest} from '../team/candidate-patch.mjs';
import {normalizeReviewDecision,prepareReviewEvidence} from '../team/review.mjs';
import {TeamReports} from '../team/reports.mjs';
import {TeamSupervisor} from '../team/supervisor.mjs';

function temp(t){
  const directory=mkdtempSync(join(tmpdir(),'nova-candidate-report-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  return directory;
}

test('candidate patch includes untracked binary files, modes and deletions while the existing index stays untouched',t=>{
  const path=temp(t),git=(...args)=>execFileSync('git',args,{cwd:path}).toString().trim();
  git('init','-q');writeFileSync(join(path,'old.txt'),'old\n');git('add','.');
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','base');
  const workspace={path,base:git('rev-parse','HEAD')};
  writeFileSync(join(path,'old.txt'),'user staging\n');git('add','old.txt');rmSync(join(path,'old.txt'));
  writeFileSync(join(path,'new.bin'),Buffer.from([0,127,17,0,255]));chmodSync(join(path,'new.bin'),0o755);
  const index=readFileSync(join(path,'.git','index')),result=candidatePatch(workspace,{keepIndex:true});
  assert.deepEqual(result.names,['new.bin','old.txt']);assert.match(result.bytes.toString(),/GIT binary patch/);assert.match(result.bytes.toString(),/new file mode 100755/);
  assert.equal(candidatePatchDigest(workspace),result.sha256);
  assert.equal(candidateIndexClean(workspace,result.index),true);assert.deepEqual(readFileSync(join(path,'.git','index')),index);
  chmodSync(join(path,'new.bin'),0o644);assert.equal(candidateIndexClean(workspace,result.index),false);assert.notEqual(candidatePatchDigest(workspace),result.sha256);
  chmodSync(join(path,'new.bin'),0o755);assert.equal(candidatePatchDigest(workspace),result.sha256);
  const state=temp(t);writeFileSync(join(state,'workspace.json'),JSON.stringify(workspace));
  const task={id:'t',runId:'r',assignmentVersion:1},report={id:'report',runId:'r',assignmentVersion:1,evidence:{candidateReview:{patchSha256:result.sha256,workspacePath:workspace.path,workspaceBase:workspace.base}}};
  const reports=Object.assign(Object.create(TeamReports.prototype),{tasks:{agentHome:()=>state},candidateCache:new Map(),now:Date.now,current:()=>report});
  const supervisor=Object.assign(Object.create(TeamSupervisor.prototype),{reports,history:()=>[{id:'decision',reportId:report.id,runId:'r',assignmentVersion:1,status:'accepted'}]});
  assert.equal(supervisor.summary(task).reviewStatus,'accepted');
  writeFileSync(join(path,'extra.md'),'after review');assert.equal(candidateIndexClean(workspace,result.index),false);
  assert.equal(supervisor.summary(task).reviewStatus,'stale');
  assert.deepEqual(readFileSync(join(path,'.git','index')),index);
});

function candidateReport(t){
  const directory=temp(t);
  const artifacts=[];
  function add(id,size=10,name=id+'.log'){
    const bytes=Buffer.alloc(size,65),path=join(directory,name),sha256=createHash('sha256').update(bytes).digest('hex');
    writeFileSync(path,bytes);artifacts.push({id,name,path,size,sha256,status:'available'});return sha256;
  }
  const patchSha256=add('patch');
  // Put the receipt beyond the generic 40-file limit, including a log above the normal text cap.
  add('launcher',10,'start.command');
  for(let n=1;n<40;n++)add('note'+n);
  add('receipt',300000);
  return {id:'report',taskId:'t',runId:'r',assignmentVersion:1,status:'completed',artifacts,evidence:{
    execution:{status:'completed',cleanupConfirmed:true,exitCode:0},
    commands:[{stepId:'repro',status:'failed',exitCode:1},{stepId:'final',status:'completed',exitCode:0}],
    steps:[{id:'repro',tool:'task_command',status:'failed'},{id:'final',tool:'task_command',status:'completed'}],checks:[],
    candidateReview:{status:'passed',reportId:'report',taskId:'t',runId:'r',assignmentVersion:1,patchSha256,stepId:'final',
      requiredChecks:builtinChecks,checks:builtinChecks.map(check=>({check,stepId:'final',artifactId:'receipt',status:'passed'})),artifactIds:['receipt'],coveredStepIds:['repro'],patchArtifactId:'patch'}}};
}
const decision={action:'accept',summary:'Candidate verified',evidenceIds:['patch','receipt','final']};
test('candidate reviewer sees all checked artifacts, including the full log; acceptance binds the cited checks to the current report',t=>{
  const report=candidateReport(t),directory=temp(t);
  prepareReviewEvidence({report,task:{id:'t'},directory});
  const payload=JSON.parse(readFileSync(join(directory,'report.json'),'utf8'));
  assert.equal(payload.artifacts.length,42);assert.equal(readFileSync(join(directory,payload.artifacts.at(-1).path)).length,300000);
  assert.deepEqual(normalizeReviewDecision(decision,payload),decision);
  assert.throws(()=>normalizeReviewDecision({...decision,evidenceIds:['receipt']},payload),/candidate_review_evidence_required/);
  for(const key of ['taskId','runId','reportId','assignmentVersion','patchSha256']){
    const changed=structuredClone(payload);changed.evidence.candidateReview[key]='other';
    assert.throws(()=>normalizeReviewDecision(decision,changed),/candidate_verification_incomplete/);
  }
  for(const mutate of [
    r=>r.evidence.candidateReview.checks.pop(),r=>{r.evidence.candidateReview.requiredChecks.pop();r.evidence.candidateReview.checks.pop();},r=>r.evidence.candidateReview.artifactIds.push('omitted'),
    r=>r.evidence.candidateReview.status='incomplete',r=>r.evidence.steps.push({id:'edit',tool:'write',status:'failed'}),
    r=>r.evidence.commands.push({stepId:'other',status:'failed',exitCode:1}),r=>r.evidence.checks.push({taskId:'repro',status:'failed',exitCode:1})
  ]){
    const changed=structuredClone(payload);mutate(changed);
    assert.throws(()=>normalizeReviewDecision(decision,changed),/verification_incomplete/);
  }
});
