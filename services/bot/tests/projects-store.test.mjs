import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,statSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProjectStore,DEFAULT_PROJECT_ID} from '../projects/store.mjs';

function fixture(t,seed){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'nova-projects-'))),home=join(root,'home'),workspace=join(root,'workspace'),other=join(root,'ordinary-folder'),events=[];
  mkdirSync(home);mkdirSync(workspace);mkdirSync(other);
  let db=new DatabaseSync(join(home,'state.sqlite')),store;
  db.exec('CREATE TABLE records (id TEXT PRIMARY KEY,kind TEXT NOT NULL,body TEXT NOT NULL)');
  seed?.({db,home,workspace,other});
  const open=()=>new ProjectStore({ops:{db},home,workspace,events:{publish:(...args)=>events.push(args)}});store=open();
  t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
  return {root,home,workspace,other,events,get db(){return db;},get store(){return store;},
    reopen(){db.close();db=new DatabaseSync(join(home,'state.sqlite'));store=open();return store;},
    project(input={}){return store.mutate({action:'create',actionId:'create-'+Math.random().toString(36).slice(2),name:'资料项目',...input}).result;},
    ref(input={}){const projectId=input.projectId??DEFAULT_PROJECT_ID;return store.mutateReference({action:'add',actionId:'ref-'+Math.random().toString(36).slice(2),projectId,revision:store.get(projectId).revision,...(!input.action||input.action==='add'?{kind:'file',path:join(workspace,'notes.md')}:{}),...input}).result;},
    source(id='request-1',projectId=DEFAULT_PROJECT_ID){const request={id,kind:'request',input:'采用新方案',projectId,status:'completed'};db.prepare('INSERT OR REPLACE INTO records VALUES (?,?,?)').run(id,request.kind,JSON.stringify(request));return {sourceRequestId:id,source:{kind:'user',quote:request.input}};},
    record(input={}){const projectId=input.projectId??DEFAULT_PROJECT_ID;return store.mutateRecord({action:'add',actionId:'record-'+Math.random().toString(36).slice(2),projectId,revision:store.get(projectId).revision,type:'decision',text:'采用新方案',...this.source('request-'+Math.random().toString(36).slice(2),projectId),...input}).result;}
  };
}

test('stable projects support ordinary folders and managed workspaces without Git or tasks',t=>{
  const f=fixture(t),initial=f.store.get(DEFAULT_PROJECT_ID),ordinary=f.project({directory:f.other}),managed=f.project();
  assert.equal(initial.directory,f.workspace);assert.equal(ordinary.directory,f.other);assert.equal(managed.directory,null);assert.equal(managed.managedWorkspace,true);
  assert.ok(managed.workspace.startsWith(join(f.home,'projects',managed.id)));assert.equal(statSync(managed.workspace).isDirectory(),true);
  const changed=f.store.mutate({action:'update',actionId:'rename',projectId:managed.id,revision:1,name:'更名',directory:f.other}).result;
  assert.equal(changed.id,managed.id);assert.equal(changed.workspace,f.other);assert.equal(f.store.history('project',managed.id)[0].name,'资料项目');
  f.reopen();assert.equal(f.store.get(managed.id).name,'更名');assert.equal(f.store.list().length,3);assert.equal(f.store.hasTable('background_task'),false);
});

