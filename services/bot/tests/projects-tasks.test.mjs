import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,readFileSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Operations} from '../operations.mjs';
import {TaskManager,taskTools} from '../tasks/manager.mjs';
import {ProjectStore,DEFAULT_PROJECT_ID} from '../projects/store.mjs';
import {ProjectService} from '../projects/service.mjs';
import {createControls} from '../controls.mjs';
import {TeamRegistry} from '../team/registry.mjs';
import {experienceCandidate} from '../skills/experience.mjs';
import {prepareDocuments} from '../tasks/documents.mjs';
import {readTaskInputBytes} from '../tasks/frozen-documents.mjs';
import {setTimeout as delay} from 'node:timers/promises';

function fixture(t){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-project-tasks-'))),workspace=join(home,'A'),other=join(home,'B');mkdirSync(other);
  const ops=new Operations({home,workspace}),tasks=new TaskManager({ops,home,workspace}),store=new ProjectStore({ops,home,workspace});
  tasks.tick=()=>{};clearInterval(tasks.timer);
  const b=store.mutate({action:'create',actionId:'create-b',name:'B',directory:other}).result,bindings=new Map();
  tasks.projects={store,taskBinding(requestId){if(requestId){const binding=bindings.get(requestId);if(!binding)throw Error('project_work_request_required');return binding;}const state=store.state();if(state.focus!=='work')throw Error('project_work_request_required');return this.forProject(state.projectId);},
    forProject(id){const p=store.active(id);return {projectId:id,cwd:p.workspace,projectRevision:p.revision,projectContext:store.context(id)};}};
  const rt={home,state:{mainBotIds:['chief'],bots:{chief:{id:'chief',name:'Nova',role:'总管'}}},botOf(id){return this.state.bots[id];}};
  tasks.team=new TeamRegistry({rt,db:ops.db,workspace});tasks.team.tasks=tasks;
  const bind=(requestId,projectId)=>{const binding=tasks.projects.forProject(projectId);bindings.set(requestId,binding);return binding;};
  t.after(async()=>{await tasks.close();ops.close();rmSync(home,{recursive:true,force:true});});
  return {home,workspace,other,ops,tasks,store,b,bind,select(projectId,focus='work'){store.select({actionId:'select-'+Math.random().toString(36).slice(2),projectId,focus,revision:store.state().revision});},
    finish(id,status='completed'){const task=tasks.row('task',id),run=tasks.row('run',task.runId),job=tasks.row('job',run.jobId);tasks.finish(task,run,job,{status,exitCode:status==='completed'?0:1,cleanupConfirmed:true});return tasks.detail(id);}};
}

test('request-bound commands keep their project, cwd and retry identity after selection changes',t=>{
  const f=fixture(t);mkdirSync(join(f.workspace,'sub'));f.bind('request-a',DEFAULT_PROJECT_ID);
  const input={id:'command-a',title:'A command',command:'true',workdir:'sub',managementEnabled:false},a=f.tasks.create(input,{requestId:'request-a'});
  f.select(f.b.id);f.bind('request-b',f.b.id);
  assert.equal(f.tasks.workspace,f.workspace);assert.equal(a.task.projectId,DEFAULT_PROJECT_ID);assert.equal(a.task.cwd,join(f.workspace,'sub'));assert.equal(a.task.sourceWorkspace,f.workspace);
  assert.equal(a.runs[0].projectId,DEFAULT_PROJECT_ID);assert.equal(a.runs[0].job.projectId,DEFAULT_PROJECT_ID);
  const retry=f.tasks.create(input,{requestId:'request-b'});assert.equal(retry.task.runId,a.task.runId);assert.equal(retry.task.cwd,a.task.cwd);
  const b=f.tasks.create({id:'command-b',title:'B command',command:'true',managementEnabled:false},{requestId:'request-b'});
  assert.equal(b.task.projectId,f.b.id);assert.equal(b.task.cwd,f.other);assert.equal(b.task.projectName,'B');
  assert.deepEqual(f.tasks.list({projectId:DEFAULT_PROJECT_ID}).tasks.map(t=>t.id),['command-a']);assert.equal(f.tasks.list({projectId:f.b.id}).total,1);
  assert.equal(f.tasks.list({projectId:null}).total,0);assert.throws(()=>f.tasks.list({projectId:'bad/id'}),/invalid_task_project/);
});

