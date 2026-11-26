import test,{after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';

const root=resolve(import.meta.dirname,'../../..');
const require=createRequire(join(root,'engine/harness/packages/client/ui-primitives/package.json'));
const {JSDOM}=require('jsdom'),dom=new JSDOM('<body></body>',{url:'http://localhost/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;
globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react'),{render,fireEvent,act,cleanup}=require('@testing-library/react');
const directory=mkdtempSync(join(tmpdir(),'nova-document-comparison-'));
const bundle=await build({entryPoints:[join(root,'services/bot/web/operation-card.jsx')],bundle:true,write:false,
  platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty','.module.css':'empty','.wasm':'binary'},
  alias:{'@deepseek-ai/dsh-client-ui-primitives':require.resolve('@deepseek-ai/dsh-client-ui-primitives')},
  plugins:[{name:'shared-react',setup(builder){
    builder.onResolve({filter:/^react(?:-dom)?(?:\/.*)?$/},args=>({path:require.resolve(args.path),external:true}));
  }}]});
writeFileSync(join(directory,'views.cjs'),bundle.outputFiles[0].text);
const {OperationCard}=require(join(directory,'views.cjs'));
afterEach(cleanup);after(()=>{dom.window.close();rmSync(directory,{recursive:true,force:true});});

const project={projectId:'supplies',revision:4};
const changes=[
  {kind:'cell',label:'表格 2 · 第 60 行 · 数量',before:'60',after:'75'},
  {kind:'summaryCell',label:'表格 2 · 合计行 · 数量',before:'1830',after:'1845'}
];
const proposal={id:'change-1',status:'pending',projectId:project.projectId,baseArtifactId:'base-1',baseRevision:1,
  format:'pdf',basePath:'/项目/物资清单.pdf',baseSha256:'a'.repeat(64),changeCount:2,changes,truncated:false};
function card(preview=proposal,extra={}){
  return React.createElement(OperationCard,{project,...extra,record:{id:'operation-1',operation:'document_generate',
    status:'completed',action:'revise',phase:'proposed',proposal:preview}});
}

test('pending Word and PDF comparisons identify both changes and offer scoped confirmation or discard',()=>{
  for(const format of ['docx','pdf']){
    const view=render(card({...proposal,format,basePath:'/物资/清单.'+format}));
    assert.equal(view.container.querySelector('details').open,true);
    assert.match(view.container.querySelector('summary').textContent,format==='pdf'?/PDF 修改对照待确认/:/Word 修改对照待确认/);
    assert.match(view.container.textContent,/基准第 1 版 · 共 2 处修改 · 尚未生成新版/);
    assert.deepEqual([...view.container.querySelectorAll('li')].map(item=>item.textContent),[
      '表格 2 · 第 60 行 · 数量修改前60修改后75','表格 2 · 合计行 · 数量修改前1830修改后1845']);
    assert.deepEqual(view.getAllByRole('button').map(b=>b.textContent),['确认应用','放弃修改']);
    view.unmount();
  }
});

test('double click starts a single confirmation; the receipt and the persisted card name the same edition',async()=>{
  const artifact={id:'v2',revision:2,path:'/项目/物资清单.v2.pdf'};
  const next={...proposal,status:'applied',artifact};
  const calls=[];let respond,refreshes=0;
  const options={api:{call:(name,body)=>{calls.push({name,body});return new Promise(r=>{respond=r;});}},onRefresh:async()=>{refreshes++;}};
  const view=render(card(proposal,options)),button=view.getByRole('button',{name:'确认应用'});
  fireEvent.click(button);fireEvent.click(button);
  assert.equal(calls.length,1);assert.equal(calls[0].name,'document-proposal-action');
  assert.deepEqual(calls[0].body,{id:'change-1',expectedProject:project,action:'confirm',actionId:calls[0].body.actionId});
  assert.match(calls[0].body.actionId,/^[\da-f-]{36}$/);
  assert.equal(view.getByRole('button',{name:'放弃修改'}).disabled,true);
  await act(async()=>respond({status:'completed',phase:'committed',proposal:next,artifact}));
  assert.equal(refreshes,1);
  assert.match(view.container.textContent,/已应用.*已保存第 2 版/);
  assert.ok(view.getByText(artifact.path));assert.ok(view.getByRole('button',{name:'撤销这次修改'}));
  view.unmount();
  const restored=render(card(next));assert.match(restored.container.textContent,/已应用.*已保存第 2 版/);
  assert.ok(restored.getByRole('button',{name:'撤销这次修改'}));
});

test('undo keeps the applied edition and shows the restored file after double click, reconnect and reload',async()=>{
  const applied={...proposal,status:'applied',artifact:{id:'v2',path:'/项目/物资清单.v2.pdf',revision:2}};
  const undone={...applied,status:'undone',undoArtifact:{id:'v3',path:'/项目/物资清单.v3.pdf',revision:3}};
  const calls=[];let reply;
  const options={api:{call:async(name,body)=>{
    assert.equal(name,'document-proposal-action');calls.push(body);
    if(calls.length===1)throw Error('暂时断线');
    return new Promise(resolve=>{reply=resolve;});
  }}};
  const view=render(card(applied,options));
  const undo=view.getByRole('button',{name:'撤销这次修改'});
  await act(async()=>fireEvent.click(undo));assert.match(view.getByRole('alert').textContent,/断线/);
  fireEvent.click(undo);fireEvent.click(undo);
  assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0].action,'undo');
  assert.equal(calls[0].id,applied.id);assert.deepEqual(calls[0].expectedProject,project);
  await act(async()=>reply({status:'completed',phase:'undone',proposal:undone,artifact:undone.undoArtifact}));
  assert.match(view.getByRole('status').textContent,/恢复为第 3 版/);
  assert.ok(view.getByText(undone.undoArtifact.path));assert.equal(view.queryByRole('button'),null);
  view.unmount();const restored=render(card(undone));
  assert.match(restored.container.querySelector('summary').textContent,/已撤销/);
  assert.ok(restored.getByText(undone.undoArtifact.path));
});

test('undo reports a manual edit and older applied editions have no undo action',async()=>{
  const applied={...proposal,status:'applied',artifact:{id:'v2',path:'/项目/物资清单.v2.pdf',revision:2}};
  const view=render(card(applied,{api:{call:async()=>({status:'failed',error:'document_revision_source_changed'})}}));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'撤销这次修改'})));
  assert.match(view.getByRole('alert').textContent,/已在磁盘上被修改.*撤销已停止/);
  assert.ok(view.getByText(applied.artifact.path));
  view.rerender(card({...applied,undoAvailable:false}));
  assert.equal(view.queryByRole('button'),null);
});

