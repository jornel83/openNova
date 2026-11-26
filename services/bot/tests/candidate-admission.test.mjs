import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Operations} from '../operations.mjs';
import {TaskManager,taskTools} from '../tasks/manager.mjs';
import {candidatePatchDigest} from '../team/candidate-patch.mjs';
import {loadCandidateProfile} from '../team/candidate-profile.mjs';
import {readSteps} from '../tasks/agent-files.mjs';

const regression="node -e \"if(require('fs').readFileSync('sample.txt','utf8')!=='updated\\n')process.exit(3);console.log('verified')\"";
const provider=fileURLToPath(new URL('./fixtures/task-provider.mjs',import.meta.url));
function setup(t){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-candidate-admission-')));
  const source=join(home,'project'),command=join(home,'verify'),receiptRoot=join(home,'receipts');
  mkdirSync(source);mkdirSync(receiptRoot);writeFileSync(command,'#!/bin/sh\nexit 1\n',{mode:0o700});
  const profile={version:1,kind:'text-only-start',source,command,receiptRoot,regressions:[{command:regression,check:'startupRegression'}],reproductions:[]};
  const save=config=>writeFileSync(join(home,'candidate-review.json'),JSON.stringify(config));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  return {home,source,profile,save};
}
test('candidate profiles confine receipt intake to a host-provisioned verifier for this project',t=>{
  const {home,source,profile,save}=setup(t);
  assert.throws(()=>loadCandidateProfile(home,source),/not_configured/);
  save(profile);assert.deepEqual(loadCandidateProfile(home,source),profile);
  assert.throws(()=>loadCandidateProfile(home,home),/project_mismatch/);
  const link=join(home,'linked-verifier');symlinkSync(profile.command,link);
  for(const overrides of [{command:link},{receiptRoot:source},{receiptRoot:home},{regressions:[]},
    {regressions:[{command:regression,check:'build'}]},{reproductions:[{command:'false',check:'missing',exitCode:1,outputIncludes:'expected'}]}]){
    save({...profile,...overrides});assert.throws(()=>loadCandidateProfile(home,source),/invalid_candidate_review_profile/);
  }
});

test('foreground delegation freezes the profile and the real worker stamps the regression on the final patch',async t=>{
  const {home,source,profile,save}=setup(t),ops=new Operations({home,workspace:source});
  const git=args=>execFileSync('git',args,{cwd:source,stdio:'pipe'});
  git(['init','-q']);writeFileSync(join(source,'sample.txt'),'original\n');git(['add','.']);
  git(['-c','user.name=Nova','-c','user.email=nova@localhost','commit','-qm','baseline']);
  const tasks=new TaskManager({ops,home,workspace:source,agentProviderModule:provider});
  try{
    const tool=taskTools(tasks,()=>({id:'candidate-admission'})).find(([name])=>name==='background_agent_start');
    const input={title:'候选验收',goal:'FIXTURE_EDIT',candidateReview:true,workspaceMode:'code',managementEnabled:false,timeoutMs:40000};
    assert.equal(tool[2].candidateReview.type,'boolean');
    assert.throws(()=>tool[3](input),/candidate_review_not_configured/);
    save(profile);
    for(const override of [{candidateReview:profile},{permission:'read-only'},{workspaceMode:'general'}]){
      assert.throws(()=>tool[3]({...input,...override}),/invalid_candidate_review_task/);
    }
    const {id}=tool[3](input).task;
    assert.deepEqual(tasks.row('task',id).candidateReview,profile);
    save({});assert.equal(tool[3](input).task.id,id);
    const deadline=Date.now()+50000;
    while(Date.now()<deadline&&['running','queued'].includes(tasks.row('task',id).status))await delay(100);
    const task=tasks.row('task',id),run=tasks.row('run',task.runId),job=tasks.row('job',run.jobId);
    assert.equal(task.status,'completed',tasks.log({id}).text);
    const workspace=JSON.parse(readFileSync(join(tasks.agentHome(task),'workspace.json'),'utf8'));
    const step=readSteps(tasks.directory(job)).find(step=>step.tool==='task_command');
    assert.equal(step.exitCode,0);assert.equal(step.candidatePatchSha256,candidatePatchDigest(workspace));
    assert.equal(readFileSync(join(source,'sample.txt'),'utf8'),'original\n');
    assert.equal(tasks.reports.current(task).evidence.candidateReview.status,'incomplete','a regression alone cannot certify the candidate');
  }finally{await tasks.close();ops.close();}
});
