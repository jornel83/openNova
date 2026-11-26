import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,realpathSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Operations} from '../operations.mjs';
import {Requests} from '../requests.mjs';
import {ProjectStore,DEFAULT_PROJECT_ID} from '../projects/store.mjs';
import {ProjectService} from '../projects/service.mjs';
import {projectTools} from '../projects/tools.mjs';
import {createProjectRouter} from '../projects/routing.mjs';
import {TaskManager,taskTools} from '../tasks/manager.mjs';

async function fixture(t){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-project-service-'))),workspace=join(home,'A'),other=join(home,'B');mkdirSync(other);
  const ops=new Operations({home,workspace}),store=new ProjectStore({ops,home,workspace}),b=store.mutate({action:'create',actionId:'create-b',name:'B',directory:other}).result;
  let current={kind:'none'},session,fail,route={focus:'work',projectId:DEFAULT_PROJECT_ID},classifications=0;
  const calls=[],sessions={async activate({project,focus}){calls.push({projectId:project.id,cwd:project.workspace,focus});session={projectId:project.id,cwd:project.workspace,sessionId:focus==='daily'?'session-daily':'session-'+project.id,focus};if(fail?.(project,focus))throw Error('session_prepare_failed');},capture(){return {...session};}};
  const context={capture:()=>structuredClone(current),restore:value=>{current=structuredClone(value??{kind:'none'});}},router={async classify(input){classifications++;return typeof route==='function'?route(input):route;}};
  const service=new ProjectService({store,ops,sessions,context,router});await service.initialize();
  t.after(()=>{ops.close();rmSync(home,{recursive:true,force:true});});
  return {home,workspace,other,ops,store,b,service,sessions,calls,context,get classifications(){return classifications;},get session(){return session;},setContext(value){current=structuredClone(value);},route(value){route=value;},fail(value){fail=value;},
    entry(id='request-1',input='read work'){const admission=service.admit({expectedProject:service.state()});return ops.submit(id,input,'text',admission.context,admission);},
    active(id='request-1'){const controller=new AbortController();return {id,signal:controller.signal,controller};},
    async select(projectId,focus='work',actionId='select-'+Math.random().toString(36).slice(2)){return service.transition({projectId,focus,revision:service.state().revision,actionId});}};
}

test('ingress references are frozen independently of the resolved target and retained per-project on return',async t=>{
  const f=await fixture(t),reference={kind:'file',file:{id:'A-file',path:join(f.workspace,'same.md'),mtimeMs:1}};f.setContext(reference);
  const record=f.entry();f.setContext({kind:'file',file:{id:'late-file'}});f.route({focus:'work',projectId:f.b.id});
  const result=await f.service.bind(record,f.active());
  assert.equal(record.entryProject.projectId,DEFAULT_PROJECT_ID);assert.equal(record.entryContext.file.id,'A-file');assert.equal(result.binding.projectId,f.b.id);assert.equal(result.binding.cwd,f.other);assert.deepEqual(result.binding.context,{kind:'none'});
  assert.equal(Object.isFrozen(result.binding),true);assert.equal(Object.isFrozen(result.binding.projectContext),true);
  const saved=f.ops.request(record.id);assert.equal(saved.entryProject.projectId,DEFAULT_PROJECT_ID);assert.equal(saved.projectId,f.b.id);
  await f.select(DEFAULT_PROJECT_ID);assert.equal(f.context.capture().file.id,'late-file');
  assert.equal(saved.binding.projectId,f.b.id);assert.equal(f.service.taskBinding(record.id).cwd,f.other);
});