test('selection revision, action replay and archive preserve the resumable project and existing task',t=>{
  const f=fixture(t,({db,workspace})=>{
    db.exec('CREATE TABLE background_task(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
    db.prepare('INSERT INTO background_task VALUES (?,?)').run('task-1',JSON.stringify({id:'task-1',cwd:workspace,status:'running',sessionId:'session-1'}));
  });
  const taskBefore=f.db.prepare('SELECT body FROM background_task').get().body,body={actionId:'daily',focus:'daily',revision:1};
  assert.equal(f.store.select(body).state.projectId,DEFAULT_PROJECT_ID);assert.equal(f.store.state().focus,'daily');
  f.store.select({actionId:'back',focus:'work',revision:2});
  assert.equal(f.store.select(body).replayed,true);assert.equal(f.store.state().focus,'work');
  assert.throws(()=>f.store.select({...body,focus:'work'}),/project_action_conflict/);
  assert.throws(()=>f.store.select({...body,actionId:'stale'}),/project_state_changed/);
  f.store.mutate({action:'archive',actionId:'archive',projectId:DEFAULT_PROJECT_ID,revision:1});
  assert.deepEqual(f.store.state(),{projectId:DEFAULT_PROJECT_ID,focus:'daily',revision:4});
  assert.equal(f.db.prepare('SELECT body FROM background_task').get().body,taskBefore);
  assert.throws(()=>f.store.select({actionId:'closed',focus:'work',revision:4}),/project_archived/);
  f.store.mutate({action:'restore',actionId:'restore',projectId:DEFAULT_PROJECT_ID,revision:2});
  assert.equal(f.store.state().focus,'daily');assert.equal(f.db.prepare('SELECT body FROM background_task').get().body,taskBefore);
});

test('idempotency survives restart and mutations reject stale project views',t=>{
  const f=fixture(t),body={action:'create',actionId:'once',name:'one'};
  const first=f.store.mutate(body).result;f.reopen();assert.equal(f.store.mutate(body).result.id,first.id);
  f.store.mutate({action:'update',actionId:'change',projectId:first.id,revision:1,name:'changed'});
  assert.equal(f.store.mutate(body).replayed,true);assert.equal(f.store.get(first.id).name,'changed');
  assert.throws(()=>f.store.mutate({...body,name:'different'}),/project_action_conflict/);
  assert.throws(()=>f.store.mutate({action:'update',actionId:'stale',projectId:first.id,revision:1,name:'old'}),/project_changed/);
  assert.equal(f.events.filter(([name])=>name==='projects.updated').length,2);
});

test('file associations expose metadata, detect changes and preserve versions across purpose edits',t=>{
  const f=fixture(t),path=join(f.other,'notes.md');writeFileSync(path,'SECRET_SOURCE_BODY');
  const ref=f.ref({path}),before=f.store.references(DEFAULT_PROJECT_ID)[0];
  assert.equal(ref.readStatus,'unread');assert.equal(ref.readCapability,'text_file');assert.equal(ref.availability,'available');
  assert.ok(!JSON.stringify(f.store.detail(DEFAULT_PROJECT_ID)).includes('SECRET_SOURCE_BODY'));
  writeFileSync(path,'SECRET_CHANGED_SOURCE_BODY');
  assert.equal(f.store.references(DEFAULT_PROJECT_ID)[0].availability,'changed');
  f.ref({action:'update',referenceId:ref.id,purpose:'只改用途'});
  assert.equal(f.store.references(DEFAULT_PROJECT_ID)[0].version.fingerprint,before.version.fingerprint);
  assert.equal(f.store.references(DEFAULT_PROJECT_ID)[0].availability,'changed');
  f.ref({action:'refresh',referenceId:ref.id});
  assert.equal(f.store.references(DEFAULT_PROJECT_ID)[0].availability,'available');
  rmSync(path);assert.equal(f.store.references(DEFAULT_PROJECT_ID)[0].availability,'missing');
  assert.throws(()=>f.ref({action:'update',referenceId:ref.id,revision:1,purpose:'stale'}),/project_changed/);
});

test('removed associations leave files intact and stop default context injection; move checks both projects',t=>{
  const f=fixture(t);writeFileSync(join(f.workspace,'notes.md'),'kept');
  const ref=f.ref(),target=f.project({directory:f.other});
  f.ref({action:'remove',referenceId:ref.id});
  assert.equal(readFileSync(ref.path,'utf8'),'kept');assert.deepEqual(f.store.references(DEFAULT_PROJECT_ID),[]);assert.deepEqual(f.store.context(DEFAULT_PROJECT_ID).references,[]);
  assert.equal(f.store.references(DEFAULT_PROJECT_ID,{includeRemoved:true})[0].status,'removed');
  f.ref({action:'restore',referenceId:ref.id});
  assert.throws(()=>f.ref({action:'move',referenceId:ref.id,targetProjectId:target.id,targetRevision:0}),/project_changed/);
  assert.equal(f.store.references(DEFAULT_PROJECT_ID).length,1);
  f.ref({action:'move',referenceId:ref.id,targetProjectId:target.id,targetRevision:1});
  assert.equal(f.store.references(DEFAULT_PROJECT_ID).length,0);assert.equal(f.store.references(target.id)[0].id,ref.id);
  assert.equal(f.store.get(target.id).revision,2);assert.equal(f.store.history('reference',ref.id).length,3);
});

test('URL, selection, directory, PDF and artifact association does not imply content reading',t=>{
  const f=fixture(t),pdf=join(f.other,'paper.pdf');writeFileSync(pdf,'%PDF metadata only');
  const urlRef=f.ref({kind:'url',url:'https://example.org/read#part'});assert.equal(urlRef.readCapability,'web_page');assert.equal(urlRef.readStatus,'unread');assert.equal(urlRef.availability,'unknown');
  const selection=f.ref({kind:'selection',url:'https://example.org',version:{documentRevision:0,selectionHash:'selection-1'}});assert.equal(selection.readCapability,'selection');
  assert.throws(()=>f.ref({kind:'selection',url:'https://example.org'}),/invalid_project_selection_version/);
  const paper=f.ref({path:pdf});assert.equal(paper.readCapability,'native_file');assert.equal(paper.readStatus,'unread');
  const legacy={...paper,readCapability:'metadata_only'};const observed=f.store.observed(legacy);assert.equal(observed.readCapability,'native_file');assert.equal(observed.readStatus,'unread');assert.equal(observed.revision,paper.revision);assert.deepEqual(observed.version,paper.version);assert.equal(legacy.readCapability,'metadata_only');assert.equal(f.ref({kind:'directory',path:f.other}).readCapability,'directory_listing');
  assert.equal(f.ref({kind:'artifact',path:pdf,source:{taskId:'task-1',reportId:'report-1'}}).readCapability,'artifact');
  assert.throws(()=>f.ref({kind:'url',url:'file:///private/secret'}),/invalid_project_url/);
  assert.throws(()=>f.ref({path:'relative.md'}),/invalid_project_path/);
});

test('record provenance prevents daily, cross-project and assistant suggestions becoming user decisions',t=>{
  const f=fixture(t),target=f.project();
  const input={action:'add',actionId:'bad',projectId:DEFAULT_PROJECT_ID,revision:1,type:'decision',text:'adopt',...f.source('daily',null)};
  assert.throws(()=>f.store.mutateRecord(input),/project_record_source_mismatch/);
  assert.throws(()=>f.store.mutateRecord({...input,...f.source('other',target.id)}),/project_record_source_mismatch/);
  assert.throws(()=>f.store.mutateRecord({...input,...f.source('work'),source:{kind:'assistant'}}),/project_decision_requires_user_source/);
  const option=f.record({type:'option',source:{kind:'assistant'}});assert.equal(option.type,'option');assert.equal(f.store.summary(DEFAULT_PROJECT_ID).decisions.length,0);
});

test('record correction, supersession and retirement retain provenance and rebuild current summaries',t=>{
  const f=fixture(t),option=f.record({type:'option',text:'考虑 A'}),decision=f.record({action:'supersede',recordId:option.id,type:'decision',text:'采用 A'});
  assert.equal(decision.supersedes,option.id);assert.equal(f.store.records(DEFAULT_PROJECT_ID,{includeRetired:true}).find(r=>r.id===option.id).status,'superseded');
  f.record({action:'update',recordId:decision.id,text:'采用 B'});
  assert.equal(f.store.summary(DEFAULT_PROJECT_ID).decisions[0].text,'采用 B');assert.equal(f.store.history('record',decision.id)[0].text,'采用 A');
  f.reopen();assert.equal(f.store.summary(DEFAULT_PROJECT_ID).decisions[0].text,'采用 B');assert.equal(f.store.summary(DEFAULT_PROJECT_ID).options.length,0);
  f.record({action:'retire',recordId:decision.id});assert.equal(f.store.records(DEFAULT_PROJECT_ID).length,0);assert.equal(f.store.summary(DEFAULT_PROJECT_ID).decisions.length,0);
  assert.throws(()=>f.record({action:'update',recordId:decision.id,text:'revive'}),/project_record_retired/);
});

test('legacy migration uses explicit task evidence, preserves ambiguous chat/memory and delivery fingerprints',t=>{
  const f=fixture(t,({db,workspace,other})=>{
    for(const table of ['background_task','background_run','background_job','background_message','team_report','team_review','team_event','team_outbox'])db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,body TEXT NOT NULL)`);
    const put=(table,value)=>db.prepare(`INSERT INTO ${table} VALUES (?,?)`).run(value.id,JSON.stringify(value));
    put('background_task',{id:'known',cwd:workspace,status:'interrupted',sessionId:'original-session'});
    put('background_task',{id:'child',cwd:other,parentTaskId:'known',status:'failed'});
    put('background_task',{id:'unknown',cwd:other,status:'completed'});
    put('background_task',{id:'daily',cwd:workspace,projectId:null,status:'completed'});
    for(const table of ['background_run','background_job','background_message','team_report','team_review'])put(table,{id:table,taskId:'known',status:'interrupted'});
    put('team_event',{id:'event-1',taskId:'known',status:'delivered'});put('team_outbox',{id:'event-1',fingerprint:'do-not-rehash',receipt:{sessionId:'original-session'}});
    for(const value of [{id:'request-old',kind:'request',input:'朋友的故事',workspace},{id:'memory-old',kind:'memory',text:'mixed fact'},{id:'notice-old',kind:'task_notification',taskId:'known'}])db.prepare('INSERT INTO records VALUES (?,?,?)').run(value.id,value.kind,JSON.stringify(value));
  });
  const read=(table,id)=>JSON.parse(f.db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(id).body);
  assert.equal(read('background_task','known').projectId,DEFAULT_PROJECT_ID);assert.equal(read('background_task','child').projectId,DEFAULT_PROJECT_ID);
  assert.equal(read('background_task','known').sessionId,'original-session');assert.equal(read('background_task','unknown').projectId,undefined);assert.equal(read('background_task','daily').projectId,null);
  assert.equal(read('background_run','background_run').projectId,DEFAULT_PROJECT_ID);assert.equal(read('records','notice-old').projectId,DEFAULT_PROJECT_ID);
  assert.equal(read('records','request-old').projectId,undefined);assert.equal(read('records','memory-old').projectId,undefined);
  assert.equal(read('team_event','event-1').projectId,undefined);assert.equal(read('team_outbox','event-1').fingerprint,'do-not-rehash');
  assert.deepEqual(f.store.migrateLegacy(),{tasks:0,related:0});f.reopen();assert.deepEqual(f.store.migrateLegacy(),{tasks:0,related:0});
  assert.equal(f.store.summary(DEFAULT_PROJECT_ID).tasks.find(task=>task.id==='known').status,'interrupted');
});

test('context is bounded, project-scoped and tracks actual tasks rather than inventing completion',t=>{
  const f=fixture(t),other=f.project();
  for(let i=0;i<12;i++)f.record({type:'decision',text:'Long decision '.repeat(200)});
  f.record({projectId:other.id,text:'OTHER_PROJECT_SECRET'});
  const context=f.store.context(DEFAULT_PROJECT_ID,{maxChars:4000});
  assert.ok(JSON.stringify(context).length<=4000);assert.equal(context.truncated,true);assert.ok(!JSON.stringify(context).includes('OTHER_PROJECT_SECRET'));
  assert.ok(context.summary.decisions.every(record=>record.sourceRequestId&&record.type==='decision'));
  f.store.mutate({action:'archive',actionId:'archive',projectId:DEFAULT_PROJECT_ID,revision:f.store.get(DEFAULT_PROJECT_ID).revision});
  assert.throws(()=>f.store.context(DEFAULT_PROJECT_ID),/project_archived/);assert.equal(f.store.detail(DEFAULT_PROJECT_ID).records.length,12);
});