test('same-directory projects stay separate and tool submission validates inputs in its bound project',t=>{
  const f=fixture(t),same=f.store.mutate({action:'create',actionId:'same-dir',name:'same directory B',directory:f.workspace}).result;
  f.bind('a',DEFAULT_PROJECT_ID);f.bind('same',same.id);
  f.tasks.create({id:'a',title:'same title',command:'true'},{requestId:'a'});f.tasks.create({id:'b',title:'same title',command:'true'},{requestId:'same'});
  assert.equal(f.tasks.list({projectId:same.id}).tasks[0].id,'b');assert.equal(f.tasks.list({projectId:DEFAULT_PROJECT_ID}).tasks[0].id,'a');
  writeFileSync(join(f.other,'b-only.txt'),'B content');const binding=f.bind('b-file',f.b.id),tools=taskTools(f.tasks,()=>({id:'b-file',projectId:f.b.id,binding}));
  const start=tools.find(([name])=>name==='background_agent_start')[3],input={title:'read B',goal:'read requested input',workspaceMode:'documents',inputFiles:['b-only.txt'],managementEnabled:false};
  const task=start(input);assert.equal(task.task.cwd,f.other);assert.equal(start(input).task.id,task.task.id);
  assert.deepEqual(tools.find(([name])=>name==='background_task_list')[3]().tasks.map(t=>t.id),[task.task.id]);
});

test('checks and supervisor work inherit the original project after daily focus and archiving',t=>{
  const f=fixture(t);f.bind('a',DEFAULT_PROJECT_ID);
  const parent=f.tasks.create({id:'parent',kind:'agent',title:'A task',goal:'A work',managementEnabled:false},{requestId:'a'});
  f.select(f.b.id,'daily');f.store.mutate({action:'archive',actionId:'archive-a',projectId:DEFAULT_PROJECT_ID,revision:f.store.get(DEFAULT_PROJECT_ID).revision});
  assert.throws(()=>f.tasks.create({id:'daily',title:'no work binding',command:'true'}),/project_work_request_required/);
  const check=f.tasks.create({id:'check',title:'check A',command:'true'},{check:{taskId:parent.task.id,runId:parent.task.runId,workspace:f.workspace}});
  const review=f.tasks.create({id:'review',kind:'agent',title:'review A',goal:'verify A'},{source:'supervisor',managementReview:{targetTaskId:parent.task.id,targetRunId:parent.task.runId}});
  assert.equal(check.task.projectId,DEFAULT_PROJECT_ID);assert.equal(review.task.projectId,DEFAULT_PROJECT_ID);assert.equal(review.task.cwd,f.workspace);
  assert.equal(f.tasks.row('task','parent').runId,parent.task.runId);assert.equal(f.tasks.row('task','parent').status,'queued');
});

