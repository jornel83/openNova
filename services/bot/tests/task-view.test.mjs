import test from 'node:test';
import assert from 'node:assert/strict';
import {taskReason,appendTaskLog,taskDuration} from '../web/task-view.mjs';
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
