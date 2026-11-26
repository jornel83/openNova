import test,{after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';

const root=resolve(import.meta.dirname,'../../..'),require=createRequire(join(root,'engine/harness/packages/client/ui-primitives/package.json'));
const {JSDOM}=require('jsdom'),dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react'),{render,fireEvent,act,cleanup,within}=require('@testing-library/react');
const directory=mkdtempSync(join(tmpdir(),'nova-chief-review-view-'));
const bundle=await build({stdin:{contents:"export {AgentTaskForm,AgentTaskDetail} from './services/bot/web/agent-tasks.jsx';export {TeamResults,TaskCoordination} from './services/bot/web/team-results.jsx';export {TaskPanel} from './services/bot/web/tasks.jsx';",resolveDir:root},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',plugins:[{name:'shared-react',setup(builder){builder.onResolve({filter:/^react(?:\/.*)?$/},args=>({path:require.resolve(args.path),external:true}));}}]});
writeFileSync(join(directory,'views.cjs'),bundle.outputFiles[0].text);
const {AgentTaskForm,AgentTaskDetail,TeamResults,TaskCoordination,TaskPanel}=require(join(directory,'views.cjs'));
afterEach(()=>cleanup());after(()=>{dom.window.close();rmSync(directory,{recursive:true,force:true});});
const team={enabled:true,chiefBotId:'chief',members:[{id:'chief',name:'总管',chief:true,enabled:true,tasks:[]},{id:'employee',name:'验收员',role:'资料',enabled:true,tasks:[]}]};
const change=(view,label,value)=>fireEvent.change(view.getByLabelText(label),{target:{value}});

for(const assignee of ['','employee'])test(`${assignee||'chief'} new task enables independent review by default`,async()=>{
  const sent=[],view=render(React.createElement(AgentTaskForm,{team,action:async(name,body)=>{sent.push({name,body});return {task:{id:'task'}};},onSelect:()=>{}}));
  if(assignee)change(view,'负责人',assignee);
  assert.equal(view.getByLabelText('自动检查成果并跟进').checked,true);
  assert.match(view.container.textContent,/独立检查成果与实际执行证据/);
  change(view,'任务名称','自动验收');change(view,'任务目标','生成文件并检查');
  await act(async()=>fireEvent.submit(view.container.querySelector('form')));
  assert.equal(sent.length,1);assert.equal(sent[0].name,'background-task-start');
  assert.equal(sent[0].body.assignedBotId,assignee||undefined);assert.equal(sent[0].body.managementEnabled,true);
  assert.equal(sent[0].body.autoContinue,0);
});

test('explicit opt-out stays disabled when switching between employee and chief',async()=>{
  const sent=[],view=render(React.createElement(AgentTaskForm,{team,action:async(name,body)=>{sent.push({name,body});return {task:{id:'task'}};},onSelect:()=>{}}));
  fireEvent.click(view.getByLabelText('自动检查成果并跟进'));
  change(view,'负责人','employee');assert.equal(view.getByLabelText('自动检查成果并跟进').checked,false);
  change(view,'负责人','');assert.equal(view.getByLabelText('自动检查成果并跟进').checked,false);
  assert.match(view.container.textContent,/自动检查已关闭，完成后由你查看并验收成果/);
  assert.equal(view.queryByLabelText('最多自动返工次数'),null);
  change(view,'任务名称','人工验收');change(view,'任务目标','按显式要求关闭自动验收');
  await act(async()=>fireEvent.submit(view.container.querySelector('form')));
  assert.equal(sent[0].body.managementEnabled,false);assert.equal(sent[0].body.assignedBotId,undefined);
});

for(const enabled of [true,false])test(`command task review submits ${enabled} and resets the next command to default on`,async()=>{
  const sent=[],selected=[],api={call:async(name,body)=>{
    if(name==='background-tasks')return {tasks:[],total:0,hasMore:false};
    if(name==='team-overview')return {counts:{total:0},members:[],active:[],attention:[],recent:[]};
    if(name==='skills')return {skills:[],bindings:[],candidates:[],policy:{autoCandidate:true,autoEnable:false}};
    assert.equal(name,'background-task-start');sent.push(body);return {task:{id:'command-task'}};
  }};
  const view=render(React.createElement(TaskPanel,{api,summary:{tasks:[]},team,selectedId:null,onSelect:id=>selected.push(id),online:true}));
  await act(async()=>{});
  const element=view.getByText('直接运行命令').closest('details'),form=within(element);
  assert.equal(form.getByLabelText('自动检查成果并跟进').checked,true);
  assert.equal(form.queryByLabelText('最多自动返工次数'),null);
  assert.match(element.textContent,/不会自动重放命令/);
  if(!enabled)fireEvent.click(form.getByLabelText('自动检查成果并跟进'));
  change(form,'负责人','employee');change(form,'负责人','');
  assert.equal(form.getByLabelText('自动检查成果并跟进').checked,enabled);
  change(form,'任务名称','检查命令');change(form,'命令','printf done');
  await act(async()=>fireEvent.submit(element.querySelector('form')));
  assert.equal(sent.length,1);assert.equal(sent[0].managementEnabled,enabled);assert.equal(sent[0].command,'printf done');
  assert.equal(sent[0].assignedBotId,undefined);assert.deepEqual(selected,['command-task']);
  assert.equal(form.getByLabelText('自动检查成果并跟进').checked,true);assert.equal(form.getByLabelText('任务名称').value,'');
});

function chiefDetail(enabled=false){
  const management={enabled,paused:false,maxReworks:2,usedReworks:0,tokenBudget:0,timeBudgetMs:0};
  const task={id:'chief-task',runId:'original-run',kind:'agent',status:'completed',assignmentVersion:1,assignedBotId:'chief',supervisorBotId:'chief',management};
  const report={id:'report',runId:task.runId,assignmentVersion:1,version:1,status:'completed',summary:'金额汇总完成',artifacts:[],evidence:{execution:{status:'completed',exitCode:0,cleanupConfirmed:true}}};
  return {task,runs:[],teamReview:{current:report,history:[],reviews:[],management}};
}

test('an existing chief result exposes opt-in without resubmitting its business task',async()=>{
  const sent=[],detail=chiefDetail(false),view=render(React.createElement(TaskCoordination,{detail,team,action:async(name,body)=>{sent.push({name,body});return {};}}));
  const checkbox=view.getByLabelText('启用成果检查与跟进');assert.equal(checkbox.checked,false);
  await act(async()=>fireEvent.click(checkbox));
  assert.equal(sent.length,1);assert.equal(sent[0].name,'tasks/management');
  assert.deepEqual({...sent[0].body,actionId:undefined},{id:'chief-task',runId:'original-run',enabled:true,actionId:undefined});
  assert.ok(sent[0].body.actionId);
  const updated=chiefDetail(true);view.rerender(React.createElement(TaskCoordination,{detail:updated,team,action:async()=>{}}));
  assert.equal(view.getByLabelText('启用成果检查与跟进').checked,true);
});

test('internal management, skill extraction and check tasks cannot enable recursive review from the UI',()=>{
  for(const extra of [{managementReview:{targetTaskId:'parent'}},{managementReview:{kind:'skill-extraction',targetTaskId:'parent'}},{parentTaskId:'parent'}]){
    const detail=chiefDetail(true);detail.task={...detail.task,...extra};
    const view=render(React.createElement(TaskCoordination,{detail,action:async()=>assert.fail('internal task cannot configure review')}));
    assert.equal(view.queryByLabelText('启用成果检查与跟进'),null);assert.equal(view.queryByText('保存跟进设置'),null);view.unmount();
  }
});

test('closed chief history keeps review evidence but exposes no management mutations',()=>{
  const detail=chiefDetail(true);detail.task.closure={status:'closed'};
  const view=render(React.createElement(TaskCoordination,{detail,action:async()=>assert.fail('closed task cannot configure review')}));
  assert.equal(view.queryByLabelText('启用成果检查与跟进'),null);assert.equal(view.queryByText('保存跟进设置'),null);
});

test('chief results distinguish waiting for automatic review, paused review and explicit manual acceptance',()=>{
  const auto=chiefDetail(true),view=render(React.createElement(TeamResults,{detail:auto,action:async()=>{}}));
  assert.match(view.container.textContent,/验收：待自动检查/);assert.match(view.container.textContent,/总管交付。由独立检查核对成果/);
  assert.doesNotMatch(view.container.textContent,/总管亲自执行，由你查看成果/);
  const paused=chiefDetail(true);paused.teamReview.management.paused=true;
  view.rerender(React.createElement(TeamResults,{detail:paused,action:async()=>{}}));
  assert.match(view.container.textContent,/验收：跟进已暂停/);
  const manual=chiefDetail(false);view.rerender(React.createElement(TeamResults,{detail:manual,action:async()=>{}}));
  assert.match(view.container.textContent,/验收：待你验收/);assert.match(view.container.textContent,/自动检查已关闭，可启用跟进或手动验收/);
  assert.equal(view.getByRole('button',{name:'验收通过'}).disabled,false);
});

test('the original task card opens its captured receipt and distinguishes technical approval from activation',async()=>{
  const detail=chiefDetail(true),report=detail.teamReview.current,sent=[];
  report.artifacts=[{id:'receipt',name:'candidate/receipt.json',status:'available'}];
  report.evidence.candidateReview={status:'passed',requiredChecks:['chat'],checks:[{check:'chat',status:'passed',artifactId:'receipt'}],coveredStepIds:['old']};
  report.evidence.commands=[{stepId:'old',status:'failed',exitCode:1,command:'historical test'}];
  detail.teamReview.currentReview={reportId:report.id,status:'accepted'};
  const view=render(React.createElement(TeamResults,{detail,action:async(name,body)=>{sent.push({name,body});}}));
  assert.match(view.getByRole('region',{name:'候选版技术验收'}).textContent,/技术验收通过.*仍需你确认.*网页文字对话回显 · 通过/);
  assert.match(view.container.textContent,/同项最终检查已通过.*退出码 1/);
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'打开成果'})));
  assert.equal(sent[0].name,'tasks/report-artifact');
  assert.deepEqual([sent[0].body.id,sent[0].body.reportId,sent[0].body.artifactId],[detail.task.id,report.id,'receipt']);
  report.evidence.candidateReview.patchCurrent=false;detail.teamReview.currentReview.status='stale';
  view.rerender(React.createElement(TeamResults,{detail,action:async()=>{}}));
  assert.match(view.getByRole('region',{name:'候选版技术验收'}).textContent,/需重新验收/);
});


