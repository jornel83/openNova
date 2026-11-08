import test,{after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {reviewView,canEditDependencies} from '../web/team-view.mjs';

const root=resolve(import.meta.dirname,'../../..'),require=createRequire(join(root,'engine/harness/packages/client/ui-primitives/package.json'));
const {JSDOM}=require('jsdom'),dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react'),{render,fireEvent,act,cleanup,waitFor}=require('@testing-library/react');
const directory=mkdtempSync(join(tmpdir(),'nova-closure-view-'));
const bundle=await build({stdin:{contents:"export {TaskPanel} from './services/bot/web/tasks.jsx';",resolveDir:root},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',plugins:[{name:'shared-react',setup(builder){builder.onResolve({filter:/^react(?:\/.*)?$/},args=>({path:require.resolve(args.path),external:true}));}}]});
writeFileSync(join(directory,'views.cjs'),bundle.outputFiles[0].text);
const {TaskPanel}=require(join(directory,'views.cjs'));
afterEach(()=>cleanup());after(()=>{dom.window.close();rmSync(directory,{recursive:true,force:true});});
const team={enabled:true,chiefBotId:'chief',members:[{id:'chief',name:'总管',role:'总管',chief:true,enabled:true,tasks:[]},{id:'employee',name:'资料员',role:'资料',enabled:true,tasks:[]}]};
const overview={counts:{total:1},members:[],active:[],attention:[],recent:[]};
function makeDetail(status='failed',closure){
  const task={id:'task',runId:'run',title:'待关闭的资料任务',kind:'agent',workspaceMode:'general',status,assignmentVersion:3,assignedBotId:'employee',supervisorBotId:'chief',ownerName:'资料员',permission:'full',policyVersion:2,canContinue:true,canRetry:true,artifacts:[],goal:'整理资料',question:'请补充活动名称',...(closure?{closure:{status:closure}}:{})};
  const report={id:'report',runId:'run',version:1,assignmentVersion:3,status,summary:'已保存的成果摘要',artifacts:[{id:'artifact',name:'summary.md',status:'available'}],evidence:{execution:{status,exitCode:status==='failed'?1:0,cleanupConfirmed:true},steps:[{id:'step',tool:'read',status:'completed',output:'原始检查记录'}]}};
  return {task,runs:[{id:'run',number:1,status,job:{logPath:'/saved/log',exitCode:status==='failed'?1:0,artifacts:[]},jobs:[]}],teamReview:{current:report,history:[],reviews:[],management:{enabled:true,paused:true,usedReworks:0,maxReworks:2}},automation:{paused:true,rules:[{id:'rule',type:'check',state:'enabled',enabled:true,usedRuns:0,maxRuns:2,expiresAt:Date.now()+60000,instruction:'检查完成后接续'}],deliveries:[]},checks:[],messages:[],applications:[]};
}
function apiFor(read,mutate,calls=[]){return {call:async(name,body)=>{
  calls.push({name,body});
  if(name==='background-task')return read();
  if(name==='background-tasks')return {tasks:[],total:0,hasMore:false};
  if(name==='team-overview')return overview;
  if(name==='background-task-log')return {runId:body.runId,offset:body.offset,nextOffset:body.offset,text:'',hasMore:false};
  return mutate(name,body);
}};}
function panel(api,extra={}){return React.createElement(TaskPanel,{api,summary:{tasks:[]},team,selectedId:'task',onSelect:()=>{},online:true,...extra});}

for(const status of ['failed','waiting_input','completed'])test(`${status} tasks can be closed without replacing their original execution result`,async()=>{
  let detail=makeDetail(status);const calls=[];
  const api=apiFor(()=>detail,async(name)=>{assert.equal(name,'background-task-close');detail={...detail,task:{...detail.task,closure:{status:'closed'}}};return detail;},calls);
  const view=render(panel(api));await waitFor(()=>view.getByRole('button',{name:'关闭任务'}));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'关闭任务'})));
  const sent=calls.find(call=>call.name==='background-task-close').body;
  assert.deepEqual({...sent,actionId:undefined},{id:'task',runId:'run',assignmentVersion:3,actionId:undefined});assert.ok(sent.actionId);
  assert.equal(detail.task.status,status);assert.ok(view.getByRole('button',{name:'恢复到任务列表'}));
  assert.ok(view.getByText('已保存的成果摘要'));assert.match(view.container.textContent,/已从任务列表移除/);
});

test('closing remains visible and blocks duplicate close, restore and execution mutations',async()=>{
  let detail=makeDetail('running');const calls=[];
  const api=apiFor(()=>detail,async(name)=>{assert.equal(name,'background-task-close');detail={...detail,task:{...detail.task,closure:{status:'closing'}}};return detail;},calls);
  const view=render(panel(api));await waitFor(()=>view.getByRole('button',{name:'关闭任务'}));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'关闭任务'})));
  const closing=view.getByRole('button',{name:'正在关闭…'});assert.equal(closing.disabled,true);fireEvent.click(closing);
  assert.equal(calls.filter(call=>call.name==='background-task-close').length,1);
  assert.equal(view.queryByRole('button',{name:'恢复到任务列表'}),null);
  assert.match(view.container.textContent,/确认作业退出后，会从任务列表移除/);
  for(const label of ['取消执行','暂停任务','重新执行','接续任务','要求返工','恢复自动接续','提交交接'])assert.equal(view.queryByRole('button',{name:label}),null);
});

