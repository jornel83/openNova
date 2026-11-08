import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Operations} from '../operations.mjs';
import {TaskManager} from '../tasks/manager.mjs';
import {prepareReviewEvidence} from '../team/review.mjs';

const provider=fileURLToPath(new URL('./fixtures/filesystem-provider.mjs',import.meta.url));
const plan=actions=>'FS_ACCESS_PLAN='+Buffer.from(JSON.stringify(actions)).toString('base64');
const quote=text=>"'"+text.replaceAll("'","'\\''")+"'";
const node=code=>quote(process.execPath)+' -e '+quote(code);
function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'nova-filesystem-runtime-')),workspace=join(home,'project'),external=mkdtempSync(join(tmpdir(),'nova-filesystem-external-'));
  const ops=new Operations({home,workspace}),options={ops,home,workspace,agentProviderModule:provider},tasks=new TaskManager(options),managers=[tasks];
  writeFileSync(join(external,'sample.txt'),'HOST_FILE_MARKER\n');
  t.after(async()=>{for(const manager of managers)await manager.close();ops.close();rmSync(home,{recursive:true,force:true});rmSync(external,{recursive:true,force:true});});
  const restart=async()=>{await managers.at(-1).close();const next=new TaskManager(options);managers.push(next);return next;};
  return {home,workspace,external,ops,tasks,restart};
}
async function done(tasks,id){
  const deadline=Date.now()+45000;
  while(Date.now()<deadline){const detail=tasks.detail(id);if(!['queued','running','pausing','cancelling'].includes(detail.task.status)&&detail.task.cleanupConfirmed)return detail;await delay(30);}
  throw Error('filesystem task timeout: '+tasks.log({id}).text);
}
const start=(tasks,id,actions,extra={})=>tasks.create({id,kind:'agent',title:'Filesystem scope fixture',goal:plan(actions),permission:'full',workspaceMode:'general',timeoutMs:30000,managementEnabled:false,...extra});

test('full permission uses native tools outside the task directory and keeps default deliverables local',{timeout:60000},async t=>{
  const {tasks,external}=fixture(t),target=join(external,'generated.md');
  const actions=[
    ['glob',{path:external,pattern:'*.txt'}],
    ['grep',{path:external,pattern:'HOST_FILE_MARKER'}],
    ['read',{file_path:join(external,'sample.txt')}],
    ['write',{file_path:target,content:'INITIAL\n'}],
    ['edit',{file_path:target,old_string:'INITIAL',new_string:'UPDATED'}],
    ['task_command',{command:node("require('fs').symlinkSync("+JSON.stringify(external)+",'linked-directory')")}],
    ['read',{file_path:'linked-directory/sample.txt'}],
    ['write',{file_path:'linked-directory/symlink-output.md',content:'SYMLINK_WRITE\n'}],
    ['task_command',{workdir:external,command:node("const fs=require('fs');fs.writeFileSync('command-output.txt',fs.readFileSync('sample.txt'));console.log(process.cwd())")}],
    ['write',{file_path:'report.md',content:'Default task deliverable remains local.\n'}],
  ];
  start(tasks,'native-full',actions);const d=await done(tasks,'native-full');
  assert.equal(d.task.status,'completed',tasks.log({id:d.task.id}).text);assert.equal(d.task.policyVersion,2);
  assert.deepEqual(d.runs[0].jobs.map(job=>[job.tool,job.status]),actions.map(([tool])=>[tool,'completed']));
  for(const index of [1,2,6])assert.match(d.runs[0].jobs[index].output,/HOST_FILE_MARKER/);
  assert.match(d.runs[0].jobs[0].output,/sample\.txt/);
  assert.equal(readFileSync(target,'utf8'),'UPDATED\n');assert.equal(readFileSync(join(external,'symlink-output.md'),'utf8'),'SYMLINK_WRITE\n');
  assert.equal(readFileSync(join(external,'command-output.txt'),'utf8'),'HOST_FILE_MARKER\n');
  assert.equal(readFileSync(join(d.workspace.path,'report.md'),'utf8'),'Default task deliverable remains local.\n');
  assert.equal(existsSync(join(external,'report.md')),false);assert.equal(d.runs[0].jobs[8].exitCode,0);
  assert.ok(d.runs[0].job.artifacts.some(artifact=>artifact.name==='report.md'));
});

