import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {TeamReports} from '../team/reports.mjs';
import {TeamOutbox} from '../team/outbox.mjs';
import {ManagementDelivery} from '../team/delivery.mjs';
import {saveJson} from '../tasks/agent-files.mjs';
import {Operations} from '../operations.mjs';
import {TaskManager} from '../tasks/manager.mjs';
import {prepareDocuments} from '../tasks/documents.mjs';

function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'nova-reports-')),db=new DatabaseSync(join(home,'state.sqlite')),root=join(home,'tasks'),rows={task:new Map(),run:new Map(),job:new Map()};
  t.after(()=>{db.close();rmSync(home,{recursive:true,force:true});});
  const tasks={db,root,team:{chiefId:'chief'},row:(kind,id)=>{const row=rows[kind].get(id);if(!row)throw Error('unknown_task');return row;},all:()=>[...rows.task.values()],agentHome:task=>join(root,'agents',task.id),directory:job=>join(root,job.id)};
  const reports=new TeamReports(tasks);tasks.reports=reports;
  function work(id='task',extra={}){
    const path=join(root,'agents',id,'workspace');mkdirSync(path,{recursive:true});writeFileSync(join(path,'report.md'),'original result');
    const task={id,kind:'agent',teamReportVersion:1,runId:'run-'+id,assignedBotId:'employee',assignmentVersion:1,reportTo:'chief',cwd:path,title:'资料整理',status:'completed',...extra};
    const run={id:task.runId,taskId:id,assignmentVersion:task.assignmentVersion},job={id:'job-'+id,taskId:id,runId:run.id,kind:'agent',status:'completed',cleanupConfirmed:true,exitCode:0,agentResult:{text:'已整理资料'},artifacts:[{id:'original',name:'report.md',path:join(path,'report.md'),status:'available'}]};
    saveJson(join(tasks.agentHome(task),'workspace.json'),{path,kind:'general'});
    saveJson(join(tasks.directory(job),'steps','write.json'),{id:'write',tool:'write',status:'completed',createdAt:1,output:'file saved'});
    rows.task.set(id,task);rows.run.set(run.id,run);rows.job.set(job.id,job);return {task,run,job,path};
  }
  const capture=work=>{db.exec('BEGIN');try{const r=reports.capture(work.task,work.run,work.job);db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
  return {home,db,tasks,rows,reports,work,capture};
}

test('report, event and outbox roll back together; completed file snapshot survives retry without changing version',t=>{
  const f=fixture(t),w=f.work();
  f.db.exec('BEGIN');const interrupted=f.reports.capture(w.task,w.run,w.job);f.db.exec('ROLLBACK');
  for(const table of ['team_report','team_event','team_outbox'])assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);
  writeFileSync(join(w.path,'report.md'),'changed after first snapshot');
  const report=f.capture(w);assert.equal(report.id,interrupted.id);assert.equal(report.version,1);
  assert.equal(readFileSync(report.artifacts[0].path,'utf8'),'original result');assert.equal(report.artifacts[0].sourceStatus,'changed');
  assert.throws(()=>f.reports.assertCurrent(w.task,report.id),/artifact_changed/);
  assert.equal(f.capture(w).id,report.id);
  for(const table of ['team_report','team_event','team_outbox'])assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,1);
});

test('immutable report files and original working file drift are checked separately; stale Run and assignment cannot be reviewed',t=>{
  const f=fixture(t),w=f.work(),report=f.capture(w),artifact=report.artifacts[0];
  assert.equal(f.reports.assertCurrent(w.task,report.id).id,report.id);
  writeFileSync(join(w.path,'report.md'),'new work');
  assert.equal(f.reports.artifact({id:w.task.id,reportId:report.id,artifactId:artifact.id}).status,'available');
  assert.throws(()=>f.reports.assertCurrent(w.task,report.id),/artifact_changed/);
  writeFileSync(artifact.path,'snapshot tampered');assert.throws(()=>f.reports.artifact({id:w.task.id,reportId:report.id,artifactId:artifact.id}),/artifact_changed/);
  f.rows.task.set(w.task.id,{...w.task,runId:'new-run',assignmentVersion:2});assert.throws(()=>f.reports.assertCurrent(w.task,report.id),/stale/);
  assert.equal(f.reports.current(f.rows.task.get(w.task.id)),null);assert.equal(f.reports.history(w.task.id).length,1);
});

