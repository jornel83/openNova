import test,{after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {needsVoiceStop,voicePresentation} from '../web/voice-state.mjs';

const root=resolve(import.meta.dirname,'../../..'),require=createRequire(join(root,'engine/harness/packages/client/ui-primitives/package.json'));
const {JSDOM}=require('jsdom'),dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react'),{render,fireEvent,cleanup,within}=require('@testing-library/react');
const directory=mkdtempSync(join(tmpdir(),'nova-task-notification-view-'));
const bundle=await build({stdin:{contents:"export {ConversationMessage,TaskNotices} from './services/bot/web/conversation-message.jsx';",resolveDir:root},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',
  alias:{'@opennova/ds-bot':join(root,'engine/bot/ds-bot/src/client'),'@deepseek-ai/dsh-client-ui-primitives':require.resolve('@deepseek-ai/dsh-client-ui-primitives')},
  loader:{'.css':'empty','.module.css':'empty','.wasm':'binary'},
  plugins:[{name:'shared-react',setup(builder){builder.onResolve({filter:/^react(?:-dom)?(?:\/.*)?$/},args=>({path:require.resolve(args.path),external:true}));}}]});
writeFileSync(join(directory,'views.cjs'),bundle.outputFiles[0].text);
const {ConversationMessage,TaskNotices}=require(join(directory,'views.cjs'));
afterEach(()=>cleanup());after(()=>{dom.window.close();rmSync(directory,{recursive:true,force:true});});
const bot={id:'chief',name:'OpenNova',color:'blue',avatar:{shape:'drop'}},props={roster:{bots:[bot],byId:{chief:bot},roomsById:{}},botId:bot.id,sessionId:'conversation',replyStream:{draft:null},actions:{openSession:()=>{},quote:()=>{}},onOpenTask:()=>{}};
const request={id:'request',source:'voice',input:'请资料员汇总三行数据。',status:'completed',text:'已安排资料员处理。',createdAt:1000};
const notice={id:'notification',kind:'task_notification',role:'assistant',source:'task',status:'completed',text:'资料员的汇总任务已验收通过。',createdAt:2000,taskId:'task',runId:'run',reportId:'report',taskTitle:'汇总任务',notificationStatus:'accepted',originRequestId:'request'};
function timeline(messages,extra={}){return React.createElement('div',null,messages.map(message=>React.createElement(ConversationMessage,{...props,...extra,message,key:message.id})));}

test('accepted reports render as Nova-only messages and open the original task without a user input',()=>{
  const opened=[],view=render(timeline([notice],{onOpenTask:id=>opened.push(id)}));
  const report=view.getByRole('region',{name:'任务汇报'});
  assert.equal(report.querySelector('.bt-umsg'),null);assert.equal(report.querySelector('[data-request-id]'),null);
  assert.equal(report.querySelector('.speaker-label').textContent.trim(),'NOVA');
  assert.match(report.querySelector('.bt-bubble').textContent,/资料员的汇总任务已验收通过/);
  assert.equal(view.queryByRole('textbox'),null);
  fireEvent.click(view.getByRole('button',{name:'查看任务：汇总任务'}));assert.deepEqual(opened,['task']);
});

test('mixed history preserves the real user bubble and assistant reply across refresh and pagination',()=>{
  const view=render(timeline([request,notice]));
  const originalUser=view.container.querySelector('.bt-ubody'),originalNotification=view.getByRole('region',{name:'任务汇报'});
  assert.equal(originalUser.textContent,request.input);
  assert.equal(view.container.querySelectorAll('.bt-umsg').length,1);
  assert.equal(view.container.querySelectorAll('.bt-bubble').length,2);
  assert.equal(view.container.querySelector('[data-request-id="request"] .bt-bubble').textContent,request.text);
  view.rerender(timeline(structuredClone([request,notice])));
  assert.equal(view.getAllByRole('region',{name:'任务汇报'}).length,1);
  assert.equal(view.getByRole('region',{name:'任务汇报'}),originalNotification);
  assert.equal(view.container.querySelector('.bt-ubody'),originalUser);
  view.rerender(timeline([{...request,id:'earlier',input:'之前的交流',createdAt:500},request,notice]));
  assert.equal(view.container.querySelectorAll('.bt-umsg').length,2);
  assert.equal(view.getAllByRole('region',{name:'任务汇报'}).length,1);
  assert.equal(view.getByRole('region',{name:'任务汇报'}),originalNotification);
});

test('needs-user reports remain in the chat and become explicit history after their state changes',()=>{
  const message={...notice,notificationStatus:'needs_user',text:'需要你确认活动名称后继续。'};
  const view=render(timeline([message]));
  assert.match(view.getByRole('region',{name:'任务汇报'}).textContent,/需要你确认活动名称后继续/);
  assert.equal(view.queryByText('回复员工'),null);
  view.rerender(timeline([{...message,notificationObsolete:true}]));
  const history=view.getByRole('region',{name:'历史任务汇报'});
  assert.match(history.textContent,/历史汇报 · 任务状态已更新，请以任务详情为准/);
  assert.match(history.querySelector('.bt-bubble').textContent,/需要你确认活动名称后继续/);
  assert.equal(within(history).getByRole('button',{name:'查看任务：汇总任务'}).disabled,false);
});

test('an independent notification neither takes over nor clears the active streamed reply',()=>{
  const active={...request,id:'active',status:'running',text:null,input:'继续介绍进度'},draft={draft:{requestId:'active',attemptId:'attempt',status:'streaming',revision:1,text:'正在整理你需要的说明。'}};
  const view=render(timeline([active,notice],{replyStream:draft}));
  assert.equal(view.getByLabelText('生成中的回答').getAttribute('aria-busy'),'true');
  assert.match(view.getByLabelText('生成中的回答').textContent,/正在整理你需要的说明/);
  assert.equal(view.getAllByRole('region',{name:'任务汇报'}).length,1);
  view.rerender(timeline([{...active,status:'completed',text:'说明已完成。'},notice],{replyStream:draft}));
  assert.equal(view.queryByLabelText('生成中的回答'),null);
  assert.equal(view.container.querySelector('[data-request-id="active"] .bt-bubble').textContent,'说明已完成。');
  assert.equal(view.getAllByRole('region',{name:'任务汇报'}).length,1);
});

test('old result notices are suppressed only for the same current run already visible in chat',()=>{
  const tasks=[{id:'task',runId:'run',reportId:'report',title:'汇总任务',unread:true,status:'completed'},
    {id:'legacy',runId:'legacy-run',title:'另一项旧任务',unread:true,status:'failed'},
    {id:'seen',runId:'seen-run',title:'已读任务',unread:false,status:'completed'}];
  const opened=[],view=render(React.createElement(TaskNotices,{tasks,messages:[notice],onOpenTask:id=>opened.push(id)}));
  assert.equal(view.queryByRole('button',{name:/汇总任务/}),null);assert.equal(view.queryByRole('button',{name:/已读任务/}),null);
  fireEvent.click(view.getByRole('button',{name:/另一项旧任务/}));assert.deepEqual(opened,['legacy']);
  for(const messages of [[],[{...notice,notificationObsolete:true}],[{...notice,runId:'earlier-run'}],[{...notice,reportId:'earlier-report'}]]){
    view.rerender(React.createElement(TaskNotices,{tasks,messages,onOpenTask:()=>{}}));
    assert.ok(view.getByRole('button',{name:/汇总任务/}));
  }
  view.rerender(React.createElement(TaskNotices,{tasks:[tasks[0]],messages:[notice],onOpenTask:()=>{}}));
  assert.equal(view.queryByText('后台任务有新结果'),null);
});

test('the stop control can stop proactive playback with no conversational request ID',()=>{
  for(const playback of ['buffering','playing','paused']){
    const voice={connected:true,playback,requestId:null},snapshot={desktop:{voice},activeId:null};
    assert.equal(voicePresentation(snapshot,true).canStop,true);assert.equal(needsVoiceStop(voice,snapshot.activeId),true);
  }
  assert.equal(needsVoiceStop({connected:true,playback:'playing',requestId:'active'},'active'),false);
  assert.equal(needsVoiceStop({connected:true,playback:'playing',requestId:'previous'},'active'),true);
  assert.equal(needsVoiceStop({connected:false,playback:'playing'},null),false);
  assert.equal(needsVoiceStop({connected:true,playback:'idle'},null),false);
});