test('daily and ambiguous turns have no working project or task authority; later work resumes its own references',async t=>{
  const f=await fixture(t);f.setContext({kind:'file',file:{id:'work-only'}});const daily=f.entry('daily','我遇到了一个老朋友');f.route({focus:'daily'});
  const result=await f.service.bind(daily,f.active('daily'));
  assert.equal(result.binding.projectId,null);assert.equal(result.binding.resumableProjectId,DEFAULT_PROJECT_ID);assert.equal(f.store.state().projectId,DEFAULT_PROJECT_ID);
  assert.deepEqual(result.binding.context,{kind:'none'});assert.equal(result.binding.projectContext,null);assert.equal(f.ops.request('daily').projectId,null);
  assert.throws(()=>f.service.taskBinding('daily'),/project_work_request_required/);assert.throws(()=>f.service.taskBinding(),/project_work_request_required/);
  const follow=f.entry('daily-follow','他后来换工作了');const followed=await f.service.bind(follow,f.active('daily-follow'));assert.equal(followed.binding.sessionId,result.binding.sessionId);
  const unclear=f.entry('unclear','把这个改一下');f.route({focus:'clarify',question:'你指的是哪份内容？'});assert.match((await f.service.bind(unclear,f.active('unclear'))).question,/哪份/);
  assert.equal(f.ops.request('unclear').projectId,null);assert.throws(()=>f.service.taskBinding('unclear'),/project_work_request_required/);
  await f.select(DEFAULT_PROJECT_ID);assert.equal(f.context.capture().file.id,'work-only');
});

test('dispatch after a same-turn change of decision sees the new choice and the original request inputs',async t=>{
  const f=await fixture(t),projectId=DEFAULT_PROJECT_ID;
  const initial=f.service.record({action:'add',actionId:'original-choice',projectId,revision:1,type:'decision',text:'选 A'}).result;
  f.setContext({kind:'file',file:{id:'file-at-ingress'}});
  const request=f.entry('choose-and-delegate','改选 B，因为成本低，现在按 B 做样稿');
  const {binding}=await f.service.bind(request,f.active(request.id));
  const change={action:'supersede',actionId:'switch-choice',projectId,revision:f.store.get(projectId).revision,recordId:initial.id,type:'decision',text:'改选 B，因为成本低'};
  const chosen=f.service.record(change,request).result;
  f.service.record(change,request); // Replay of an acknowledged record write.
  f.service.record({action:'add',actionId:'later-panel-edit',projectId,revision:f.store.get(projectId).revision,type:'decision',text:'另一次操作提交的新决定'});
  f.setContext({kind:'file',file:{id:'later-file'}});
  await f.select(f.b.id);
  const taskBinding=f.service.taskBinding(request.id);
  assert.deepEqual(taskBinding.projectContext.summary.decisions.map(d=>[d.id,d.text]),[[chosen.id,chosen.text]]);
  assert.equal(taskBinding.context.file.id,'file-at-ingress');
  assert.equal(taskBinding.projectId,projectId);
  assert.equal(taskBinding.cwd,binding.cwd);
  assert.deepEqual(f.ops.request(request.id).binding.projectContext.summary.decisions.map(d=>d.id),[initial.id]);
  const manager=new TaskManager({ops:f.ops,home:f.home,workspace:f.workspace});
  manager.projects=f.service;
  manager.tick=()=>{};
  try{
    const tools=Object.fromEntries(taskTools(manager,()=>request).map(([name,,,invoke])=>[name,invoke]));
    const input={title:'出样稿',goal:'按刚选的方案做样稿',constraints:'只做一页',managementEnabled:false};
    const {task}=tools.background_agent_start(input);
    assert.deepEqual(task.projectContext.summary.decisions.map(d=>[d.id,d.text,d.sourceRequestId]),[[chosen.id,chosen.text,request.id]]);
    assert.equal(task.constraints,input.constraints);
    f.service.record({action:'retire',actionId:'later-retraction',projectId,recordId:chosen.id,revision:f.store.get(projectId).revision},request);
    assert.deepEqual(f.service.taskBinding(request.id).projectContext.summary.decisions,[]);
    assert.equal(tools.background_agent_start(input).task.id,task.id);
    assert.deepEqual(tools.background_task_status({id:task.id}).task.projectContext.summary.decisions,task.projectContext.summary.decisions);
    assert.equal(tools.background_task_list().total,1);
  }finally{await manager.close();}
});

test('one request can be bound only once, including a turn that produced a clarification',async t=>{
  const f=await fixture(t),record=f.entry(),active=f.active();f.route({focus:'clarify',question:'A还是B？'});await f.service.bind(record,active);
  f.route({focus:'work',projectId:f.b.id});await assert.rejects(f.service.bind(record,active),/project_already_bound/);
  assert.equal(f.ops.request(record.id).projectId,null);assert.equal(f.classifications,1);
});