test('reports, immutable events, provenance, candidate sources and retries keep the original project',t=>{
  const f=fixture(t);f.bind('a',DEFAULT_PROJECT_ID);
  const a=f.tasks.create({id:'fails',title:'failed A',command:'false',managementEnabled:false},{requestId:'a'});f.select(f.b.id);
  const detail=f.finish('fails','failed'),report=f.tasks.reports.current(detail.task);
  assert.equal(report.projectId,DEFAULT_PROJECT_ID);assert.equal(report.taskContext.projectId,DEFAULT_PROJECT_ID);assert.equal(report.status,'failed');
  const event=JSON.parse(f.ops.db.prepare('SELECT body FROM team_event WHERE id=?').get(report.eventId).body);assert.equal(event.projectId,DEFAULT_PROJECT_ID);
  assert.equal(f.store.summary(DEFAULT_PROJECT_ID).tasks[0].status,'failed');assert.equal(f.store.summary(f.b.id).reports.length,0);
  const retried=f.tasks.retry({id:'fails',runId:a.task.runId,actionId:'retry'});assert.equal(retried.task.projectId,DEFAULT_PROJECT_ID);assert.equal(retried.runs[1].projectId,DEFAULT_PROJECT_ID);assert.equal(retried.task.cwd,f.workspace);
  const candidate=experienceCandidate(detail.task,report,{id:'review-1'});assert.equal(candidate.source.projectId,DEFAULT_PROJECT_ID);
});

test('employee identity is shared while mixed legacy memories are excluded from project tasks',t=>{
  const f=fixture(t);for(const name of ['bots/chief','team']){mkdirSync(join(f.home,'memory',name),{recursive:true});writeFileSync(join(f.home,'memory',name,'MEMORY.md'),'LEGACY_OTHER_PROJECT_PRIVATE');}
  const old=f.tasks.team.snapshot({});assert.match(old.memory.own,/LEGACY/);
  f.bind('a',DEFAULT_PROJECT_ID);const task=f.tasks.create({id:'scoped',kind:'agent',title:'project task',goal:'finish this project',managementEnabled:false},{requestId:'a'});
  assert.equal(task.runs[0].employee.name,'Nova');assert.equal(task.runs[0].employee.projectId,DEFAULT_PROJECT_ID);
  assert.equal(task.runs[0].employee.memory.legacyExcluded,true);assert.ok(!JSON.stringify(task.runs[0].employee).includes('LEGACY_OTHER_PROJECT_PRIVATE'));
});

test('lost acknowledgement returns the original task after the input file has changed or disappeared',t=>{
  const f=fixture(t);writeFileSync(join(f.other,'input.txt'),'original');f.bind('b',f.b.id);
  const input={id:'once',kind:'agent',title:'B task',goal:'read input',workspaceMode:'documents',inputFiles:['input.txt'],managementEnabled:false};
  const first=f.tasks.create(input,{requestId:'b'});rmSync(join(f.other,'input.txt'));f.select(DEFAULT_PROJECT_ID);
  assert.equal(f.tasks.create(input).task.runId,first.task.runId);assert.equal(f.tasks.create(input).task.projectId,f.b.id);
});

test('changing one project directory does not rebase its accepted command, artifacts or retries',t=>{
  const f=fixture(t);f.bind('before',DEFAULT_PROJECT_ID);writeFileSync(join(f.workspace,'output.txt'),'ORIGINAL A');writeFileSync(join(f.other,'output.txt'),'NEW DIRECTORY');
  const input={id:'before',title:'original directory',command:'false',artifacts:['output.txt'],managementEnabled:false};const first=f.tasks.create(input,{requestId:'before'});
  f.store.mutate({action:'update',actionId:'move-same-project',projectId:DEFAULT_PROJECT_ID,revision:1,directory:f.other});f.bind('after',DEFAULT_PROJECT_ID);
  const next=f.tasks.create({id:'after',title:'new directory',command:'true',managementEnabled:false},{requestId:'after'});assert.equal(next.task.cwd,f.other);assert.equal(next.task.projectId,first.task.projectId);
  const completed=f.finish('before','failed');assert.equal(completed.task.cwd,f.workspace);assert.equal(completed.runs[0].job.artifacts[0].path,join(f.workspace,'output.txt'));
  const retry=f.tasks.retry({id:'before',runId:first.task.runId,actionId:'retry-old-directory'});assert.equal(retry.task.cwd,f.workspace);assert.equal(retry.task.sourceWorkspace,f.workspace);assert.equal(retry.runs[1].projectId,DEFAULT_PROJECT_ID);
});

