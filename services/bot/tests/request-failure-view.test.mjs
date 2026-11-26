import test,{after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {diagnosticHint} from '../../agent/errors.mjs';
import {errorText,labels} from '../web/api.mjs';

const root=resolve(import.meta.dirname,'../../..'),require=createRequire(join(root,'engine/harness/packages/client/ui-primitives/package.json'));
const {JSDOM}=require('jsdom'),dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react'),{render,cleanup}=require('@testing-library/react');
const directory=mkdtempSync(join(tmpdir(),'nova-request-failure-view-'));
const bundle=await build({stdin:{contents:"export {ConversationMessage} from './services/bot/web/conversation-message.jsx';",resolveDir:root},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',
  alias:{'@opennova/ds-bot':join(root,'engine/bot/ds-bot/src/client'),'@deepseek-ai/dsh-client-ui-primitives':require.resolve('@deepseek-ai/dsh-client-ui-primitives')},
  loader:{'.css':'empty','.module.css':'empty','.wasm':'binary'},
  plugins:[{name:'shared-react',setup(builder){builder.onResolve({filter:/^react(?:-dom)?(?:\/.*)?$/},args=>({path:require.resolve(args.path),external:true}));}}]});
writeFileSync(join(directory,'views.cjs'),bundle.outputFiles[0].text);
const {ConversationMessage}=require(join(directory,'views.cjs'));
afterEach(()=>cleanup());after(()=>{dom.window.close();rmSync(directory,{recursive:true,force:true});});
const bot={id:'chief',name:'OpenNova',color:'blue',avatar:{shape:'drop'}},props={roster:{bots:[bot],byId:{chief:bot},roomsById:{}},botId:bot.id,sessionId:'conversation',replyStream:{draft:null},actions:{openSession:()=>{},quote:()=>{}},onOpenTask:()=>{}};
const request={id:'request',source:'web',input:'测试输入',status:'completed',text:'旧版泛化提示',createdAt:1000};
const diagnostic=(code,extra={})=>({type:'error',code,stage:'routing',...extra});
const unavailable={focus:'clarify',projectId:null,reason:'route_unavailable',question:'话题识别服务暂时不可用，当前项目保持不变，请稍后重试。'};
const attempt=(number,d)=>({attempt:number,reason:'route_unavailable',finishKind:'error',diagnostic:d});
const viewOf=message=>render(React.createElement(ConversationMessage,{...props,message}));

test('a model failure has one readable hint and inspectable HTTP/trace facts, never a success bubble',()=>{
  const d=diagnostic('api_error',{stage:'conversation',status:403,requestId:'req_access_123'});
  const view=viewOf({...request,status:'failed',error:'api_error',diagnostic:d});
  assert.equal(view.getByLabelText('本轮失败').textContent,diagnosticHint(d));
  assert.equal(view.container.querySelectorAll('.bt-bubble').length,0);
  const details=view.container.querySelector('details');assert.equal(details.open,false);
  assert.match(details.textContent,/HTTP 403/);assert.match(details.textContent,/req_access_123/);
  assert.doesNotMatch(view.getByLabelText('本轮失败').textContent,/api_error|req_access_123/);
  assert.equal(view.container.querySelector('.bt-ubody').textContent,request.input);
});

test('08:21-style completed history displays its final network failure without changing the saved record',()=>{
  const row={...request,routing:{...unavailable,diagnostics:{attempts:2,recovered:false,failures:[attempt(1,diagnostic('network_error')),attempt(2,diagnostic('network_error'))]}}};
  const before=structuredClone(row),view=viewOf(row);
  assert.equal(view.getByLabelText('本轮失败').textContent,diagnosticHint(diagnostic('network_error')));
  assert.equal(view.container.querySelectorAll('.bt-bubble').length,0);
  assert.doesNotMatch(view.container.querySelector('.assistant-message').textContent,/旧版泛化提示|本轮已完成/);
  view.rerender(React.createElement(ConversationMessage,{...props,message:structuredClone(row)}));
  assert.equal(view.getAllByLabelText('本轮失败').length,1);assert.deepEqual(row,before);
});

test('the final failure replaces an earlier network error and recovered clarifications remain successful',()=>{
  const final=diagnostic('api_error',{status:403,requestId:'req_final_403'});
  const row={...request,routing:{...unavailable,diagnostics:{attempts:2,recovered:false,failures:[attempt(1,diagnostic('network_error')),attempt(2,final)]}}};
  const view=viewOf(row);assert.equal(view.getByLabelText('本轮失败').textContent,diagnosticHint(final));
  assert.doesNotMatch(view.getByLabelText('本轮失败').textContent,/网络/);
  const recovered={...row,text:'你希望继续哪个项目？',routing:{...row.routing,failure:null,diagnostics:{...row.routing.diagnostics,recovered:true}}};
  view.rerender(React.createElement(ConversationMessage,{...props,message:recovered}));
  assert.equal(view.queryByLabelText('本轮失败'),null);assert.equal(view.container.querySelector('.bt-bubble').textContent,recovered.text);
});

test('a genuine clarification cannot become a failure merely from a model-supplied reason',()=>{
  const row={...request,text:'请说明你希望继续哪个项目。',routing:{focus:'clarify',projectId:null,reason:'route_unavailable',question:'请说明你希望继续哪个项目。'}};
  const view=viewOf(row);assert.equal(view.queryByLabelText('本轮失败'),null);assert.equal(view.container.querySelector('.bt-bubble').textContent,row.text);
});

test('older unstructured host failures use a generic explanation rather than inventing a network cause',()=>{
  const view=viewOf({...request,routing:unavailable});
  const message=view.getByLabelText('本轮失败').textContent;
  assert.equal(message,diagnosticHint(diagnostic('agent_runtime_failed')));assert.doesNotMatch(message,/网络|代理|route_unavailable/);
  view.rerender(React.createElement(ConversationMessage,{...props,message:{...request,status:'failed',error:'private_unknown_backend_text'}}));
  assert.doesNotMatch(view.container.textContent,/private_unknown_backend_text/);
});

test('new routing failures expose their precise hint and failed streaming keeps its partial answer separate',()=>{
  const route={...unavailable,failure:diagnostic('invalid_grant')};
  const view=viewOf({...request,status:'failed',routing:route});
  assert.equal(view.getByLabelText('本轮失败').textContent,diagnosticHint(route.failure));
  const failed={...request,status:'failed',partialText:'已经显示的部分回答。',diagnostic:diagnostic('stream_interrupted',{stage:'conversation'})};
  view.rerender(React.createElement(ConversationMessage,{...props,message:failed}));
  assert.match(view.getByLabelText('未完成的回答').textContent,/已经显示的部分回答/);
  assert.equal(view.getAllByLabelText('本轮失败').length,1);
  assert.equal(view.getByLabelText('本轮失败').textContent,diagnosticHint(failed.diagnostic));
});

test('plain model errors reuse the shared hint while structured API errors retain diagnostic details',()=>{
  assert.equal(errorText({message:'incomplete_model_response'}),diagnosticHint({code:'incomplete_model_response'}));
  assert.doesNotMatch(errorText({message:'incomplete_model_response'}),/incomplete_model_response/);
  assert.match(errorText({diagnostic:diagnostic('api_error',{status:403,requestId:'req_view_1'})}),/HTTP 403.*req_view_1/);
  assert.equal(errorText({message:'invalid_project_directory'}),labels.invalid_project_directory);
});

test('an ordinary input-validation code keeps its business explanation while confirmed model errors keep diagnostics',()=>{
  for(const error of [{message:'invalid_request'},{code:'invalid_request'}])assert.equal(errorText(error),labels.invalid_request);
  assert.match(errorText({message:'invalid_request'}),/消息不能为空.*8000/);
  const model={code:'invalid_request',stage:'conversation',status:400,requestId:'req_invalid_model'};
  for(const error of [model,{diagnostic:model}]){
    const text=errorText(error);assert.match(text,/ChatGPT.*请求格式/);assert.match(text,/HTTP 400.*req_invalid_model/);
    assert.doesNotMatch(text,/消息不能为空/);
  }
});