test('a full project summary keeps the same-turn decision and the pinned external input when delegating',async t=>{
  const f=await fixture(t),projectId=DEFAULT_PROJECT_ID,external=join(f.home,'spec.txt');
  writeFileSync(external,'source used for the decision');
  const ref=input=>f.store.mutateReference({action:'add',projectId,revision:f.store.get(projectId).revision,...input}).result;
  const source=ref({actionId:'spec',kind:'file',path:external});
  ref({actionId:'long-link',kind:'url',url:'https://example.org/'+ 'a'.repeat(7600)});
  const other=ref({actionId:'other-link',kind:'url',url:'https://example.com/'});
  const padding=15850-JSON.stringify(f.store.context(projectId)).length;
  ref({action:'update',actionId:'grow-link',referenceId:other.id,url:other.url+'b'.repeat(padding)});
  const request=f.entry('long-context','确定选 B，并按这个选择做样稿');
  const {binding}=await f.service.bind(request,f.active(request.id));
  assert.ok(JSON.stringify(binding.projectContext).length>15700);
  const chosen=f.service.record({action:'add',actionId:'long-choice',projectId,revision:f.store.get(projectId).revision,type:'decision',text:'选 B'.padEnd(700,'据')},request).result;
  const manager=new TaskManager({ops:f.ops,home:f.home,workspace:f.workspace});
  manager.projects=f.service;
  manager.tick=()=>{};
  try{
    const {task}=manager.create({id:'use-spec',kind:'agent',title:'做样稿',goal:'采用当前决定',documentResearch:true,inputFiles:[external],managementEnabled:false},{requestId:request.id});
    assert.deepEqual(task.projectContext.summary.decisions.map(d=>[d.id,d.text]),[[chosen.id,chosen.text]]);
    assert.ok(JSON.stringify(task.projectContext).length<=16000);
    assert.equal(task.inputSnapshot.files[0].sourcePath,source.path);
    assert.equal(task.inputSnapshot.files[0].size,source.version.size);
    assert.equal(task.projectContext.project.id,binding.projectContext.project.id);
    assert.equal(task.sourceWorkspace,binding.cwd);
    assert.equal(binding.projectContext.summary.decisions.length,0);
  }finally{await manager.close();}
});

test('selection receipts survive later selections and restart replay without activating an old session',async t=>{
  const f=await fixture(t),input={projectId:f.b.id,focus:'work',revision:f.service.state().revision,actionId:'choose-b'};
  await f.service.transition(input);await f.select(DEFAULT_PROJECT_ID);const count=f.calls.length,state=f.service.state();
  assert.equal((await f.service.transition(input)).replayed,true);assert.deepEqual(f.service.state(),state);assert.equal(f.calls.length,count);assert.equal(f.session.projectId,DEFAULT_PROJECT_ID);
  await assert.rejects(f.service.transition({...input,projectId:DEFAULT_PROJECT_ID}),/project_action_conflict/);
  assert.equal(f.service.state().projectId,DEFAULT_PROJECT_ID);
});

test('failed session preparation rolls back selection, directory and archive mutations without consuming the action',async t=>{
  const f=await fixture(t),state=f.service.state(),project=f.store.get(DEFAULT_PROJECT_ID);f.setContext({kind:'file',file:{id:'kept'}});
  f.fail(p=>p.id===f.b.id);await assert.rejects(f.select(f.b.id),/session_prepare_failed/);assert.deepEqual(f.service.state(),state);assert.equal(f.session.projectId,DEFAULT_PROJECT_ID);
  f.fail((_p,focus)=>focus==='daily');const archive={action:'archive',actionId:'archive-once',projectId:project.id,revision:project.revision};await assert.rejects(f.service.action(archive),/session_prepare_failed/);
  assert.equal(f.store.get(project.id).status,'active');assert.deepEqual(f.service.state(),state);assert.equal(f.session.focus,'work');
  f.fail(p=>p.workspace===f.other);const update={action:'update',actionId:'directory-once',projectId:project.id,revision:project.revision,directory:f.other};await assert.rejects(f.service.action(update),/session_prepare_failed/);
  assert.deepEqual(f.store.get(project.id),project);assert.equal(f.session.cwd,f.workspace);assert.equal(f.context.capture().file.id,'kept');
  f.fail(null);await f.service.action(update);assert.equal(f.store.get(project.id).workspace,f.other);assert.equal(f.session.cwd,f.other);
  assert.equal((await f.service.action(update)).replayed,true);assert.equal(f.store.get(project.id).revision,project.revision+1);
});

