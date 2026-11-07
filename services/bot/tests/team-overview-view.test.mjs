import test,{after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {watchPolicyBody,watchPolicyDraft} from '../web/team-overview-view.mjs';

const root=resolve(import.meta.dirname,'../../..'),require=createRequire(join(root,'engine/harness/packages/client/ui-primitives/package.json'));
const {JSDOM}=require('jsdom'),dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react'),{render,fireEvent,act,cleanup,waitFor}=require('@testing-library/react');
const directory=mkdtempSync(join(tmpdir(),'nova-overview-view-'));
const bundle=await build({stdin:{contents:"export {TeamOverview,TeamWatch} from './services/bot/web/team-overview.jsx';export {TaskPanel} from './services/bot/web/tasks.jsx';",resolveDir:root},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',plugins:[{name:'shared-react',setup(builder){builder.onResolve({filter:/^react(?:\/.*)?$/},args=>({path:require.resolve(args.path),external:true}));}}]});
writeFileSync(join(directory,'views.cjs'),bundle.outputFiles[0].text);
const {TeamOverview,TeamWatch,TaskPanel}=require(join(directory,'views.cjs'));
afterEach(()=>cleanup());after(()=>{dom.window.close();rmSync(directory,{recursive:true,force:true});});
const policy={revision:3,enabled:true,dueSoonMs:3600000,blockedMs:1800000,inactiveMs:1800000,raiseQueuedPriority:false};
const watch={policy,alerts:[],total:0,unacknowledged:0};
const overview={counts:{total:105,active:51,attention:4,completed:50,accepted:42,recent:50},members:[],active:[],attention:[],recent:[],watch};
const team={enabled:true,members:[{id:'chief',name:'总管',role:'总管',status:'idle',chief:true,enabled:true,tasks:[]},{id:'employee',name:'资料员',role:'资料',status:'idle',enabled:true,tasks:[]}]};
const change=(view,label,value)=>fireEvent.change(view.getByLabelText(label),{target:{value}});
const task=(id,owner='chief')=>({id,title:'任务 '+id,assignedBotId:owner,supervisorBotId:'chief',ownerName:owner==='chief'?'总管':'资料员',kind:'agent',status:'completed',createdAt:1,updatedAt:2});

test('overview shows full-population counts and opens existing task details without a new reply surface',()=>{
  const selected=[],owners=[],filters=[],data={...overview,active:[task('running')],attention:[{...task('question'),reasons:['需要提供活动名称','已超过约定时间']}],recent:[{...task('result'),resultSummary:'已生成汇总并核对三项数据。',artifactNames:['summary.md']}],members:[{id:'employee',name:'资料员',role:'资料',status:'blocked',activeCount:51,attentionCount:4,latestResult:{taskId:'result',title:'汇总'}}]};
  const view=render(React.createElement(TeamOverview,{overview:data,onSelect:id=>selected.push(id),onOwner:id=>owners.push(id),onFilter:value=>filters.push(value)}));
  assert.match(view.container.textContent,/正在做 51/);assert.match(view.container.textContent,/共 105 项任务.*已验收记录 42/);assert.match(view.container.textContent,/需要提供活动名称；已超过约定时间/);
  assert.ok(view.getByText('已生成汇总并核对三项数据。'));assert.ok(view.getByText('交付：summary.md'));
  fireEvent.click(view.getByText('任务 question'));fireEvent.click(view.getByText('最近成果：汇总'));assert.deepEqual(selected,['question','result']);
  fireEvent.click(view.getByText('资料员'));assert.deepEqual(owners,['employee']);
  fireEvent.click(view.getAllByText('查看全部')[0]);assert.deepEqual(filters,['active']);
  assert.doesNotMatch(view.container.textContent,/回复员工/);
});

test('watch settings preserve revision and require explicit opt-in to automatic queue priority',async()=>{
  const sent=[],view=render(React.createElement(TeamWatch,{api:{call:async(name,body)=>{sent.push({name,body});return {...watch,policy:{...policy,revision:4}};}},watch,onRefresh:()=>{},onSelect:()=>{}}));
  const priority=view.getByLabelText('允许提高逾期任务的排队优先级');assert.equal(priority.checked,false);
  change(view,'到期前提醒（分钟）','15');
  await act(async()=>fireEvent.submit(view.container.querySelector('form')));
  assert.equal(sent[0].name,'team-watch-policy');assert.equal(sent[0].body.revision,3);assert.equal(sent[0].body.dueSoonMs,900000);assert.equal(sent[0].body.raiseQueuedPriority,false);assert.ok(sent[0].body.actionId);
  fireEvent.click(priority);
  await act(async()=>fireEvent.submit(view.container.querySelector('form')));
  assert.equal(sent[1].body.raiseQueuedPriority,true);assert.equal(sent[1].body.revision,4);
});

test('watch policy rejects tiny, blank and invalid durations while preserving explicit zero',()=>{
  const draft=watchPolicyDraft(policy);
  for(const value of ['', '-1','Infinity','no','10081','0.000001'])assert.equal(watchPolicyBody({...draft,inactiveMinutes:value}),null);
  assert.equal(watchPolicyBody({...draft,inactiveMinutes:'0'}).inactiveMs,0);
  assert.equal(watchPolicyBody({...draft,inactiveMinutes:String(1/60)}).inactiveMs,1000);
  const view=render(React.createElement(TeamWatch,{api:{call:async()=>assert.fail('invalid policy must not be sent')},watch,onRefresh:()=>{}}));
  change(view,'无新进展提醒（分钟）','');assert.equal(view.getByText('保存值守设置').disabled,true);
});

test('network retry saves the same policy action instead of duplicating a change',async()=>{
  const sent=[],view=render(React.createElement(TeamWatch,{api:{call:async(name,body)=>{sent.push(body);if(sent.length===1)throw Object.assign(Error('network'),{code:'network'});return {...watch,policy:{...policy,revision:4}};}},watch,onRefresh:()=>{}}));
  await act(async()=>fireEvent.submit(view.container.querySelector('form')));assert.ok(view.getByText('重试保存'));
  change(view,'无新进展提醒（分钟）','90');
  await act(async()=>fireEvent.submit(view.container.querySelector('form')));
  assert.deepEqual(sent[0],sent[1]);assert.equal(sent[1].inactiveMs,1800000);
});

test('acknowledgement binds the precise run and assignment, and stale alerts reload in Chinese',async()=>{
  const selected=[],calls=[];let refreshed=0;
  const alert={id:'alert',taskId:'task',runId:'run-2',assignmentVersion:2,title:'整理资料',reason:'等待前置任务较久',type:'blocked',status:'active'};
  const view=render(React.createElement(TeamWatch,{api:{call:async(name,body)=>{calls.push({name,body});throw Object.assign(Error('watch_alert_stale'),{code:'watch_alert_stale'});}},watch:{...watch,alerts:[alert],total:1,unacknowledged:1},onRefresh:()=>{refreshed++;},onSelect:id=>selected.push(id)}));
  fireEvent.click(view.getByText('整理资料'));assert.deepEqual(selected,['task']);
  await act(async()=>fireEvent.click(view.getByText('已知晓')));
  assert.equal(calls[0].name,'team-watch-ack');assert.deepEqual({...calls[0].body,actionId:undefined},{id:'alert',taskId:'task',runId:'run-2',assignmentVersion:2,actionId:undefined});assert.ok(calls[0].body.actionId);
  assert.match(view.getByRole('alert').textContent,/任务已接续或交接/);assert.equal(refreshed,1);
});

test('watch alerts load every additional page within the selected employee scope',async()=>{
  const alerts=Array.from({length:60},(_,i)=>({id:'a'+i,taskId:'t'+i,runId:'r'+i,assignmentVersion:1,title:'提醒 '+i,reason:'即将到期',type:'due_soon',status:'active',acknowledgedAt:1})),calls=[];
  const api={call:async(name,body)=>{calls.push({name,body});return {...watch,alerts:alerts.slice(body.offset,body.offset+body.limit),total:60,hasMore:body.offset+body.limit<60};}};
  const view=render(React.createElement(TeamWatch,{api,watch:{...watch,alerts:alerts.slice(0,20),total:60,hasMore:true},owner:'employee',onRefresh:()=>{}}));
  await act(async()=>fireEvent.click(view.getByText('加载更多提醒')));
  assert.ok(view.getByText('提醒 59'));assert.equal(view.queryByText('加载更多提醒'),null);
  assert.deepEqual(calls.map(call=>[call.name,call.body.ownerId,call.body.offset]),[['team-watch','employee',0],['team-watch','employee',50]]);
});

test('task owner filtering queries the full store beyond the initial 50 rows and paginates in that scope',async()=>{
  const rows=[...Array.from({length:50},(_,i)=>task('chief-'+i)),...Array.from({length:61},(_,i)=>task('employee-'+i,'employee'))],calls=[];
  const api={call:async(name,body)=>{calls.push({name,body});if(name==='team-overview')return {...overview,counts:{...overview.counts,total:111},watch:undefined};assert.equal(name,'background-tasks');const filtered=rows.filter(row=>!body.ownerId||row.assignedBotId===body.ownerId);return {tasks:filtered.slice(body.offset,body.offset+body.limit),total:filtered.length,hasMore:body.offset+body.limit<filtered.length};}};
  const view=render(React.createElement(TaskPanel,{api,summary:{tasks:rows.slice(0,50)},team,selectedId:null,onSelect:()=>{},online:true}));
  await waitFor(()=>assert.equal(calls.filter(call=>call.name==='background-tasks').length,1));
  await act(async()=>change(view,'按负责人筛选','employee'));
  assert.match(view.container.querySelector('.task-list').textContent,/任务 employee-0/);assert.doesNotMatch(view.container.querySelector('.task-list').textContent,/任务 chief-0/);
  await act(async()=>fireEvent.click(view.getByText('加载更多任务')));
  assert.match(view.container.querySelector('.task-list').textContent,/任务 employee-60/);assert.equal(view.queryByText('加载更多任务'),null);
  assert.match(view.container.textContent,/任务记录 · 61 项/);
  assert.deepEqual(calls.filter(call=>call.name==='background-tasks'&&call.body.ownerId==='employee').map(call=>[call.body.offset,call.body.filter]),[[0,'all'],[0,'all'],[50,'all']]);
  await act(async()=>fireEvent.click([...view.container.querySelectorAll('.task-filters button')].find(button=>button.textContent==='需要你处理')));
  assert.equal(calls.filter(call=>call.name==='background-tasks').at(-1).body.filter,'attention');assert.equal(calls.filter(call=>call.name==='background-tasks').at(-1).body.offset,0);
});

test('late responses from a previous owner cannot replace the selected employee overview or tasks',async()=>{
  let release;const late=new Promise(resolve=>{release=resolve;}),calls=[];
  const api={call:async(name,body)=>{calls.push({name,body});if(body.ownerId==='employee')await late;return name==='team-overview'?{...overview,watch:undefined,active:[task(body.ownerId||'all')]}:{tasks:[task(body.ownerId||'all')],total:1,hasMore:false};}};
  const view=render(React.createElement(TaskPanel,{api,summary:{tasks:[]},team,selectedId:null,onSelect:()=>{},online:true}));
  await act(async()=>{});
  await act(async()=>change(view,'按负责人筛选','employee'));
  await act(async()=>change(view,'按负责人筛选','chief'));
  await act(async()=>{release();await late;});
  assert.equal(view.queryByText('任务 employee'),null);assert.ok(view.getAllByText('任务 chief').length>0);
});