test('closed history keeps evidence and artifact access; restore does not continue or resume automation',async()=>{
  let detail=makeDetail('completed','closed');const calls=[];
  const api=apiFor(()=>detail,async(name)=>{
    if(name==='tasks/report-artifact')return {status:'dispatched'};
    assert.equal(name,'background-task-reopen');detail={...detail,task:{...detail.task}};delete detail.task.closure;return detail;
  },calls);
  const view=render(panel(api));await waitFor(()=>view.getByRole('button',{name:'恢复到任务列表'}));
  assert.equal(reviewView(detail).canAccept,false);assert.equal(canEditDependencies({...detail,task:{...detail.task,status:'queued'}}),false);
  for(const label of ['关闭任务','重新执行','保存补充要求','接续任务','验收通过','要求返工','留待我处理','保存跟进设置','恢复总管跟进','提交交接','恢复自动接续','关闭规则','保存接续规则'])assert.equal(view.queryByRole('button',{name:label}),null);
  assert.equal(view.queryByLabelText('补充要求或接续说明'),null);assert.equal(view.queryByLabelText('回答问题或说明返工要求'),null);
  assert.ok(view.getByText('原始检查记录'));assert.ok(view.getByText('summary.md'));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'打开成果'})));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'恢复到任务列表'})));
  const restored=calls.find(call=>call.name==='background-task-reopen').body;
  assert.equal(restored.id,'task');assert.equal(restored.runId,'run');assert.ok(restored.actionId);
  assert.match(view.container.textContent,/尚未启动执行/);
  assert.equal(calls.some(call=>['background-task-start','background-task-continue','background-task-retry','background-task-automation','tasks/management'].includes(call.name)),false);
});

test('close retry after a network failure uses the same action id',async()=>{
  const detail=makeDetail();let count=0;const calls=[];
  const api=apiFor(()=>detail,async(name)=>{assert.equal(name,'background-task-close');if(++count===1)throw Object.assign(Error('network'),{code:'network'});return {...detail,task:{...detail.task,closure:{status:'closed'}}};},calls);
  const view=render(panel(api));await waitFor(()=>view.getByRole('button',{name:'关闭任务'}));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'关闭任务'})));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'关闭任务'})));
  const sent=calls.filter(call=>call.name==='background-task-close');assert.equal(sent.length,2);assert.deepEqual(sent[0].body,sent[1].body);
});

test('a child of a closed task stays read only and links to its parent',async()=>{
  const detail=makeDetail(),selected=[];detail.task.parentClosure={id:'parent',title:'所属工作任务',status:'closed'};
  const api=apiFor(()=>detail,async()=>assert.fail('read-only child must not dispatch a mutation'));
  const view=render(panel(api,{onSelect:id=>selected.push(id)}));await waitFor(()=>view.getByRole('button',{name:'查看所属任务'}));
  for(const label of ['关闭任务','恢复到任务列表','重新执行','接续任务','验收通过','要求返工','保存跟进设置','提交交接','恢复自动接续'])assert.equal(view.queryByRole('button',{name:label}),null);
  assert.match(view.container.textContent,/请先恢复所属任务/);fireEvent.click(view.getByRole('button',{name:'查看所属任务'}));assert.deepEqual(selected,['parent']);
});

test('a conflicting closure refreshes the latest detail instead of leaving continuation controls visible',async()=>{
  let detail=makeDetail();const calls=[];
  const api=apiFor(()=>detail,async(name)=>{assert.equal(name,'background-task-close');detail={...detail,task:{...detail.task,closure:{status:'closed'}}};throw Object.assign(Error('task_closed'),{code:'task_closed'});},calls);
  const view=render(panel(api));await waitFor(()=>view.getByRole('button',{name:'关闭任务'}));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'关闭任务'})));
  assert.ok(view.getByRole('button',{name:'恢复到任务列表'}));assert.equal(view.queryByRole('button',{name:'接续任务'}),null);
  assert.equal(calls.filter(call=>call.name==='background-task').length,2);
});

test('closed history uses the selected filter and ignores late responses from its previous filter',async()=>{
  let release;const late=new Promise(resolve=>{release=resolve;}),calls=[];
  const api={call:async(name,body)=>{
    calls.push({name,body});if(name==='team-overview')return overview;
    assert.equal(name,'background-tasks');if(body.filter==='attention')await late;
    const row=makeDetail().task;return {tasks:[{...row,id:body.filter,title:'筛选结果 '+body.filter,...(body.filter==='closed'?{closure:{status:'closed'}}:{})}],total:1,hasMore:false};
  }};
  const view=render(panel(api,{selectedId:null}));await act(async()=>{});
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'需要你处理',exact:true})));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'已关闭',exact:true})));
  assert.ok(view.getByText('筛选结果 closed'));
  await act(async()=>{release();await late;});
  assert.equal(view.queryByText('筛选结果 attention'),null);assert.ok(view.getByText('筛选结果 closed'));
  assert.equal(calls.filter(call=>call.name==='background-tasks').at(-1).body.filter,'closed');
});

test('a late detail poll cannot resurrect mutation controls after close',async()=>{
  const detail=makeDetail();let release,reads=0;const late=new Promise(resolve=>{release=resolve;});
  const api=apiFor(()=>++reads===1?detail:late,async(name)=>{assert.equal(name,'background-task-close');return {...detail,task:{...detail.task,closure:{status:'closed'}}};});
  const view=render(panel(api));await waitFor(()=>view.getByRole('button',{name:'关闭任务'}));
  await waitFor(()=>assert.equal(reads,2),{timeout:2000});
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'关闭任务'})));
  await act(async()=>{release(detail);await late;});
  assert.ok(view.getByRole('button',{name:'恢复到任务列表'}));assert.equal(view.queryByRole('button',{name:'接续任务'}),null);
});
