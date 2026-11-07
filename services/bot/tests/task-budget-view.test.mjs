import test,{after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {agentExecutionBudget,managementExecutionBudget,budgetMinutesInput} from '../web/task-budget.mjs';

const root=resolve(import.meta.dirname,'../../..'),require=createRequire(join(root,'engine/harness/packages/client/ui-primitives/package.json'));
const {JSDOM}=require('jsdom'),dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react'),{render,fireEvent,act,cleanup}=require('@testing-library/react');
const directory=mkdtempSync(join(tmpdir(),'nova-budget-view-'));
const bundle=await build({stdin:{contents:"export {AgentTaskForm,AgentTaskDetail} from './services/bot/web/agent-tasks.jsx';export {TaskCoordination} from './services/bot/web/team-results.jsx';",resolveDir:root},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',plugins:[{name:'shared-react',setup(builder){builder.onResolve({filter:/^react(?:\/.*)?$/},args=>({path:require.resolve(args.path),external:true}));}}]});
writeFileSync(join(directory,'views.cjs'),bundle.outputFiles[0].text);
const {AgentTaskForm,AgentTaskDetail,TaskCoordination}=require(join(directory,'views.cjs'));
afterEach(()=>cleanup());after(()=>{dom.window.close();rmSync(directory,{recursive:true,force:true});});
const change=(view,label,value)=>fireEvent.change(view.getByLabelText(label),{target:{value}});

test('new Agent form submits unlimited budgets without enabling automatic continuation',async()=>{
  const sent=[],view=render(React.createElement(AgentTaskForm,{action:async(name,body)=>{sent.push({name,body});return {task:{id:'task'}};},onSelect:()=>{}}));
  for(const label of ['最多模型步骤','Token 预算','最长运行时间（分钟）']){
    assert.equal(view.getByLabelText(label).value,'');assert.equal(view.getByLabelText(label).required,false);
  }
  assert.ok(view.getByText('执行预算 · 不限制'));
  change(view,'任务名称','整理资料');change(view,'任务目标','输出一份报告');
  await act(async()=>{fireEvent.submit(view.container.querySelector('form'));});
  assert.equal(sent[0].name,'background-task-start');
  for(const field of ['maxSteps','tokenBudget','timeoutMs','autoContinue'])assert.equal(sent[0].body[field],0);
  assert.equal(sent[0].body.maxReworks,2);
});

test('Agent form preserves chosen positive limits and blocks invalid ones',async()=>{
  const sent=[],view=render(React.createElement(AgentTaskForm,{action:async(_,body)=>{sent.push(body);return {task:{id:'task'}};},onSelect:()=>{}}));
  change(view,'任务名称','有限任务');change(view,'任务目标','验证预算');
  change(view,'最多模型步骤','129');assert.equal(view.container.querySelector('button[type="submit"]').disabled,true);
  await act(async()=>{fireEvent.submit(view.container.querySelector('form'));});assert.equal(sent.length,0);
  change(view,'最多模型步骤','32');change(view,'Token 预算','200000');change(view,'最长运行时间（分钟）','30');
  assert.equal(view.container.querySelector('button[type="submit"]').disabled,false);
  await act(async()=>{fireEvent.submit(view.container.querySelector('form'));});
  assert.deepEqual({maxSteps:sent[0].maxSteps,tokenBudget:sent[0].tokenBudget,timeoutMs:sent[0].timeoutMs},{maxSteps:32,tokenBudget:200000,timeoutMs:1800000});
});

test('existing management limits remain visible and clearing them saves explicit unlimited values',async()=>{
  const sent=[],management={enabled:true,maxReworks:2,tokenBudget:600000,timeBudgetMs:7200000,usedTokens:5000,usedDurationMs:60000};
  const detail={task:{id:'task',runId:'run',kind:'agent',status:'completed',assignedBotId:'employee',supervisorBotId:'chief',management},runs:[]};
  const view=render(React.createElement(TaskCoordination,{detail,action:async(name,body)=>{sent.push({name,body});return {};}}));
  assert.equal(view.getByLabelText('累计 Token 上限').value,'600000');assert.equal(view.getByLabelText('累计运行时间（分钟）').value,'120');
  assert.match(view.container.textContent,/5000 \/ 600000 Token/);
  change(view,'累计 Token 上限','999');assert.equal(view.getByText('保存跟进设置').disabled,true);
  change(view,'累计 Token 上限','');change(view,'累计运行时间（分钟）','');assert.equal(view.getByText('保存跟进设置').disabled,false);
  await act(async()=>{fireEvent.click(view.getByText('保存跟进设置'));});
  assert.equal(sent[0].name,'tasks/management');assert.equal(sent[0].body.tokenBudget,0);assert.equal(sent[0].body.timeBudgetMs,0);assert.equal(sent[0].body.maxReworks,2);
  const updated={...detail,task:{...detail.task,management:{...management,tokenBudget:0,timeBudgetMs:0}}};
  view.rerender(React.createElement(TaskCoordination,{detail:updated,action:async()=>{}}));
  assert.match(view.container.textContent,/5000（不限制） Token/);assert.doesNotMatch(view.container.textContent,/600000|120 分钟/);
});

test('Agent detail distinguishes unlimited, partial and legacy finite execution budgets',()=>{
  const detail={task:{id:'task',runId:'run',status:'completed',kind:'agent',permission:'full',policyVersion:2,workspaceMode:'general',maxSteps:0,tokenBudget:0,timeoutMs:0},runs:[]};
  const view=render(React.createElement(AgentTaskDetail,{detail,action:async()=>{}}));
  assert.match(view.container.textContent,/执行预算不限制/);assert.doesNotMatch(view.container.textContent,/0 个模型步骤|0 分钟/);
  const legacy={...detail,task:{...detail.task,maxSteps:32,tokenBudget:200000,timeoutMs:1800000}};
  view.rerender(React.createElement(AgentTaskDetail,{detail:legacy,action:async()=>{}}));
  assert.match(view.container.textContent,/每轮最多 32 个模型步骤.*Token 上限 200000.*最长 30 分钟/);
  view.rerender(React.createElement(AgentTaskDetail,{detail:{...detail,task:{...detail.task,tokenBudget:200000}},action:async()=>{}}));
  assert.match(view.container.textContent,/模型步骤不限制.*Token 上限 200000.*运行时间不限制/);
});

test('blank fields serialize as zero while malformed, negative and out-of-range budgets are rejected',()=>{
  assert.deepEqual(agentExecutionBudget({}),{maxSteps:0,tokenBudget:0,timeoutMs:0});
  assert.deepEqual(managementExecutionBudget({tokenBudget:'',budgetMinutes:' '}),{tokenBudget:0,timeBudgetMs:0});
  for(const value of ['-1','0','0.5','129','Infinity','no',true,NaN])assert.equal(agentExecutionBudget({maxSteps:value}),null);
  for(const value of ['-1','999','3000001','Infinity','no'])assert.equal(managementExecutionBudget({tokenBudget:value}),null);
  for(const value of ['-1','0','0.000001','481','Infinity','no'])assert.equal(managementExecutionBudget({budgetMinutes:value}),null);
  assert.deepEqual(managementExecutionBudget({tokenBudget:'1000',budgetMinutes:budgetMinutesInput(1000)}),{tokenBudget:1000,timeBudgetMs:1000});
});