test('late input from the old directory and a selection changed during routing cannot silently rebind',async t=>{
  const f=await fixture(t),old=f.service.state();
  await f.service.action({action:'update',actionId:'new-directory',projectId:DEFAULT_PROJECT_ID,revision:1,directory:f.other});
  assert.notEqual(f.service.state().revision,old.revision);assert.throws(()=>f.service.admit({expectedProject:old}),/project_state_changed/);
  const record=f.entry();let release;const pending=new Promise(resolve=>{release=resolve;});f.route(async()=>{await pending;return {focus:'work',projectId:DEFAULT_PROJECT_ID};});
  const work=f.service.bind(record,f.active());await f.select(f.b.id);release();await assert.rejects(work,/project_state_changed/);
  assert.equal(f.ops.request(record.id).binding,undefined);assert.equal(f.service.state().projectId,f.b.id);
});

test('the real request queue preserves the first ingress and resolved binding on same-ID retries',async t=>{
  const f=await fixture(t);f.route({focus:'work',projectId:f.b.id});const requests=new Requests(f.ops,async(record,active)=>{await f.service.bind(record,active);return {text:'done'};},{admit:input=>f.service.admit(input),context:f.context});
  t.after(()=>requests.close());const first=requests.submit('once','看B资料','text',{expectedProject:f.service.state()});await requests.active.work;
  const saved=f.ops.request('once');await f.select(DEFAULT_PROJECT_ID);const replay=requests.submit('once','看B资料','text',{expectedProject:{projectId:'stale',revision:0}});
  assert.equal(replay.duplicate,true);assert.equal(first.entryProject.projectId,DEFAULT_PROJECT_ID);assert.equal(saved.projectId,f.b.id);assert.equal(replay.binding.projectId,f.b.id);assert.equal(f.classifications,1);
  assert.throws(()=>requests.submit('once','不同要求'),/request_conflict/);assert.equal(f.service.state().projectId,DEFAULT_PROJECT_ID);
});

test('the request queue persists router faults as failed without a reply or project change, while semantic clarification completes',async t=>{
  const f=await fixture(t),before=f.service.state(),session=f.session,initialActivations=f.calls.length;let calls=0,clarifying=false;
  f.service.router=createProjectRouter({ctx:{llm:{async *stream(){
    calls++;
    if(clarifying){yield {type:'text-delta',index:0,text:JSON.stringify({focus:'clarify',projectId:null,reason:'route_unavailable',question:'是甲项目还是乙项目？'})};yield {type:'finish',reason:{kind:'stop'}};}
    else yield {type:'finish',reason:{kind:'error',failure:{code:'network_error',status:503,requestId:'req_router_queue',message:'private-token'}}};
  }}}});
  let executions=0;
  const requests=new Requests(f.ops,async(record,active)=>{
    const resolution=await f.service.bind(record,active);
    if(resolution.question)return {text:resolution.question,speechText:resolution.question};
    executions++;return {text:'unexpected agent execution'};
  },{admit:entry=>f.service.admit(entry),context:f.context});
  t.after(()=>requests.close());
  requests.submit('failed-route','继续项目','text',{expectedProject:before});await requests.active.work;
  const saved=JSON.parse(f.ops.db.prepare('SELECT body FROM records WHERE id=?').get('failed-route').body);
  assert.equal(saved.status,'failed');assert.equal(saved.error,'network_error');
  assert.deepEqual(saved.diagnostic,{type:'error',code:'network_error',stage:'routing',status:503,requestId:'req_router_queue'});
  assert.deepEqual(saved.routing.failure,saved.diagnostic);assert.equal(saved.routing.diagnostics.attempts,2);
  for(const field of ['binding','text','speechText','sessionId'])assert.equal(saved[field],undefined);
  assert.ok(!JSON.stringify(saved).includes('private-token'));assert.equal(executions,0);assert.equal(calls,2);
  assert.deepEqual(f.service.state(),before);assert.deepEqual(f.session,session);assert.equal(f.calls.length,initialActivations);
  clarifying=true;requests.submit('clarified-route','继续那个项目','text',{expectedProject:before});await requests.active.work;
  const clarified=f.ops.request('clarified-route');assert.equal(clarified.status,'completed');assert.equal(clarified.routing.failure,null);
  assert.equal(clarified.binding.focus,'clarify');assert.equal(clarified.text,'是甲项目还是乙项目？');assert.equal(clarified.diagnostic,undefined);
  assert.deepEqual(f.service.state(),before);assert.equal(executions,0);
  assert.deepEqual(f.service.recent(),[{role:'user',text:'继续那个项目'},{role:'assistant',text:clarified.text}]);
});

