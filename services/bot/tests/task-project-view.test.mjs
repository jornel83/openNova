import test,{after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';

const root=resolve(import.meta.dirname,'../../..'),require=createRequire(join(root,'engine/harness/packages/client/ui-primitives/package.json'));
const {JSDOM}=require('jsdom'),dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react'),{render,fireEvent,act,cleanup,within,waitFor}=require('@testing-library/react');
const directory=mkdtempSync(join(tmpdir(),'nova-task-project-view-'));
const bundle=await build({stdin:{contents:"export {TaskPanel} from './services/bot/web/tasks.jsx';export {AgentTaskForm} from './services/bot/web/agent-tasks.jsx';",resolveDir:root},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',plugins:[{name:'shared-react',setup(builder){builder.onResolve({filter:/^react(?:\/.*)?$/},args=>({path:require.resolve(args.path),external:true}));}}]});
writeFileSync(join(directory,'views.cjs'),bundle.outputFiles[0].text);
const {TaskPanel,AgentTaskForm}=require(join(directory,'views.cjs'));
afterEach(()=>cleanup());after(()=>{dom.window.close();rmSync(directory,{recursive:true,force:true});});
const projectView=(projectId='alpha',revision=7,focus='work')=>({state:{projectId,revision,focus},projects:[{id:'alpha',name:'项目 A',status:'active'},{id:'beta',name:'项目 B',status:'active'}]});
const change=(view,label,value)=>fireEvent.change(view.getByLabelText(label),{target:{value}});
const overview={counts:{total:0},members:[],active:[],attention:[],recent:[]};

function formFixture(kind,{failFirst=false,projects=projectView()}={}){
  const sent=[];let writes=0;
  const start=async(name,body)=>{sent.push(structuredClone(body));if(failFirst&&++writes===1)throw Object.assign(Error('network'),{code:'network'});return {task:{id:'created'}};};
  const api={call:async(name,body)=>name==='background-task-start'?start(name,body):name==='team-overview'?overview:name==='background-tasks'?{tasks:[],total:0,hasMore:false}:{skills:[],members:[]}};
  const Component=kind==='agent'?AgentTaskForm:TaskPanel;
  const props=kind==='agent'?{action:start,onSelect:()=>{},projects}:{api,summary:{tasks:[]},selectedId:null,onSelect:()=>{},online:true,projects};
  const view=render(React.createElement(Component,props));
  const form=()=>kind==='agent'?view.container.querySelector('form'):view.getByText('直接运行命令').closest('details').querySelector('form');
  const queries=()=>within(form());
  const fill=()=>{change(queries(),'任务名称','原项目任务');change(queries(),kind==='agent'?'任务目标':'命令',kind==='agent'?'整理原项目资料':'printf task');};
  const rerender=next=>view.rerender(React.createElement(Component,{...props,projects:next}));
  return {view,form,queries,fill,rerender,sent};
}

for(const kind of ['command','agent']){
  test(`${kind}: first submission binds the project shown while drafting`,async()=>{
    const f=formFixture(kind);f.fill();await act(async()=>fireEvent.submit(f.form()));
    assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0].expectedProject,{projectId:'alpha',revision:7});assert.ok(f.sent[0].id);
  });

  test(`${kind}: an edited draft cannot silently move to another project`,async()=>{
    const f=formFixture(kind);f.fill();f.rerender(projectView('beta',8));
    assert.ok(f.queries().getByText(/当前项目已变化，任务草稿已保留/));assert.equal(f.form().querySelector('button[type=submit]').disabled,true);
    await act(async()=>fireEvent.submit(f.form()));assert.equal(f.sent.length,0);assert.equal(f.queries().getByLabelText('任务名称').value,'原项目任务');
    fireEvent.click(f.queries().getByText('确认使用当前项目'));await act(async()=>fireEvent.submit(f.form()));assert.deepEqual(f.sent[0].expectedProject,{projectId:'beta',revision:8});
  });

  test(`${kind}: same-project revision changes also require confirming the draft`,async()=>{
    const f=formFixture(kind);f.fill();f.rerender(projectView('alpha',8));
    assert.equal(f.form().querySelector('button[type=submit]').disabled,true);await act(async()=>fireEvent.submit(f.form()));assert.equal(f.sent.length,0);
  });

  test(`${kind}: lost response retries original id and project after switching to daily`,async()=>{
    const f=formFixture(kind,{failFirst:true});f.fill();await act(async()=>fireEvent.submit(f.form()));
    await waitFor(()=>assert.ok(f.queries().getByText(/重试只核对原项目中的同一任务/)));
    f.rerender(projectView('beta',8,'daily'));change(f.queries(),'任务名称','不能混入重试的新内容');
    assert.equal(f.form().querySelector('button[type=submit]').disabled,false);await act(async()=>fireEvent.submit(f.form()));
    assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1],f.sent[0]);assert.deepEqual(f.sent[1].expectedProject,{projectId:'alpha',revision:7});
  });

  test(`${kind}: daily focus cannot create a new work task`,async()=>{
    const f=formFixture(kind,{projects:projectView('alpha',7,'daily')});f.fill();
    assert.ok(f.queries().getByText(/请从项目入口选择或接续项目/));assert.equal(f.form().querySelector('button[type=submit]').disabled,true);
    await act(async()=>fireEvent.submit(f.form()));assert.equal(f.sent.length,0);
  });

  test(`${kind}: empty forms can follow selection before any draft is entered`,async()=>{
    const f=formFixture(kind);f.rerender(projectView('beta',8));f.fill();await act(async()=>fireEvent.submit(f.form()));
    assert.deepEqual(f.sent[0].expectedProject,{projectId:'beta',revision:8});
  });
}

test('the application passes project snapshots into the task panel',()=>{
  const app=readFileSync(join(root,'services/bot/web/app.jsx'),'utf8');assert.match(app,/<TaskPanel api=\{api\} projects=\{snapshot\?\.projects\}/);
});