test('discard uses its own decision and a connection loss can safely retry the same action id',async()=>{
  const calls=[];let respond;
  const options={api:{call:async(name,body)=>{
    calls.push(body);
    if(calls.length===1)throw Error('暂时断线');
    return new Promise(r=>{respond=r;});
  }}};
  const view=render(card(proposal,options));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'放弃修改'})));
  assert.match(view.getByRole('alert').textContent,/暂时断线/);
  fireEvent.click(view.getByRole('button',{name:'放弃修改'}));
  assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0].action,'discard');
  await act(async()=>respond({status:'completed',phase:'discarded',proposal:{...proposal,status:'discarded'}}));
  assert.match(view.container.textContent,/已放弃这份方案/);assert.equal(view.queryByRole('button'),null);
});

test('an external edit keeps the original comparison and only the replacement can be confirmed',async()=>{
  const old={...proposal,status:'conflict',conflict:{reason:'document_revision_source_changed',replacementId:'change-2'}};
  const next={...proposal,id:'change-2',supersedesId:proposal.id,baseSha256:'b'.repeat(64),changes:[{...changes[0],before:'67'},changes[1]]};
  const calls=[];
  const options={visibleReviewIds:new Set([old.id,next.id]),api:{call:async(name,body)=>{
    calls.push(body);
    if(body.id===next.id)return {status:'completed',phase:'committed',proposal:{...next,status:'applied',artifact:{id:'v2',revision:2,path:'/项目/物资清单.v2.pdf'}}};
    return {status:'completed',phase:'conflict',proposal:old,replacementProposal:next};
  }}};
  const view=render(card(proposal,options));
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'确认应用'})));
  assert.match(view.container.textContent,/原方案已保留/);assert.equal(view.queryByRole('button',{name:'确认应用'}),null);
  assert.equal(calls.length,1);
  const newer=render(React.createElement('details',{},React.createElement('summary',{},'其他文档修改'),card(next,options)));
  fireEvent.click(view.getByRole('link',{name:'查看新对照'}));
  assert.equal(newer.container.querySelector('details').open,true);
  assert.equal(document.activeElement,newer.container.querySelector('#review-change-2 > summary'));
  assert.ok(newer.getByText('67'));assert.equal(calls.length,1);
  await act(async()=>fireEvent.click(newer.getByRole('button',{name:'确认应用'})));
  assert.equal(calls[1].id,'change-2');assert.ok(newer.getByText('/项目/物资清单.v2.pdf'));
});