test('cleanup reconciliation and cancellation create new versions; management and historical tasks produce no report events',t=>{
  const f=fixture(t),w=f.work();w.job.status='waiting_input';w.job.agentResult.question='需要补充资料';
  const first=f.capture(w);assert.equal(f.capture(w).id,first.id);
  w.job.status='cancelled';const second=f.capture(w);assert.equal(second.version,2);assert.equal(second.status,'cancelled');
  assert.equal(f.reports.current(w.task).id,second.id);assert.throws(()=>f.reports.assertCurrent(w.task,first.id),/stale/);
  for(const extra of [{teamReportVersion:undefined},{managementReview:{reportId:first.id}},{parentTaskId:'parent'}])assert.equal(f.capture(f.work('skip-'+Math.random(),extra)),null);
  const pending=f.work('cleanup');pending.job.status='interrupted';pending.job.cleanupConfirmed=false;const before=f.capture(pending);
  pending.job.cleanupConfirmed=true;const after=f.capture(pending);assert.equal(after.version,before.version+1);
});

test('report evidence requires matching source Run and excludes failed HTTP observations; outside symlink is not snapshotted',t=>{
  const f=fixture(t),w=f.work();
  saveJson(join(f.tasks.directory(w.job),'research.json'),{taskId:w.task.id,runId:w.run.id,sources:[{url:'https://example.com/good',statusCode:200},{url:'https://example.com/bad',statusCode:503},{url:'https://example.com/failed',status:'failed'}]});
  writeFileSync(join(f.home,'outside.txt'),'outside');symlinkSync(join(f.home,'outside.txt'),join(w.path,'link.txt'));w.job.artifacts.push({name:'link.txt',path:join(w.path,'link.txt')});
  const report=f.capture(w);assert.deepEqual(report.sources.map(s=>s.url),['https://example.com/good']);assert.equal(report.evidence.steps[0].tool,'write');
  assert.equal(report.artifacts.find(a=>a.name==='link.txt').status,'changed');
  const other=f.work('foreign');saveJson(join(f.tasks.directory(other.job),'research.json'),{taskId:other.task.id,runId:'wrong-run',sources:[{url:'https://example.com/good'}]});
  assert.deepEqual(f.capture(other).sources,[]);
});

test('command evidence preserves bounded executed assertions, working directories and async check logs',t=>{
  const f=fixture(t),w=f.work('commands'),command='node --test verify.mjs';
  saveJson(join(f.tasks.directory(w.job),'steps','verify.json'),{id:'verify',tool:'task_command',status:'completed',exitCode:0,createdAt:2,arguments:{command,workdir:'checks',unrelatedPrivateField:'do not propagate'}});
  const logDir=join(f.tasks.directory(w.job),'commands','verify');mkdirSync(logDir,{recursive:true});writeFileSync(join(logDir,'output.log'),'assertions passed');
  const child=f.work('check',{kind:'command',parentTaskId:w.task.id,parentRunId:w.run.id,command:'pnpm test',cwd:w.path});child.run.jobId=child.job.id;writeFileSync(join(f.tasks.directory(child.job),'output.log'),'async check passed');
  const report=f.capture(w);assert.equal(report.evidence.commands[0].command,command);assert.equal(report.evidence.commands[0].workdir,'checks');assert.equal(report.evidence.commands[0].log,'assertions passed');
  assert.equal(report.evidence.checks[0].command,'pnpm test');assert.equal(report.evidence.checks[0].cwd,w.path);assert.equal(report.evidence.checks[0].log,'async check passed');assert.doesNotMatch(JSON.stringify(report),/unrelatedPrivateField|do not propagate/);
  const direct=f.work('direct',{kind:'command',command:'x'.repeat(17000)});direct.job.agentResult=undefined;writeFileSync(join(f.tasks.directory(direct.job),'output.log'),'command job output');
  const directReport=f.capture(direct);assert.equal(directReport.evidence.commands[0].command.length,16000);assert.equal(directReport.evidence.commands[0].cwd,direct.task.cwd);assert.equal(directReport.evidence.commands[0].log,'command job output');
});

