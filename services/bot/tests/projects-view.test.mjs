import test,{after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';

const root=resolve(import.meta.dirname,'../../..'),require=createRequire(join(root,'engine/harness/packages/client/ui-primitives/package.json'));
const {JSDOM}=require('jsdom'),dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react'),{render,fireEvent,act,cleanup,waitFor}=require('@testing-library/react');
const directory=mkdtempSync(join(tmpdir(),'nova-projects-view-'));
const bundle=await build({entryPoints:[join(root,'services/bot/web/projects.jsx')],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',plugins:[{name:'shared-react',setup(builder){builder.onResolve({filter:/^react(?:\/.*)?$/},args=>({path:require.resolve(args.path),external:true}));}}]});
writeFileSync(join(directory,'views.cjs'),bundle.outputFiles[0].text);
const {ProjectContext,expectedProject,activeProjectContext}=require(join(directory,'views.cjs'));
afterEach(()=>cleanup());after(()=>{dom.window.close();rmSync(directory,{recursive:true,force:true});});
const project={id:'alpha',name:'项目 A',goal:'完成资料研究',directory:null,workspace:'/data/projects/alpha',revision:3,status:'active'};
const second={...project,id:'beta',name:'项目 B',directory:'/work/beta',revision:2};
const catalog=(projects=[project,second],state={})=>({projects,state:{projectId:'alpha',focus:'work',revision:7,...state}});
const detail=(value=project,extras={})=>({project:value,references:[],records:[],tasks:[],summary:{decisions:[],options:[],questions:[],nextSteps:[],tasks:[],reports:[]},...extras});
function fixture(initial=catalog(),extra={}){
  let current=initial,details=Object.fromEntries(initial.projects.map(value=>[value.id,detail(value,extra)]));const sent=[];
  const api={call:async(name,body)=>{sent.push({name,body});if(name==='projects')return current;if(name==='project-experiments')return {runs:[],nextOffset:null};if(name==='project-detail')return details[body.id];return current;}};
  return {api,sent,get current(){return current;},replace(value,extras=extra){current=value;details=Object.fromEntries(value.projects.map(item=>[item.id,detail(item,extras)]));}};
}
async function open(view){await act(async()=>fireEvent.click(view.getByRole('button',{name:/当前项目|可接续项目/})));await waitFor(()=>assert.ok(view.getByRole('heading',{name:'项目 A'})));}
const change=(view,label,value)=>fireEvent.change(view.getByLabelText(label),{target:{value}});
const requests=(fixture,name)=>fixture.sent.filter(call=>call.name===name);

test('legacy snapshots remain compatible and daily focus keeps only a resumable project',()=>{
  const context={kind:'file',file:{id:'old-file'}};
  assert.equal(expectedProject(undefined),undefined);assert.equal(activeProjectContext(undefined,context),context);
  assert.deepEqual(expectedProject(catalog()),{projectId:'alpha',revision:7});
  assert.equal(activeProjectContext(catalog(undefined,{focus:'daily'}),context),null);
  const f=fixture(),legacy=render(React.createElement(ProjectContext,{api:f.api}));assert.equal(legacy.container.textContent,'');cleanup();
  const view=render(React.createElement(ProjectContext,{api:f.api,view:catalog(undefined,{focus:'daily'})}));
  assert.ok(view.getByText('可接续项目'));assert.equal(view.queryByRole('region',{name:'项目概览'}),null);assert.equal(f.sent.length,0);assert.doesNotMatch(view.container.textContent,/工作模式|日常模式|先不聊工作/);
});

test('explicit selection uses selection revision while project writes use project revision',async()=>{
  const f=fixture(),view=render(React.createElement(ProjectContext,{api:f.api,view:f.current}));
  await act(async()=>change(view,'切换项目','beta'));
  const call=requests(f,'project-action')[0];assert.equal(call.body.action,'select');assert.equal(call.body.projectId,'beta');assert.equal(call.body.revision,7);assert.ok(call.body.actionId);
  await open(view);await act(async()=>fireEvent.click(view.getByText('归档项目')));
  const archive=requests(f,'project-action')[1];assert.equal(archive.body.action,'archive');assert.equal(archive.body.id,'alpha');assert.equal(archive.body.revision,3);
});

test('creating a project allows an empty external directory and never creates an execution task',async()=>{
  const f=fixture(),view=render(React.createElement(ProjectContext,{api:f.api,view:f.current}));await open(view);
  fireEvent.click(view.getByText('新建项目'));change(view,'项目名称','读书笔记');change(view,'项目目标','整理这周的阅读');
  await act(async()=>fireEvent.submit(view.getByRole('button',{name:'创建项目'}).closest('form')));
  const call=requests(f,'project-action')[0];assert.equal(call.body.name,'读书笔记');assert.equal(call.body.directory,'');assert.equal(call.body.action,'create');assert.equal(call.body.revision,0);assert.equal(f.sent.some(call=>/background-task/.test(call.name)),false);
});

test('a changed project keeps draft text but blocks saving until latest content is loaded',async()=>{
  const f=fixture(),view=render(React.createElement(ProjectContext,{api:f.api,view:f.current}));await open(view);
  fireEvent.click(view.getByText('编辑项目信息'));change(view,'项目目标','我的未保存草稿');
  f.replace(catalog([{...project,goal:'其他页面已修改',revision:4},second]));
  view.rerender(React.createElement(ProjectContext,{api:f.api,view:f.current}));
  await waitFor(()=>assert.ok(view.getByText(/内容已更新，当前草稿保留/)));assert.equal(view.getByLabelText('项目目标').value,'我的未保存草稿');assert.equal(view.getByText('保存项目').disabled,true);
  await act(async()=>fireEvent.submit(view.getByText('保存项目').closest('form')));assert.equal(requests(f,'project-action').length,0);
  fireEvent.click(view.getByText('载入最新内容'));assert.equal(view.getByLabelText('项目目标').value,'其他页面已修改');
  change(view,'项目名称','项目 A 新名称');await act(async()=>fireEvent.submit(view.getByText('保存项目').closest('form')));
  assert.equal(requests(f,'project-action')[0].body.revision,4);
});

test('reference and record mutations use source ids and project revision without claiming unsupported reading',async()=>{
  const reference={id:'ref',kind:'file',path:'/notes/report.doc',title:'研究资料',readCapability:'metadata_only',status:'active',revision:1},record={id:'record',type:'option',text:'考虑方案一',status:'active',revision:1};
  const f=fixture(catalog(),{references:[reference],records:[record]}),view=render(React.createElement(ProjectContext,{api:f.api,view:f.current}));await open(view);
  assert.ok(view.getByText(/正文未接入/));fireEvent.click(view.getByText('编辑资料'));change(view,'资料用途','用于核对数据');
  await act(async()=>fireEvent.submit(view.getByText('保存资料').closest('form')));
  const referenceCall=requests(f,'project-reference')[0];assert.equal(referenceCall.body.referenceId,'ref');assert.equal(referenceCall.body.purpose,'用于核对数据');assert.equal(referenceCall.body.revision,3);assert.equal(Object.hasOwn(referenceCall.body,'source'),false);
  await waitFor(()=>assert.equal(view.getByText('更正记录').disabled,false));fireEvent.click(view.getByText('更正记录'));change(view,'记录类型','decision');change(view,'记录内容','已经确认方案二');
  await act(async()=>fireEvent.submit(view.getByText('保存记录').closest('form')));
  const recordCall=requests(f,'project-record')[0];assert.equal(recordCall.body.recordId,'record');assert.equal(recordCall.body.type,'decision');assert.equal(recordCall.body.text,'已经确认方案二');assert.equal(recordCall.body.revision,3);
  await waitFor(()=>assert.equal(view.getByText('作废记录').disabled,false));await act(async()=>fireEvent.click(view.getByText('作废记录')));assert.equal(requests(f,'project-record')[1].body.action,'retire');
});

test('native document references advertise on-demand reading without pretending an association read the body',async()=>{
  const reference={id:'pdf-ref',kind:'file',path:'/notes/report.pdf',title:'PDF 资料',readCapability:'native_file',readStatus:'unread',status:'active',revision:1};
  const f=fixture(catalog(),{references:[reference]}),view=render(React.createElement(ProjectContext,{api:f.api,view:f.current}));await open(view);
  assert.ok(view.getByText(/正文可按需读取 · 读取结果见对话记录/));
  assert.doesNotMatch(view.container.textContent,/正文未接入|已读取来源|已有读取记录/);
});

test('a lost response retries the identical action even after another snapshot changes the revision',async()=>{
  const f=fixture();const original=f.api.call;let failed=false;
  f.api.call=async(name,body)=>{const value=await original(name,body);if(name==='project-action'&&!failed){failed=true;throw Object.assign(Error('network'),{code:'network'});}return value;};
  const view=render(React.createElement(ProjectContext,{api:f.api,view:f.current}));await open(view);await act(async()=>fireEvent.click(view.getByText('归档项目')));
  assert.ok(view.getByText('重试上次项目操作'));f.replace(catalog([{...project,revision:4,status:'archived'},second],{revision:8,projectId:'beta'}));view.rerender(React.createElement(ProjectContext,{api:f.api,view:f.current}));
  await act(async()=>fireEvent.click(view.getByText('重试上次项目操作')));
  const calls=requests(f,'project-action');assert.equal(calls.length,2);assert.deepEqual(calls[0].body,calls[1].body);assert.equal(calls[1].body.revision,3);
});

test('selection references capture the displayed selection identity and cannot invent a missing selection',async()=>{
  const f=fixture(),props={api:f.api,view:f.current},view=render(React.createElement(ProjectContext,props));await open(view);fireEvent.click(view.getByText('添加资料'));change(view,'资料类型','selection');
  assert.equal(view.getByText('保存资料').disabled,true);
  const selection={documentId:'document',revision:4,text:'需要关联的这一段'};
  view.rerender(React.createElement(ProjectContext,{...props,currentContext:{kind:'browser',selection,page:{url:'https://example.com',revision:4}}}));
  await act(async()=>fireEvent.submit(view.getByText('保存资料').closest('form')));
  const call=requests(f,'project-reference')[0];assert.equal(call.body.kind,'selection');assert.deepEqual(call.body.expectedSelection,selection);assert.equal(Object.hasOwn(call.body,'path'),false);assert.equal(Object.hasOwn(call.body,'url'),false);
});

test('late detail responses cannot replace a newer inspected project',async()=>{
  const f=fixture();let finishAlpha;const api={call:async(name,body)=>name==='project-detail'&&body.id==='alpha'?await new Promise(resolve=>{finishAlpha=resolve;}):f.api.call(name,body)};
  const view=render(React.createElement(ProjectContext,{api,view:f.current}));await act(async()=>fireEvent.click(view.getByRole('button',{name:/当前项目/})));assert.ok(view.getByText('正在加载项目…'));
  await act(async()=>change(view,'查看项目','beta'));await waitFor(()=>assert.ok(view.getByRole('heading',{name:'项目 B'})));
  await act(async()=>finishAlpha(detail(project)));assert.equal(view.queryByRole('heading',{name:'项目 A'}),null);assert.ok(view.getByRole('heading',{name:'项目 B'}));
});

test('failed detail loads expose an error and can be refreshed without disabling conversation',async()=>{
  const f=fixture();let failing=true;const api={call:async(name,body)=>{if(name==='project-detail'&&failing)throw Object.assign(Error('unknown_project'),{code:'unknown_project'});return f.api.call(name,body);}};
  const view=render(React.createElement(ProjectContext,{api,view:f.current}));await act(async()=>fireEvent.click(view.getByRole('button',{name:/当前项目/})));
  await waitFor(()=>assert.match(view.getByRole('alert').textContent,/没有找到这个项目/));failing=false;await act(async()=>fireEvent.click(view.getByText('刷新项目')));await waitFor(()=>assert.ok(view.getByRole('heading',{name:'项目 A'})));assert.equal(view.queryByRole('alert'),null);
});

test('archived projects are readable and restoration does not resume a task',async()=>{
  const f=fixture(catalog([{...project,status:'archived'},second],{projectId:'beta'})),view=render(React.createElement(ProjectContext,{api:f.api,view:f.current}));await act(async()=>fireEvent.click(view.getByRole('button',{name:/当前项目/})));await act(async()=>change(view,'查看项目','alpha'));
  await waitFor(()=>assert.ok(view.getByText('恢复项目')));assert.equal(view.getByText('编辑项目信息').disabled,true);assert.equal(view.getByText('接续项目').disabled,true);
  await act(async()=>fireEvent.click(view.getByText('恢复项目')));assert.equal(requests(f,'project-action')[0].body.action,'restore');assert.equal(f.sent.some(call=>/background-task/.test(call.name)),false);
});

test('summary separates adopted decisions and options and preserves interrupted task state',async()=>{
  const task={id:'task',title:'校对资料',status:'interrupted'},extras={records:[{id:'old',type:'decision',text:'旧决定不应恢复',status:'retired'}],tasks:[task],summary:{decisions:[{id:'decision',text:'采用方案甲'}],options:[{id:'option',text:'尚未采纳方案乙'}],questions:[],nextSteps:[],tasks:[task],reports:[],truncated:false}};
  const f=fixture(catalog(),extras),opened=[],view=render(React.createElement(ProjectContext,{api:f.api,view:f.current,onOpenTask:id=>opened.push(id)}));await open(view);
  assert.ok(view.getByText('采用方案甲'));assert.ok(view.getByText('尚未采纳方案乙'));assert.equal(view.queryByText('旧决定不应恢复'),null);assert.match(view.container.textContent,/校对资料 · 已中断/);
  fireEvent.click(view.getByRole('button',{name:'校对资料 · 已中断'}));assert.deepEqual(opened,['task']);
});

test('composer integration freezes ownership and narrow overview constraints stay in place',()=>{
  const app=readFileSync(join(root,'services/bot/web/app.jsx'),'utf8'),css=readFileSync(join(root,'services/bot/web/app.css'),'utf8');
  assert.match(app,/outgoing\.current\|\|\{id:crypto\.randomUUID\(\),text:draft,\.\.\.\(project\?\{expectedProject:project\}/);assert.match(app,/activeProjectContext\(snapshot\?\.projects/);
  assert.match(css,/\.project-overview\{[^}]*min-width:0[^}]*max-height:min\(32dvh,calc\(64dvh - 210px\)\)[^}]*overflow:auto/);assert.match(css,/\.chat-bottom:has\(\.project-overview\)>\.context-chip\{display:none\}/);assert.match(css,/@media\(max-width:460px\)\{\.project-context-row/);assert.match(css,/\.project-actions\{[^}]*flex-wrap:wrap/);
});