test('failed work exposes explicit tool-free summary recovery bound to the failed report',async()=>{
  const detail=chiefDetail(false),sent=[];detail.task={...detail.task,status:'failed',workspaceMode:'general',permission:'full',policyVersion:2,canContinue:true,canRecoverSummary:true};
  detail.teamReview.current.status='failed';const currentRun={id:detail.task.runId,jobs:[]};detail.runs=[currentRun];
  const view=render(React.createElement(AgentTaskDetail,{detail,currentRun,action:async(name,body)=>{sent.push({name,body});return {};}}));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'仅补汇总'})));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'仅补汇总'})));
  assert.equal(sent[0].name,'background-task-continue');assert.equal(sent[0].body.summaryOnly,true);assert.equal(sent[0].body.reportId,'report');assert.equal(sent[0].body.runId,'original-run');assert.equal(sent[1].body.actionId,sent[0].body.actionId);assert.equal(sent[0].body.text,undefined);
  view.rerender(React.createElement(AgentTaskDetail,{detail,currentRun:{id:'historical-run',jobs:[]},action:async()=>{}}));assert.equal(view.queryByRole('button',{name:'仅补汇总'}),null);
});

test('retry review targets the current immutable report and does not dispatch business continuation',async()=>{
  const detail=chiefDetail(true),sent=[];
  detail.teamReview.currentReview={id:'review',reportId:'report',status:'needs_user',canRetry:true,diagnostic:{code:'network_error',stage:'conversation'}};
  const view=render(React.createElement(TeamResults,{detail,action:async(name,body)=>{sent.push({name,body});return {};}}));
  assert.match(view.container.textContent,/自动验收未完成/);
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'仅重试验收'})));
  assert.equal(sent[0].name,'tasks/management');assert.equal(sent[0].body.retryReview,true);assert.equal(sent[0].body.reportId,'report');assert.equal(sent[0].body.reviewId,'review');assert.equal(sent[0].body.runId,'original-run');
  detail.task.closure={status:'closed'};view.rerender(React.createElement(TeamResults,{detail,action:async()=>{}}));assert.equal(view.queryByRole('button',{name:'仅重试验收'}),null);
});

test('successful commands followed by a failed model turn are not labeled failed commands',()=>{
 const detail=chiefDetail(true);detail.task.status='failed';const report=detail.teamReview.current;report.status='failed';report.evidence={execution:{status:'failed',exitCode:1,cleanupConfirmed:true},commands:[{status:'completed',exitCode:0,command:'node check.mjs'}],checks:[]};
 const view=render(React.createElement(TeamResults,{detail,action:async()=>{}}));
 assert.match(view.container.textContent,/工作会话未成功结束/);assert.match(view.container.textContent,/已记录的命令均成功/);assert.doesNotMatch(view.container.textContent,/命令或检查没有全部成功/);
});
