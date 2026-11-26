import test from 'node:test';
import assert from 'node:assert/strict';
import {taskReason,appendTaskLog,taskDuration} from '../web/task-view.mjs';
import {errorText} from '../web/api.mjs';
test('log replay and old run responses cannot duplicate or replace the selected log',()=>{
 const current={runId:'new',offset:4,text:'初始',earlier:false};
 assert.equal(appendTaskLog(current,{runId:'old',offset:4,text:'old',nextOffset:7}),current);
 assert.equal(appendTaskLog(current,{runId:'new',offset:0,text:'replay',nextOffset:4}),current);
 const next=appendTaskLog(current,{runId:'new',offset:4,text:'继续',nextOffset:10});
 assert.equal(next.text,'初始继续');assert.equal(next.offset,10);
 const bounded=appendTaskLog(next,{runId:'new',offset:10,text:'more',nextOffset:14},4);
 assert.equal(bounded.text,'more');assert.equal(bounded.earlier,true);
});
test('task presentation distinguishes uncertain cleanup, timeout and a failed exit',()=>{
 assert.equal(taskReason({status:'running',cleanupConfirmed:false}),'');
 assert.match(taskReason({status:'interrupted',cleanupConfirmed:false}),/尚未确认/);
 assert.match(taskReason({status:'failed',error:'task_timeout',cleanupConfirmed:true}),/超过时限/);
 assert.match(taskReason({status:'failed',exitCode:7,cleanupConfirmed:true}),/退出码 7/);
 assert.equal(taskDuration({startedAt:1000,finishedAt:62000},90000),'1 分 1 秒');
 for(const workspaceMode of ['general','documents'])assert.match(taskReason({kind:'agent',status:'completed',workspaceMode,permission:'full'}),/结果文件/);
 assert.doesNotMatch(taskReason({kind:'agent',status:'completed',workspaceMode:'general',permission:'read-only'}),/文件差异|结果文件/);
});
test('project and input conflicts explain recovery without inviting retries of old inputs',()=>{
 const expected={
  project_state_changed:/项目或话题已变化.*核对项目后重新提交/,
  project_task_mismatch:/任务属于其他项目.*任务所属项目/,
  project_object_changed_read_again:/文件已变化.*重新读取最新内容/,
  task_inputs_changed:/输入资料在排队期间已变化.*核对最新内容后重新提交任务/,
 };
 for(const [code,pattern] of Object.entries(expected)){
  const text=errorText({code});assert.match(text,pattern);assert.equal(errorText(Error(code)),text);
  assert.equal(taskReason({status:'failed',error:code,cleanupConfirmed:true}),text);
  assert.doesNotMatch(text,/重试同一|操作未完成：|project_|task_inputs/);
 }
 assert.match(taskReason({status:'failed',error:'task_inputs_changed',cleanupConfirmed:false}),/旧作业是否停止尚未确认/);
 assert.match(errorText({code:'project_work_request_required'}),/选择或接续工作项目/);
 assert.match(errorText({code:'invalid_project_directory'}),/已有目录.*留空/);
});


test('model failure shows preserved work and sanitized diagnostic without claiming command failure',()=>{
 const reason=taskReason({status:'failed',failurePhase:'model_after_tools',diagnostic:{code:'network_error',status:503,requestId:'req_example'},cleanupConfirmed:true});
 assert.match(reason,/工具步骤已保存/);assert.match(reason,/network_error/);assert.match(reason,/HTTP 503/);assert.match(reason,/req_example/);assert.doesNotMatch(reason,/命令执行失败/);
});