test('a missing or unreadable original offers a new recheck attempt and preserves discard',async()=>{
  const old={...proposal,status:'conflict',conflict:{reason:'document_revision_source_missing',rebaseError:'document_rebase_unavailable'}};
  const calls=[];const options={api:{call:async(name,body)=>{calls.push(body);return {status:'completed',phase:'conflict',proposal:old};}}};
  const view=render(card(old,options));
  assert.match(view.container.textContent,/原位置已找不到文件/);
  assert.equal(view.queryByRole('button',{name:'确认应用'}),null);
  for(let i=0;i<2;i++)await act(async()=>fireEvent.click(view.getByRole('button',{name:'重新核对原文件'})));
  assert.notEqual(calls[0].actionId,calls[1].actionId);
  const matched={...old,conflict:{reason:'document_revision_source_changed',rebaseError:'document_rebase_already_matches'}};
  view.rerender(card(matched,options));
  assert.equal(view.queryByRole('button',{name:'重新核对原文件'}),null);
  assert.match(view.container.textContent,/磁盘文件已包含方案中的全部修改/);
});

test('expanded values are loaded from the bound project and stale responses after project changes are discarded',async()=>{
  const fullText='物资编号与实际数量逐项核对。'.repeat(80);
  const full={...proposal,changes:[{...changes[0],after:fullText},changes[1]]};
  const preview={...proposal,changes:[{...changes[0],after:fullText.slice(0,12)+'…',truncated:true}],truncated:true};
  let respond,calls=[];
  const api={call:(name,body)=>{calls.push([name,body]);return new Promise(resolve=>{respond=resolve;});}};
  const view=render(card(preview,{api}));
  fireEvent.click(view.getByRole('button',{name:'查看完整对照'}));
  assert.deepEqual(calls,[['document-proposal',{id:proposal.id,expectedProject:project}]]);
  view.rerender(card(preview,{api,project:{projectId:'another-project',revision:5}}));
  await act(async()=>respond(full));
  assert.equal(view.container.textContent,'');
  view.rerender(card(preview,{api,project:{...project,revision:6}}));
  assert.equal(view.queryByText(fullText),null);
  fireEvent.click(view.getByRole('button',{name:'查看完整对照'}));
  await act(async()=>respond({...full,baseSha256:'b'.repeat(64)}));
  assert.match(view.getByRole('alert').textContent,/无法读取这份修改对照/);
  assert.equal(view.queryByText(fullText),null);
  fireEvent.click(view.getByRole('button',{name:'查看完整对照'}));
  await act(async()=>respond(full));
  assert.equal(view.getByText(fullText).tagName,'DD');
  assert.equal(view.getByText('1845').tagName,'DD');
  assert.equal(view.queryByRole('button',{name:'查看完整对照'}),null);
});