test('persisted v2 full permission survives restart and same-session continuation with parent and symlink paths',{timeout:60000},async t=>{
  const {tasks,external,restart}=fixture(t);
  start(tasks,'existing-v2',[['task_question',{question:'Await the explicitly authorized filesystem continuation.'}]]);
  const first=await done(tasks,'existing-v2');assert.equal(first.task.status,'waiting_input');assert.equal(first.task.policyVersion,2);
  writeFileSync(join(first.workspace.path,'..','parent-note.txt'),'PARENT_MARKER\n');
  symlinkSync(external,join(first.workspace.path,'external-link'));
  const next=await restart();
  next.continue({id:first.task.id,runId:first.task.runId,actionId:'resume-full-filesystem',text:plan([
    ['read',{file_path:'../parent-note.txt'}],['read',{file_path:'external-link/sample.txt'}],
    ['write',{file_path:'external-link/resumed.md',content:'RESUMED\n'}],
  ])});
  const resumed=await done(next,first.task.id);assert.equal(resumed.task.status,'completed',next.log({id:first.task.id}).text);
  assert.equal(resumed.task.sessionId,first.task.sessionId);assert.equal(resumed.runs.length,2);assert.equal(resumed.task.policyVersion,2);
  assert.deepEqual(resumed.runs[1].jobs.map(job=>job.status),['completed','completed','completed']);
  assert.match(resumed.runs[1].jobs[0].output,/PARENT_MARKER/);assert.equal(readFileSync(join(external,'resumed.md'),'utf8'),'RESUMED\n');
});

test('read-only tasks cannot access outside files, mutate them or invoke a command',{timeout:60000},async t=>{
  const {tasks,external}=fixture(t),target=join(external,'forbidden.md');
  for(const [id,tool,args] of [
    ['readonly-read','read',{file_path:join(external,'sample.txt')}],
    ['readonly-write','write',{file_path:target,content:'must not be written'}],
    ['readonly-command','task_command',{workdir:external,command:node("require('fs').writeFileSync('forbidden.md','must not run')")}],
  ]){
    start(tasks,id,[[tool,args]],{permission:'read-only'});const d=await done(tasks,id);
    assert.equal(d.task.permission,'read-only');assert.ok(!d.runs[0].jobs.some(job=>job.tool===tool&&job.status==='completed'),JSON.stringify(d.runs[0].jobs));
    if(tool==='read')assert.equal(d.runs[0].jobs[0].error,'outside_task_workspace');
  }
  assert.equal(existsSync(target),false);assert.equal(readFileSync(join(external,'sample.txt'),'utf8'),'HOST_FILE_MARKER\n');
});

test('legacy writable tasks retain their scoped path contract',{timeout:60000},async t=>{
  const {tasks,external}=fixture(t);const created=start(tasks,'legacy-read',[
    ['read',{file_path:join(external,'sample.txt')}],['write',{file_path:join(external,'legacy-forbidden.md'),content:'not allowed'}],
  ]);
  const legacy=tasks.row('task',created.task.id),run=tasks.row('run',created.task.runId);delete legacy.permission;delete legacy.policyVersion;delete run.permission;delete run.policyVersion;tasks.put('task',legacy);tasks.put('run',run);
  const d=await done(tasks,legacy.id);assert.equal(d.task.policyVersion,undefined);
  assert.equal(d.runs[0].jobs.length,2);for(const job of d.runs[0].jobs)assert.equal(job.error,'outside_task_workspace');
  assert.equal(existsSync(join(external,'legacy-forbidden.md')),false);
});

test('management review keeps its evidence-only filesystem even if a full flag is supplied',{timeout:60000},async t=>{
  const {tasks,external,home}=fixture(t);
  start(tasks,'review-target',[['write',{file_path:'report.md',content:'Actual local evidence.\n'}]]);
  const parent=await done(tasks,'review-target'),report=parent.teamReview.current;
  const directory=prepareReviewEvidence({report,task:parent.task,directory:join(home,'review-fixture')});
  tasks.create({id:'review-only',kind:'agent',title:'Evidence scope fixture',goal:plan([
    ['read',{file_path:'report.json'}],['read',{file_path:join(external,'sample.txt')}],
    ['review_decide',{action:'needs_user',summary:'Scope enforcement checked against immutable evidence.',evidenceIds:['report:summary']}],
  ]),permission:'full',workspaceMode:'general',managementEnabled:false,timeoutMs:30000},{source:'supervisor',managementReview:{reviewId:'filesystem-review',reportId:report.id,targetTaskId:parent.task.id,targetRunId:parent.task.runId,assignmentVersion:report.assignmentVersion,evidenceDirectory:directory}});
  const d=await done(tasks,'review-only');assert.equal(d.task.status,'completed',tasks.log({id:d.task.id}).text);
  assert.deepEqual(d.runs[0].jobs.map(job=>[job.tool,job.status]),[['read','completed'],['read','failed'],['review_decide','completed']]);
  assert.equal(d.runs[0].jobs[1].error,'outside_task_workspace');assert.ok(!d.runs[0].jobs[1].output?.includes('HOST_FILE_MARKER'));
});