test('web new-task admission requires a project snapshot instead of silently accepting current selection',async t=>{
  const f=fixture(t),projects=new ProjectService({ops:f.ops,store:f.store}),handle=createControls({ops:f.ops,tasks:f.tasks,projects,requests:{exclusive:fn=>fn()}});
  f.select(f.b.id);
  await assert.rejects(handle('/background-task-start',{id:'stale-page',title:'intended for A',command:'true',webClient:true}),/project_state_changed/);
  assert.throws(()=>f.tasks.row('task','stale-page'),/unknown_task/);
});

test('web same-ID replay returns an accepted task after project selection changes',async t=>{
  const f=fixture(t),projects=new ProjectService({ops:f.ops,store:f.store}),handle=createControls({ops:f.ops,tasks:f.tasks,projects,requests:{exclusive:fn=>fn()}});
  const input={id:'lost-web-ack',title:'A task',command:'true',expectedProject:f.store.state()},first=await handle('/background-task-start',input);
  f.select(f.b.id);const replay=await handle('/background-task-start',input);
  assert.equal(replay.task.id,first.task.id);assert.equal(replay.task.runId,first.task.runId);assert.equal(replay.task.projectId,DEFAULT_PROJECT_ID);assert.equal(f.store.state().projectId,f.b.id);
});

test('a file research task owns admitted PDF bytes before its first run; replay and reassignment do not reopen the live file',async t=>{
  const f=fixture(t),input={id:'fixed-edition',kind:'agent',title:'研究资料',goal:'对照资料',inputFiles:['report.pdf'],documentOutputPath:'结论.docx'};
  const root=join(f.workspace,'资料');mkdirSync(root);const path=join(root,'report.pdf'),v1=Buffer.from('%PDF-1.7\nversion ONE');
  writeFileSync(path,v1);f.bind('accept',DEFAULT_PROJECT_ID);
  const task=f.tasks.create(input,{requestId:'accept'}).task,snap=task.inputSnapshot;
  assert.equal(task.workspaceMode,'documents');assert.equal(task.documentResearch,true);assert.equal(snap.projectId,DEFAULT_PROJECT_ID);
  assert.deepEqual(task.inputFiles,['资料/report.pdf']);assert.equal(task.documentOutputPath,join(f.workspace,'结论.docx'));
  f.select(f.b.id);rmSync(path);writeFileSync(join(f.other,'report.pdf'),'%PDF-1.7\nwrong project');
  assert.deepEqual(f.tasks.create(input,{requestId:'accept'}).task.inputSnapshot,snap);
  for(const assignmentVersion of [1,2]){
    const w=await prepareDocuments({home:f.tasks.agentHome({...task,assignmentVersion}),source:task.cwd,mode:task.mode,
      workspaceMode:task.workspaceMode,inputSnapshot:snap,inputFiles:task.inputFiles});
    const p=join(w.path,task.inputFiles[0]);assert.deepEqual(readFileSync(p),v1);writeFileSync(p,'worker change');
    assert.deepEqual(readTaskInputBytes(f.home,snap.files[0]),v1);
  }
  writeFileSync(snap.files[0].snapshotPath,'%PDF-1.7\nversion TWO');assert.throws(()=>readTaskInputBytes(f.home,snap.files[0]),/task_input_snapshot_corrupt/);
});