test('legacy completed router faults stay unchanged and do not become semantic history',async t=>{
  const f=await fixture(t),legacy={id:'legacy-routing-fault',kind:'request',input:'old input',status:'completed',
    text:'话题识别服务暂时不可用，当前项目保持不变，请稍后重试。',binding:{focus:'clarify',projectId:null},
    routing:{focus:'clarify',projectId:null,reason:'route_unavailable',question:'话题识别服务暂时不可用，当前项目保持不变，请稍后重试。'}};
  f.ops.put(legacy);assert.deepEqual(f.service.recent(),[]);assert.deepEqual(f.ops.request(legacy.id),legacy);
  const semantic={...legacy,id:'semantic-reason',input:'choose a project',text:'你想继续哪一个项目？',routing:{...legacy.routing,question:'你想继续哪一个项目？'}};
  f.ops.put(semantic);assert.deepEqual(f.service.recent(),[{role:'user',text:semantic.input},{role:'assistant',text:semantic.text}]);
});

test('panel records use a durable user source and neither daily nor another project supplies provenance',async t=>{
  const f=await fixture(t),input={action:'add',actionId:'panel-decision',projectId:DEFAULT_PROJECT_ID,revision:1,type:'decision',text:'采用 B 方案'};
  const record=f.service.record(input).result,source=f.ops.request(record.sourceRequestId);assert.equal(source.source,'project-panel');assert.equal(source.projectId,DEFAULT_PROJECT_ID);assert.equal(record.source.kind,'user');
  assert.equal(f.service.record(input).replayed,true);assert.throws(()=>f.service.record({...input,text:'changed'}),/project_action_conflict/);
  const daily=f.ops.put({id:'daily',kind:'request',input:'story',projectId:null,binding:{focus:'daily',projectId:null},status:'completed'});
  assert.throws(()=>f.service.record({...input,actionId:'daily-write',revision:2},daily),/project_request_mismatch/);
  const foreign=f.ops.put({id:'foreign',kind:'request',input:'B decision',projectId:f.b.id,binding:{focus:'work',projectId:f.b.id},status:'completed'});
  assert.throws(()=>f.service.record({...input,actionId:'foreign-write',revision:2},foreign),/project_request_mismatch/);
});

test('current selection association checks document revision and rejects a selection from an older page',async t=>{
  const f=await fixture(t),selection={documentId:'document-1',revision:7,text:'chosen passage'};f.setContext({kind:'browser',page:{url:'https://example.org/current'},selection});
  const input={action:'add',actionId:'selection-add',projectId:DEFAULT_PROJECT_ID,revision:1,kind:'selection',expectedSelection:selection};
  f.setContext({kind:'browser',page:{url:'https://example.org/other'},selection:{...selection,documentId:'document-2',revision:8}});assert.throws(()=>f.service.reference(input),/context_changed/);
  assert.equal(f.store.references(DEFAULT_PROJECT_ID).length,0);f.setContext({kind:'browser',page:{url:'https://example.org/current'},selection});
  const reference=f.service.reference(input).result;assert.equal(reference.url,'https://example.org/current');assert.equal(reference.version.revision,7);assert.equal(reference.readStatus,'unread');
});

