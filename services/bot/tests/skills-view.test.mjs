import test,{after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {skillSelection,runSkills,reportCandidates,candidateSourceCurrent} from '../web/skill-view.mjs';

const root=resolve(import.meta.dirname,'../../..'),require=createRequire(join(root,'engine/harness/packages/client/ui-primitives/package.json'));
const {JSDOM}=require('jsdom'),dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react'),{render,fireEvent,act,cleanup,waitFor}=require('@testing-library/react');
const directory=mkdtempSync(join(tmpdir(),'nova-skills-view-'));
const bundle=await build({stdin:{contents:"export * from './services/bot/web/skills.jsx';export {AgentTaskForm} from './services/bot/web/agent-tasks.jsx';",resolveDir:root},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',plugins:[{name:'shared-react',setup(builder){builder.onResolve({filter:/^react(?:\/.*)?$/},args=>({path:require.resolve(args.path),external:true}));}}]});
writeFileSync(join(directory,'views.cjs'),bundle.outputFiles[0].text);
const {EmployeeSkills,SkillLibrary,ResultSkills,SkillCandidate,TaskSkillUsage,TaskVideoProgress,AgentTaskForm,SkillCatalogProblems}=require(join(directory,'views.cjs'));
afterEach(()=>cleanup());after(()=>{dom.window.close();rmSync(directory,{recursive:true,force:true});});
const skill={name:'video-production',description:'按分镜生成并剪辑视频',version:'v1-original',revision:3,enabled:true,source:'bundled',assignedBotIds:['employee']};
const catalog={skills:[skill],candidates:[],bindings:[{botId:'employee',names:['video-production'],revision:4}],policy:{revision:2,autoCandidate:true,autoEnable:false}};
const member={id:'employee',name:'资料员'},change=(view,label,value)=>fireEvent.change(view.getByLabelText(label),{target:{value}});
const acceptedSource=source=>({task:{id:source.taskId,kind:'agent',runId:source.runId,status:'completed',assignmentVersion:1},teamReview:{current:{id:source.reportId,runId:source.runId,status:'completed',assignmentVersion:1,artifacts:[],evidence:{execution:{cleanupConfirmed:true,exitCode:0}}},currentReview:{id:source.reviewId,reportId:source.reportId,status:'accepted'}}});
async function open(view,selector='details'){
  await act(async()=>{const details=view.container.querySelector(selector);details.open=true;fireEvent(details,new dom.window.Event('toggle'));});
}

test('auto, explicit and none remain distinct and historical runs never borrow current skills',()=>{
  assert.deepEqual(skillSelection('auto',['video-production']),{});
  assert.deepEqual(skillSelection('none',['video-production']),{skillNames:[]});
  assert.deepEqual(skillSelection('explicit',['video-production','video-production']),{skillNames:['video-production']});
  const detail={task:{id:'task',runId:'new'},skills:[skill]};
  assert.deepEqual(runSkills(detail,{id:'old'}),[]);assert.deepEqual(runSkills(detail,{id:'new',skills:[]}),[]);
  const view=render(React.createElement(TaskSkillUsage,{detail,currentRun:{id:'old',skills:[{...skill,version:'old-version'}]}}));
  assert.match(view.container.textContent,/old-versio/);assert.doesNotMatch(view.container.textContent,/v1-origina/);
});

test('employee skill assignment is one versioned action and empty selection explicitly removes skills',async()=>{
  const sent=[],api={call:async(name,body)=>{sent.push({name,body});return catalog;}};
  const view=render(React.createElement(EmployeeSkills,{api,member}));assert.equal(sent.length,0);
  await open(view);await waitFor(()=>assert.ok(view.getByLabelText(/video-production/).checked));
  fireEvent.click(view.getByLabelText(/video-production/));
  await act(async()=>fireEvent.click(view.getByText('保存技能配置')));
  const action=sent.find(call=>call.name==='skill-action');assert.equal(action.body.action,'assign');assert.equal(action.body.botId,'employee');assert.equal(action.body.revision,4);assert.deepEqual(action.body.names,[]);assert.ok(action.body.actionId);
});

test('task form serializes explicit skills without leaking UI mode and blocks an empty explicit selection',async()=>{
  const sent=[],api={call:async()=>catalog};
  const view=render(React.createElement(AgentTaskForm,{api,team:{chiefBotId:'chief',enabled:true,members:[]},action:async(name,body)=>{sent.push(body);return {task:{id:'new'}};},onSelect:()=>{}}));
  change(view,'任务名称','视频演示');change(view,'任务目标','按分镜制作视频');
  await open(view,'.task-skills-select');change(view,'技能选择','explicit');
  assert.equal(view.getByText('提交 Agent 任务').disabled,true);
  await act(async()=>fireEvent.submit(view.container.querySelector('form')));assert.equal(sent.length,0);
  await waitFor(()=>assert.ok(view.getByLabelText(/video-production/)));fireEvent.click(view.getByLabelText(/video-production/));
  await act(async()=>fireEvent.submit(view.container.querySelector('form')));
  assert.deepEqual(sent[0].skillNames,['video-production']);assert.equal(Object.hasOwn(sent[0],'skillMode'),false);
});

test('skill library changes bind head revision and ambiguous network retries keep the exact action id',async()=>{
  const sent=[];let writes=0;
  const api={call:async(name,body)=>{sent.push({name,body});if(name==='skill-action'&&++writes===1)throw Object.assign(Error('network'),{code:'network'});return name==='skill-action'?{...catalog,skills:[{...skill,enabled:false,revision:4}]}:catalog;}};
  const view=render(React.createElement(SkillLibrary,{api}));await open(view);
  await waitFor(()=>assert.ok(view.getByText('停用')));await act(async()=>fireEvent.click(view.getByText('停用')));
  assert.ok(view.getByText('重试上次操作'));await act(async()=>fireEvent.click(view.getByText('重试上次操作')));
  const requests=sent.filter(call=>call.name==='skill-action');assert.equal(requests.length,2);assert.deepEqual(requests[0].body,requests[1].body);assert.equal(requests[0].body.revision,3);assert.equal(requests[0].body.action,'disable');assert.ok(view.getByText('启用'));
});

test('rollback uses selected immutable version with current head revision',async()=>{
  const sent=[],api={call:async(name,body)=>{sent.push({name,body});return name==='skill-history'?{name:skill.name,revision:3,versions:[{version:skill.version,content:'current',createdAt:2},{version:'older-version',content:'old',createdAt:1}]}:catalog;}};
  const view=render(React.createElement(SkillLibrary,{api}));await open(view);await waitFor(()=>assert.ok(view.getByText('版本记录')));
  await act(async()=>fireEvent.click(view.getByText('版本记录')));await act(async()=>fireEvent.click(view.getByText('使用此版本')));
  const action=sent.find(call=>call.name==='skill-action');assert.equal(action.body.action,'rollback');assert.equal(action.body.revision,3);assert.equal(action.body.version,'older-version');
});

test('result candidates bind the exact accepted report and saving does not accept another report or run a task',async()=>{
  const candidate={id:'candidate-current',name:'summarize-data',description:'整理表格',content:'读取输入，计算总数并核对输出。',status:'ready',source:{taskId:'task',runId:'run',reportId:'report',reviewId:'review'}};
  const detail={task:{id:'task',runId:'run'},skillCandidates:[candidate,{...candidate,id:'candidate-other',source:{...candidate.source,reportId:'other'}}]},report={id:'report',runId:'run'},sent=[];
  assert.equal(reportCandidates(detail,report).length,1);
  const api={call:async(name,body)=>{if(name==='background-task')return acceptedSource(candidate.source);if(name==='skill-action')sent.push({name,body});return {...catalog,candidates:[{...candidate,status:'promoted'}]};}};
  const view=render(React.createElement(ResultSkills,{api,detail,report,review:{status:'accepted'},latest:true}));
  await act(async()=>fireEvent.click(view.getByText('保存为技能')));change(view,'技能名称','summarize-data');
  await act(async()=>fireEvent.submit(view.container.querySelector('form')));
  assert.equal(sent[0].name,'skill-action');assert.equal(sent[0].body.action,'promote');assert.equal(sent[0].body.candidateId,'candidate-current');assert.ok(view.getByText('已保存为技能'));
  view.rerender(React.createElement(ResultSkills,{api,detail,report,review:{status:'accepted'},latest:false}));assert.equal(view.container.textContent,'');
  view.rerender(React.createElement(ResultSkills,{api,detail,report,review:{status:'needs_user'},latest:true}));assert.equal(view.container.textContent,'');
});

test('only refined candidates can be saved and explicit extraction binds the accepted source without rerunning work',async()=>{
  const sent=[],source={taskId:'task',runId:'run',reportId:'report',reviewId:'review'},candidate={id:'candidate',name:'learned-task',status:'candidate',source};
  const api={call:async(name,body)=>{sent.push({name,body});return {candidate};}},detail={task:{id:'task',runId:'run'},skillCandidates:[]},report={id:'report',runId:'run'},review={id:'review',status:'accepted'};
  const view=render(React.createElement(ResultSkills,{api,detail,report,review,latest:true}));
  await act(async()=>fireEvent.click(view.getByText('整理为技能')));
  assert.equal(sent.length,1);assert.equal(sent[0].name,'skill-candidate');assert.deepEqual({...sent[0].body,actionId:undefined},{...source,actionId:undefined});assert.ok(sent[0].body.actionId);
  assert.match(view.container.textContent,/正在整理工作方法/);assert.equal(view.queryByText('保存为技能'),null);
  view.rerender(React.createElement(ResultSkills,{api,detail:{...detail,skillCandidates:[{...candidate,status:'failed',error:'skill_extraction_failed'}]},report,review,latest:true}));
  await act(async()=>fireEvent.click(view.getByText('重新整理')));
  assert.equal(sent[1].name,'skill-candidate');assert.notEqual(sent[0].body.actionId,sent[1].body.actionId);assert.equal(sent[1].body.reportId,'report');
});

test('automatic skill activation stays off until explicitly saved with the policy revision',async()=>{
  const sent=[],api={call:async(name,body)=>{sent.push({name,body});return catalog;}};
  const view=render(React.createElement(SkillLibrary,{api}));await open(view);
  await waitFor(()=>assert.ok(view.getByLabelText('允许自动启用符合条件的新技能')));
  assert.equal(view.getByLabelText('允许自动启用符合条件的新技能').checked,false);
  fireEvent.click(view.getByLabelText('允许自动启用符合条件的新技能'));
  await act(async()=>fireEvent.submit(view.container.querySelector('.skill-policy form')));
  const action=sent.find(call=>call.name==='skill-action');assert.equal(action.body.action,'policy');assert.equal(action.body.revision,2);assert.equal(action.body.autoEnable,true);assert.equal(action.body.autoCandidate,true);
});

test('video status distinguishes stopping local following from remote cancellation and isolates historical runs',()=>{
  const detail={task:{id:'task',runId:'new'},video:{records:[{id:'remote',runId:'old',remoteTaskId:'provider-123',remoteStatus:'running',localStatus:'stopped'}]}};
  const view=render(React.createElement(TaskVideoProgress,{detail,currentRun:{id:'new'}}));
  assert.match(view.container.textContent,/生成中.*provider-123.*已停止本地跟进/s);assert.doesNotMatch(view.container.textContent,/已取消/);
  view.rerender(React.createElement(TaskVideoProgress,{detail,currentRun:{id:'another-old'}}));assert.equal(view.container.textContent,'');
});

test('catalog synchronization distinguishes saved pending work, blocked bindings and unreadable bundles',()=>{
  const view=render(React.createElement(SkillCatalogProblems,{catalog:{sync:{pending:1,blocked:1},problems:[{name:'技能同步',status:'pending',error:'offline'},{name:'技能同步',status:'pending',error:'skill_sync_pending'},{name:'video-production',error:'resource_missing'}]}}));
  assert.equal(view.getAllByText(/设置已保存，正在同步到员工/).length,1);
  assert.match(view.container.textContent,/后台会自动重试/);assert.match(view.container.textContent,/重新选择员工技能并保存/);assert.match(view.container.textContent,/video-production：暂时无法载入/);
  assert.doesNotMatch(view.container.textContent,/保存失败|重跑|offline|resource_missing/);
  view.rerender(React.createElement(SkillCatalogProblems,{catalog:{sync:{pending:0,blocked:0},problems:[]}}));assert.equal(view.container.textContent,'');
});

test('renamed and edited candidates keep their source id and use the destination head revision',async()=>{
  const candidate={id:'candidate-current',name:'original-method',description:'原说明',content:'原工作方法',status:'ready',source:{taskId:'task',runId:'run',reportId:'report',reviewId:'review'}},sent=[];
  const api={call:async(name,body)=>{if(name==='background-task')return acceptedSource(candidate.source);if(name==='skill-action')sent.push(body);return catalog;}};
  const view=render(React.createElement(SkillCandidate,{api,candidate}));
  await act(async()=>fireEvent.click(view.getByText('保存为技能')));
  await waitFor(()=>assert.equal(view.getByText('保存技能').disabled,false));
  change(view,'技能名称','video-production');change(view,'适用场景','用户修改的场景');change(view,'工作方法','读取新的输入，执行新的检查。');
  assert.ok(view.getByText(/同名技能已存在/));await act(async()=>fireEvent.submit(view.container.querySelector('form')));
  assert.equal(sent[0].candidateId,candidate.id);assert.equal(sent[0].name,'video-production');assert.equal(sent[0].content,'读取新的输入，执行新的检查。');assert.equal(sent[0].revision,3);
  assert.equal(Object.hasOwn(sent[0],'source'),false);assert.equal(Object.hasOwn(sent[0],'botId'),false);
});

test('closed, changed and newly reviewed sources cannot open an old candidate editor',async()=>{
  const candidate={id:'candidate',name:'old-method',status:'ready',source:{taskId:'task',runId:'run',reportId:'report',reviewId:'review'}},valid=acceptedSource(candidate.source),sent=[];
  assert.equal(candidateSourceCurrent(valid,candidate),true);
  const variants=[{...valid,task:{...valid.task,closure:{status:'closed'}}},{...valid,teamReview:{...valid.teamReview,current:{...valid.teamReview.current,artifacts:[{status:'available',sourceStatus:'changed'}]}}},{...valid,teamReview:{...valid.teamReview,currentReview:{...valid.teamReview.currentReview,id:'new-review'}}}];
  for(const detail of variants){
    const view=render(React.createElement(SkillCandidate,{api:{call:async(name)=>{sent.push(name);return detail;}},candidate}));
    await act(async()=>fireEvent.click(view.getByText('保存为技能')));assert.equal(view.queryByText('保存技能'),null);assert.ok(view.getByRole('alert'));cleanup();
  }
  assert.deepEqual(sent,['background-task','background-task','background-task']);
  assert.deepEqual(reportCandidates({task:valid.task,skillCandidates:[candidate]},valid.teamReview.current,{id:'new-review'}),[]);
});

test('editing a disabled skill preserves disabled state and rollback uses the new head revision',async()=>{
  const sent=[];let current={...skill,enabled:false},versions=[{...skill,enabled:true,content:'original method'}];
  const api={call:async(name,body)=>{if(name==='skill-history')return {revision:current.revision,versions};if(name==='skill-action'){sent.push(body);if(body.action==='save'){current={...current,version:'updated-version',revision:4,description:body.description,enabled:body.enabled};versions=[{...current,content:body.content},...versions];}}return {...catalog,skills:[current]};}};
  const view=render(React.createElement(SkillLibrary,{api}));await open(view);await waitFor(()=>assert.ok(view.getByText('更新内容')));
  await act(async()=>fireEvent.click(view.getByText('更新内容')));assert.equal(view.getByLabelText('保存后启用').checked,false);
  change(view,'工作方法','updated method');await act(async()=>fireEvent.submit(view.container.querySelector('.skill-edit')));
  assert.equal(sent[0].enabled,false);assert.equal(sent[0].revision,3);await act(async()=>fireEvent.click(view.getByText('版本记录')));await act(async()=>fireEvent.click(view.getByText('使用此版本')));
  assert.equal(sent[1].revision,4);assert.equal(sent[1].version,skill.version);assert.equal(sent[1].action,'rollback');
});

test('a lost policy response retries the original request after catalog revision advances',async()=>{
  const sent=[];let current=catalog;
  const api={call:async(name,body)=>{if(name==='skill-action'){sent.push(body);if(sent.length===1){current={...catalog,policy:{...catalog.policy,revision:3,autoEnable:true}};throw Object.assign(Error('network'),{code:'network'});}}return current;}};
  const view=render(React.createElement(SkillLibrary,{api}));await open(view);await waitFor(()=>assert.ok(view.getByLabelText('允许自动启用符合条件的新技能')));
  fireEvent.click(view.getByLabelText('允许自动启用符合条件的新技能'));await act(async()=>fireEvent.submit(view.container.querySelector('.skill-policy form')));
  await act(async()=>fireEvent.click(view.getByText('刷新技能')));await waitFor(()=>assert.equal(view.getByLabelText('允许自动启用符合条件的新技能').checked,true));
  await act(async()=>fireEvent.click(view.getByText('重试保存设置')));assert.equal(sent.length,2);assert.deepEqual(sent[1],sent[0]);assert.equal(sent[1].revision,2);
});