test('current file uses only the bound project context, external file needs authorization and stale references do not silently pin another version',t=>{
  const f=fixture(t),outside=join(f.home,'外部.pdf'),input={id:'current-doc',kind:'agent',title:'解释',goal:'研究当前文件',documentResearch:true,currentFile:true};
  writeFileSync(outside,'%PDF-1.7\nold');const s=statSync(outside),binding=f.bind('current',DEFAULT_PROJECT_ID);
  assert.throws(()=>f.tasks.create(input,{requestId:'current'}),/current_file_required/);
  assert.throws(()=>f.tasks.create({...input,currentFile:false,inputFiles:[outside]},{requestId:'current'}),/invalid_document_inputs/);
  binding.context={kind:'file',file:{projectId:DEFAULT_PROJECT_ID,path:outside,size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs,ino:s.ino}};
  const t1=f.tasks.create(input,{requestId:'current'}).task;assert.equal(t1.inputSnapshot.files[0].current,true);assert.equal(t1.inputSnapshot.files[0].sourcePath,outside);
  writeFileSync(outside,'%PDF-1.7\nchanged');
  assert.throws(()=>f.tasks.create({...input,id:'stale-current'},{requestId:'current'}),/task_inputs_changed/);
  const currentDisk=statSync(outside);
  const inputVersions=new Map([[outside,{size:currentDisk.size,mtimeMs:currentDisk.mtimeMs,ctimeMs:currentDisk.ctimeMs,ino:currentDisk.ino}]]);
  assert.throws(()=>f.tasks.create({...input,id:'latest-read'},{requestId:'current',inputVersions}),/task_inputs_changed/);
  const named=f.tasks.create({...input,id:'named-fresh',currentFile:false,inputFiles:[outside]},{requestId:'current',inputVersions}).task;
  assert.deepEqual(readTaskInputBytes(f.home,named.inputSnapshot.files[0]),readFileSync(outside));
});

test('submission rejects earlier input replaced while a second document is being snapshotted',t=>{
  const f=fixture(t),first=join(f.workspace,'first.md'),second=join(f.workspace,'second.md');
  writeFileSync(first,'original A');writeFileSync(second,'original B');
  const capture=spawnSync(process.execPath,['--input-type=module','-e',`
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    import assert from 'node:assert/strict';
    const [module,home,source,first]=process.argv.slice(1),link=fs.linkSync;
    let linked=0;
    fs.linkSync=(...args)=>{link(...args);if(++linked===2)fs.writeFileSync(first,'replaced A');};
    syncBuiltinESMExports();
    const {freezeDocumentInputs}=await import(module);
    assert.throws(()=>freezeDocumentInputs({home,source,projectId:'a',inputFiles:['first.md','second.md']}),/task_inputs_changed/);
  `,new URL('../tasks/frozen-documents.mjs',import.meta.url).href,f.home,f.workspace,first],{encoding:'utf8'});
  assert.equal(capture.status,0,capture.stderr);assert.equal(readFileSync(first,'utf8'),'replaced A');
});

test('SIGKILL during first materialization or just after publication resumes from owned copies',async t=>{
  const f=fixture(t),pdf='%PDF-1.7\noriginal A';writeFileSync(join(f.workspace,'source.pdf'),pdf);f.bind('a',DEFAULT_PROJECT_ID);
  for(const phase of ['copy','publish']){
    const task=f.tasks.create({id:'materialize-'+phase,kind:'agent',title:'冻结',goal:'研究',documentResearch:true,inputFiles:['source.pdf']},{requestId:'a'}).task;
    const args={source:task.cwd,home:f.tasks.agentHome(task),mode:task.mode,workspaceMode:task.workspaceMode,inputFiles:task.inputFiles,inputSnapshot:task.inputSnapshot};
    const cut=spawnSync(process.execPath,['--input-type=module','-e',`
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const [module,raw,phase]=process.argv.slice(1),args=JSON.parse(raw),write=fs.writeFileSync,rename=fs.renameSync;
      if(phase==='copy')fs.writeFileSync=(path,bytes,options)=>{
        if(path.endsWith('/source.pdf')){write(path,bytes.subarray(0,2),options);process.kill(process.pid,'SIGKILL');}
        return write(path,bytes,options);
      };
      if(phase==='publish')fs.renameSync=(from,to)=>{rename(from,to);if(to===args.home+'/workspace')process.kill(process.pid,'SIGKILL');};
      syncBuiltinESMExports();
      await (await import(module)).prepareDocuments(args);
    `,new URL('../tasks/documents.mjs',import.meta.url).href,JSON.stringify(args),phase],{encoding:'utf8'});
    assert.equal(cut.signal,'SIGKILL',cut.stderr);
    assert.equal(existsSync(join(args.home,'workspace.json')),false);
    assert.equal(existsSync(join(args.home,'workspace')),phase==='publish');
    const result=await prepareDocuments(args);assert.equal(readFileSync(join(result.path,'source.pdf'),'utf8'),pdf);
    writeFileSync(join(result.path,'source.pdf'),'edited by user');
    assert.deepEqual(await prepareDocuments(args),result);assert.equal(readFileSync(join(result.path,'source.pdf'),'utf8'),'edited by user');
  }
});