test('restart with a missing project directory preserves the project and opens daily recovery instead of blocking the host',async t=>{
  const f=await fixture(t);await f.select(f.b.id);const before=f.service.state();rmSync(f.other,{recursive:true});
  await f.service.initialize();const recovered=f.service.state();
  assert.equal(recovered.focus,'daily');assert.equal(recovered.projectId,f.b.id);assert.equal(recovered.revision,before.revision+1);assert.equal(f.session.focus,'daily');
  assert.equal(f.service.view().projects.find(p=>p.id===f.b.id).availability,'missing');assert.equal(f.store.get(f.b.id).directory,f.other);
  await assert.rejects(f.service.transition({projectId:f.b.id,focus:'work',revision:recovered.revision,actionId:'missing-work'}),/project_directory_unavailable/);
  assert.deepEqual(f.service.state(),recovered);
  f.route({focus:'work',projectId:f.b.id});const record=f.entry('missing-request','继续B');const resolution=await f.service.bind(record,f.active(record.id));
  assert.ok(resolution.question);assert.equal(f.ops.request(record.id).binding.focus,'clarify');assert.equal(f.ops.request(record.id).projectId,null);assert.throws(()=>f.service.taskBinding(record.id),/project_work_request_required/);
  mkdirSync(f.other);await f.service.initialize();assert.equal(f.service.state().focus,'daily');assert.equal(f.service.view().projects.find(p=>p.id===f.b.id).availability,'available');
  await f.select(f.b.id);assert.equal(f.session.cwd,f.other);assert.equal(f.service.state().focus,'work');
});

test('a session corruption or preparation error is not silently recategorized as a missing directory',async t=>{
  const f=await fixture(t),before=f.service.state();f.fail(()=>true);
  await assert.rejects(f.service.initialize(),/session_prepare_failed/);assert.deepEqual(f.service.state(),before);assert.equal(f.service.state().focus,'work');
});

test('decision correction uses the bound project revision and a stale attempt preserves the current choice',async t=>{
  const f=await fixture(t),projectId=DEFAULT_PROJECT_ID;
  const original=f.service.record({action:'add',actionId:'adopt-wired',projectId,revision:1,type:'decision',text:'采用有线方案'}).result;
  const turn=f.entry('change-decision','改用无线方案，因为会场取消了网口。');
  const active=f.active(turn.id);
  await f.service.bind(turn,active);
  const tools=projectTools(f.service,()=>active);
  const [,,parameters,record]=tools.find(([name])=>name==='project_record');
  const [,,,context]=tools.find(([name])=>name==='project_context');
  assert.match(parameters.revision.description,/project\.revision/);
  const change={action:'update',recordId:original.id,type:'decision',text:turn.input,quote:turn.input};
  assert.throws(()=>record({...change,revision:original.revision}),/project_changed/);
  const current=context();
  assert.equal(current.project.id,projectId);
  assert.deepEqual(current.records,[original]);
  const corrected=record({...change,revision:current.project.revision}).result;
  assert.equal(corrected.id,original.id);
  assert.equal(corrected.text,turn.input);
  assert.equal(corrected.sourceRequestId,turn.id);
  assert.throws(()=>record({...change,revision:current.project.revision}),/project_changed/);
  assert.deepEqual(context().records,[corrected]);
});

test('superseding a tentative choice accepts its old ID in supersedes and rejects conflicting targets',async t=>{
  const f=await fixture(t),projectId=DEFAULT_PROJECT_ID;
  const option=f.service.record({action:'add',actionId:'maple-option',projectId,revision:1,type:'option',text:'倾向 Maple'}).result;
  const other=f.service.record({action:'add',actionId:'other-choice',projectId:f.b.id,revision:1,type:'option',text:'考虑 Pine'}).result;
  const turn=f.entry('adopt-maple','就选 Maple，因为预算上限是 4000 元。'),active=f.active(turn.id);
  await f.service.bind(turn,active);
  const [,,,record]=projectTools(f.service,()=>active).find(([name])=>name==='project_record');
  const args={action:'supersede',supersedes:option.id,revision:2,type:'decision',text:turn.input,quote:turn.input};
  assert.throws(()=>record({...args,recordId:other.id}),/conflicting_project_record_targets/);
  assert.throws(()=>record({...args,supersedes:other.id}),/unknown_project_record/);
  assert.throws(()=>record({...args,revision:1}),/project_changed/);
  assert.deepEqual(f.store.records(projectId),[option]);
  const adopted=record(args).result;
  assert.equal(adopted.supersedes,option.id);
  assert.equal(adopted.sourceRequestId,turn.id);
  assert.deepEqual(f.store.records(projectId),[adopted]);
  assert.deepEqual(f.store.records(f.b.id),[other]);
  assert.throws(()=>record({...args,revision:3}),/project_record_retired/);
});