test('code reports snapshot tracked modifications, untracked results and deletion evidence without mutating the Git index',t=>{
  const f=fixture(t),w=f.work('code');
  const git=args=>{const r=spawnSync('git',args,{cwd:w.path,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git(['init','-q']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);
  writeFileSync(join(w.path,'removed.txt'),'delete me');git(['add','.']);git(['commit','-qm','fixture']);
  saveJson(join(f.tasks.agentHome(w.task),'workspace.json'),{path:w.path,base:git(['rev-parse','HEAD'])});
  writeFileSync(join(w.path,'report.md'),'updated');writeFileSync(join(w.path,'new.txt'),'new result');rmSync(join(w.path,'removed.txt'));w.job.artifacts=[];
  const index=git(['diff','--cached']);const report=f.capture(w);assert.equal(git(['diff','--cached']),index);
  assert.deepEqual(report.artifacts.map(a=>a.name).sort(),['changes.patch','new.txt','report.md']);
  assert.equal(report.evidence.codeChanges.find(c=>c.name==='removed.txt').deleted,true);f.reports.assertCurrent(w.task,report.id);
  writeFileSync(join(w.path,'removed.txt'),'restored');assert.throws(()=>f.reports.assertCurrent(w.task,report.id),/artifact_changed/);
});

test('generated Git patches do not collide with employee outputs and count toward the 50-artifact limit',t=>{
  const f=fixture(t),w=f.work('patch-names');
  const git=args=>{const r=spawnSync('git',args,{cwd:w.path,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git(['init','-q']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);git(['add','.']);git(['commit','-qm','fixture']);
  saveJson(join(f.tasks.agentHome(w.task),'workspace.json'),{path:w.path,base:git(['rev-parse','HEAD'])});
  writeFileSync(join(w.path,'report.md'),'updated');writeFileSync(join(w.path,'changes.patch'),'employee patch');writeFileSync(join(w.path,'changes-2.patch'),'employee second patch');
  w.job.artifacts=[];const report=f.capture(w);
  assert.equal(new Set(report.artifacts.map(a=>a.name)).size,4);assert.equal(report.evidence.captureIncomplete,false);
  assert.equal(readFileSync(report.artifacts.find(a=>a.name==='changes.patch').path,'utf8'),'employee patch');
  assert.match(readFileSync(report.artifacts.find(a=>a.name==='changes-3.patch').path,'utf8'),/^diff --git/);
  for(let i=0;i<47;i++)writeFileSync(join(w.path,'extra-'+i+'.txt'),'result');
  // A later completion state captures 50 source files plus generated patch evidence.
  w.job.status='paused';const limited=f.capture(w);
  assert.equal(limited.artifacts.length,50);assert.equal(limited.evidence.captureIncomplete,true);
  assert.equal(new Set(limited.artifacts.map(a=>a.name)).size,50);
  assert.throws(()=>f.reports.assertCurrent(w.task,limited.id),/artifact_changed/);
});

test('artifact capture limits remain explicit and actual command timeout reason is preserved',t=>{
  const f=fixture(t),w=f.work('large');w.job.artifacts=[];
  for(let i=0;i<51;i++){const path=join(w.path,'file-'+i+'.txt');writeFileSync(path,'result');w.job.artifacts.push({name:'file-'+i+'.txt',path});}
  const report=f.capture(w);assert.equal(report.artifacts.length,50);assert.equal(report.evidence.captureIncomplete,true);assert.throws(()=>f.reports.assertCurrent(w.task,report.id),/artifact_changed/);
  const timeout=f.work('timeout');timeout.task.kind='command';timeout.job.kind='command';timeout.job.status='failed';timeout.job.exitCode=null;timeout.job.error='task_timeout';timeout.job.agentResult=undefined;
  writeFileSync(join(f.tasks.directory(timeout.job),'output.log'),'started but no successful exit');const result=f.capture(timeout);
  assert.equal(result.status,'failed');assert.equal(result.error,'task_timeout');assert.equal(result.evidence.execution.error,'task_timeout');assert.equal(result.evidence.commands[0].exitCode,null);assert.match(result.evidence.commands[0].log,/no successful exit/);
});

test('real manager completion preserves an overflow sentinel instead of presenting a partial snapshot as complete',async t=>{
  const home=mkdtempSync(join(tmpdir(),'nova-report-overflow-')),workspace=join(home,'project'),ops=new Operations({home,workspace});
  const tasks=new TaskManager({ops,home,workspace});tasks.foregroundBusy=()=>true;
  t.after(async()=>{await tasks.close();ops.close();rmSync(home,{recursive:true,force:true});});
  for(const count of [50,51,75]){
    const id='files-'+count;tasks.create({id,kind:'agent',title:id,goal:'输出资料',workspaceMode:'general',managementEnabled:false});
    const task=tasks.row('task',id),run=tasks.row('run',task.runId),job=tasks.row('job',run.jobId);
    const w=await prepareDocuments({source:workspace,home:tasks.agentHome(task),mode:'edit',workspaceMode:'general'});
    for(let i=0;i<count;i++){const dir=join(w.path,String(Math.floor(i/10)));mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'result-'+i+'.txt'),'result '+i);}
    saveJson(join(tasks.directory(job),'agent-result.json'),{runId:run.id,taskId:id,status:'completed',text:'输出资料完成。'});
    tasks.finish(task,run,job,{status:'completed',cleanupConfirmed:true,exitCode:0});
    const current=tasks.row('task',id),report=tasks.reports.current(current);
    assert.equal(tasks.row('job',job.id).artifacts.length,Math.min(51,count));
    assert.equal(report.artifacts.length,50);assert.equal(report.evidence.captureIncomplete,count>50);
    if(count>50)assert.throws(()=>tasks.reports.assertCurrent(current,report.id),/artifact_changed/);
    else assert.equal(tasks.reports.assertCurrent(current,report.id).id,report.id);
  }
});

test('durable management delivery reconciles a lost acknowledgement without sending twice or waking a foreground Bot',async t=>{
  const f=fixture(t),report=f.capture(f.work()),recipient=new ManagementDelivery({home:f.home,chiefId:'chief'});let sent=0;
  const delivery={lookup:id=>recipient.lookup(id),deliver:async event=>{sent++;await recipient.deliver(event);throw Error('acknowledgement lost');}};
  const outbox=new TeamOutbox({db:f.db,delivery});await Promise.all([outbox.tick(),outbox.tick()]);
  assert.equal(sent,1);assert.equal(f.reports.isDelivered(report.id),true);assert.equal(recipient.messages().length,1);
  const message=recipient.messages()[0].message;assert.equal(message.source.kind,'bot');assert.equal(message.source.exchangeId,report.eventId);
  assert.notEqual(recipient.sessionId,'chief');await recipient.consume(report.eventId,'management-run');
  await recipient.consume(report.eventId,'management-run');assert.equal(recipient.messages().length,1);
  await assert.rejects(recipient.consume(report.eventId,'other-management-run'),/consumed/);
  await outbox.close();
});

test('restart reconciles recipient commit before sender receipt, and failed sends retry from durable state',async t=>{
  const f=fixture(t),report=f.capture(f.work());let now=100,calls=0;
  let outbox=new TeamOutbox({db:f.db,now:()=>now,retryMs:10,delivery:{lookup:async()=>null,deliver:async()=>{calls++;throw Error('offline');}}});
  await outbox.tick();assert.equal(outbox.list()[0].status,'retry');await outbox.tick();assert.equal(calls,1);
  const event=JSON.parse(f.db.prepare('SELECT body FROM team_event WHERE id=?').get(report.eventId).body),recipient=new ManagementDelivery({home:f.home,chiefId:'chief'});
  await recipient.deliver(event);await outbox.close();now=1000;
  const reopened=new ManagementDelivery({home:f.home,chiefId:'chief'});outbox=new TeamOutbox({db:f.db,now:()=>now,delivery:{lookup:id=>reopened.lookup(id),deliver:async()=>{throw Error('must not send again');}}});
  await outbox.tick();assert.equal(outbox.list()[0].status,'delivered');assert.equal(reopened.messages().length,1);await outbox.close();
});