test('a pre-existing workspace cannot impersonate an interrupted publication even with matching input files',async t=>{
  const f=fixture(t),pdf='%PDF-1.7\noriginal';writeFileSync(join(f.workspace,'source.pdf'),pdf);f.bind('a',DEFAULT_PROJECT_ID);
  const task=f.tasks.create({id:'workspace-owner',kind:'agent',title:'归属',goal:'研究',documentResearch:true,inputFiles:['source.pdf']},{requestId:'a'}).task;
  const home=f.tasks.agentHome(task),path=join(home,'workspace');
  mkdirSync(path,{recursive:true});writeFileSync(join(path,'source.pdf'),pdf);writeFileSync(join(path,'my-notes.md'),'private');
  await assert.rejects(prepareDocuments({source:task.cwd,home,mode:task.mode,workspaceMode:task.workspaceMode,inputFiles:task.inputFiles,inputSnapshot:task.inputSnapshot}),/task_workspace_missing/);
  assert.equal(readFileSync(join(path,'my-notes.md'),'utf8'),'private');assert.equal(existsSync(join(home,'workspace.json')),false);
});

test('research refuses ambiguous names, unsupported requested output and existing or read-only destinations before queuing',t=>{
  const f=fixture(t),input={id:'input-validation',kind:'agent',title:'资料',goal:'资料',workspaceMode:'documents',inputFiles:['sample.pdf']};f.bind('x',DEFAULT_PROJECT_ID);
  const p=join(f.workspace,'sample.pdf');writeFileSync(p,'%PDF-1.7\nfirst');
  mkdirSync(join(f.workspace,'子'));writeFileSync(join(f.workspace,'子','sample.pdf'),'%PDF-1.7\nsecond');
  assert.throws(()=>f.tasks.create(input,{requestId:'x'}),/ambiguous_task_input/);
  const clear={...input,inputFiles:['子/sample.pdf']};assert.throws(()=>f.tasks.create({...clear,documentOutputPath:'report.md'},{requestId:'x'}),/invalid_document_output/);
  assert.throws(()=>f.tasks.create({...clear,permission:'read-only',documentOutputPath:'report.pdf'},{requestId:'x'}),/task_document_write_denied/);
  assert.throws(()=>f.tasks.create({...clear,documentOutputPath:p},{requestId:'x'}),/document_target_exists/);
  assert.throws(()=>f.tasks.create({...clear,documentOutputPath:'子/sample.pdf'},{requestId:'x'}),/task_document_input_output_conflict/);
  const general=f.tasks.create({...input,id:'ordinary-pdf',workspaceMode:undefined},{requestId:'x'}).task;
  assert.equal(general.workspaceMode,'general');assert.equal(general.documentResearch,undefined);
  const plain=f.tasks.create({...input,id:'ordinary-documents',workspaceMode:'documents',inputFiles:[]},{requestId:'x'}).task;
  assert.equal(plain.documentResearch,undefined);assert.equal(plain.inputSnapshot,undefined);
});

test('a real queued worker rejects changed input before starting a Harness or copying version 2',async t=>{
  const f=fixture(t),path=join(f.workspace,'input.txt');writeFileSync(path,'version one');f.bind('a',DEFAULT_PROJECT_ID);
  const task=f.tasks.create({id:'queued-input',kind:'agent',title:'Pinned input',goal:'read explicit input',inputFiles:['input.txt'],managementEnabled:false},{requestId:'a'}).task;
  assert.equal(task.status,'queued');assert.equal(task.inputSnapshot.files.length,1);assert.match(task.inputSnapshot.files[0].sha256,/^[a-f0-9]{64}$/);
  const listed=f.tasks.list().tasks[0];assert.equal(listed.inputSnapshot,undefined);assert.equal(listed.projectContext,undefined);assert.ok(f.tasks.detail(task.id).task.projectContext);
  writeFileSync(path,'version TWO changed while queued');f.tasks.launch(task);
  const deadline=Date.now()+8000;let detail;
  while(Date.now()<deadline){TaskManager.prototype.tick.call(f.tasks);detail=f.tasks.detail(task.id);if(detail.task.status==='failed'&&detail.task.cleanupConfirmed)break;await delay(30);}
  assert.equal(detail.task.status,'failed',f.tasks.log({id:task.id}).text);assert.equal(detail.task.error,'task_inputs_changed');assert.equal(detail.runs[0].result.error,'task_inputs_changed');
  assert.equal(existsSync(join(f.tasks.agentHome(task),'workspace','input.txt')),false);assert.equal(existsSync(join(f.tasks.directory(detail.runs[0].job),'runtime.patch.json')),false);
  assert.equal(f.tasks.reports.current(detail.task).error,'task_inputs_changed');assert.equal(readFileSync(path,'utf8'),'version TWO changed while queued');
});

test('an existing input copy survives source changes and continuation does not revalidate original bytes',async t=>{
  const f=fixture(t),path=join(f.workspace,'input.txt');writeFileSync(path,'PINNED VERSION ONE');f.bind('a',DEFAULT_PROJECT_ID);
  const task=f.tasks.create({id:'has-copy',kind:'agent',title:'Pinned input',goal:'read input',inputFiles:['input.txt'],managementEnabled:false},{requestId:'a'}).task;
  const args={source:task.cwd,home:f.tasks.agentHome(task),workspaceMode:task.workspaceMode,mode:task.mode,inputFiles:task.inputFiles,inputSnapshot:task.inputSnapshot};
  const prepared=await prepareDocuments(args);writeFileSync(path,'VERSION TWO');assert.deepEqual(await prepareDocuments(args),prepared);rmSync(path);assert.deepEqual(await prepareDocuments(args),prepared);
  assert.equal(readFileSync(join(prepared.path,'input.txt'),'utf8'),'PINNED VERSION ONE');
});

test('a reference changed before task submission requires a trusted fresh read, which then pins the new version',t=>{
  const f=fixture(t),path=join(f.workspace,'input.txt');writeFileSync(path,'VERSION ONE');
  f.store.mutateReference({action:'add',actionId:'source-ref',projectId:DEFAULT_PROJECT_ID,revision:1,kind:'file',path});f.bind('a',DEFAULT_PROJECT_ID);writeFileSync(path,'VERSION TWO');
  const input={id:'changed-before-submit',kind:'agent',title:'read changed source',goal:'use latest read',inputFiles:['input.txt'],managementEnabled:false};
  assert.throws(()=>f.tasks.create(input,{requestId:'a'}),/task_inputs_changed/);assert.throws(()=>f.tasks.row('task',input.id),/unknown_task/);
  const s=statSync(path),inputVersions=new Map([[realpathSync(path),{size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs,ino:s.ino}]]);
  const task=f.tasks.create(input,{requestId:'a',inputVersions}).task;assert.equal(task.inputSnapshot.files[0].size,s.size);assert.equal(task.projectContext.references[0].version.size,'VERSION ONE'.length);
});
