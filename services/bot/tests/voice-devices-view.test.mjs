import test,{after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {deviceSelection,deviceChoices} from '../web/voice-devices-state.mjs';

const root=resolve(import.meta.dirname,'../../..'),require=createRequire(join(root,'engine/harness/packages/client/ui-primitives/package.json'));
const {JSDOM}=require('jsdom'),dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react'),{render,fireEvent,act,cleanup,waitFor}=require('@testing-library/react');
const directory=mkdtempSync(join(tmpdir(),'nova-voice-devices-view-'));
const bundle=await build({entryPoints:[join(root,'services/bot/web/voice-devices.jsx')],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',plugins:[{name:'shared-react',setup(builder){builder.onResolve({filter:/^react(?:\/.*)?$/},args=>({path:require.resolve(args.path),external:true}));}}]});
writeFileSync(join(directory,'views.cjs'),bundle.outputFiles[0].text);
const {VoiceDevices}=require(join(directory,'views.cjs'));
afterEach(()=>cleanup());after(()=>{dom.window.close();rmSync(directory,{recursive:true,force:true});});

const devices=[{id:'uid:mic',name:'Mac 麦克风',inputChannels:1,outputChannels:0},{id:'uid:builtin',name:'Mac 扬声器',inputChannels:0,outputChannels:2},{id:'uid:bt',name:'蓝牙音响',inputChannels:0,outputChannels:2}];
const initial={devices,defaultInput:'uid:mic',defaultOutput:'uid:builtin',selection:{input:null,output:null},revision:0};
const standby={voiceInstanceId:'standby',connected:true,phase:'standby',capture:'off',audioEnabled:false,deviceRevision:0,devices:{input:null,output:null}};
const live={voiceInstanceId:'native',connected:true,phase:'active',capture:'listening',audioEnabled:true,deviceRevision:0,devices:{input:null,output:null,activeInput:'Mac 麦克风',activeOutput:'Mac 扬声器',switching:false}};
function fixture(voice=standby){
  const calls=[];let catalog=structuredClone(initial),control=null;
  const api={call:async(name,body)=>{
    calls.push({name,body});
    if(name==='voice-devices')return structuredClone(catalog);
    if(name==='voice-devices-select'){
      catalog={...catalog,selection:{input:body.input,output:body.output},revision:catalog.revision+1};
      return {...catalog,apply:control?'queued':'next_start',...(control?{control}: {})};
    }
    throw Error('unexpected_api');
  }};
  const props={api,voice,online:true};
  return {props,calls,setCatalog(value){catalog=value;},setControl(value){control=value;}};
}
async function open(view){await act(async()=>fireEvent.click(view.getByRole('button',{name:'音频设备'})));await waitFor(()=>assert.equal(view.getByLabelText('麦克风').disabled,false));}
const change=(view,label,value)=>fireEvent.change(view.getByLabelText(label),{target:{value}});
const save=async(view,label)=>act(async()=>fireEvent.submit(view.getByRole('button',{name:label}).closest('form')));
const writes=f=>f.calls.filter(call=>call.name==='voice-devices-select');

test('opening devices only enumerates and separates microphone from playback directions',async()=>{
  const f=fixture(),view=render(React.createElement(VoiceDevices,f.props));
  assert.equal(f.calls.length,0);await open(view);
  assert.deepEqual(f.calls.map(call=>call.name),['voice-devices']);
  assert.equal(view.getByLabelText('麦克风').options.length,2);
  assert.equal(view.getByLabelText('外放').options.length,3);
  assert.doesNotMatch(view.getByLabelText('麦克风').textContent,/蓝牙音响/);
  assert.ok(view.getByRole('button',{name:'保存选择'}));
});

test('saving in standby keeps audio disabled and new selection survives old heartbeats',async()=>{
  const f=fixture(),view=render(React.createElement(VoiceDevices,f.props));await open(view);
  change(view,'外放','uid:bt');await save(view,'保存选择');
  assert.deepEqual(writes(f)[0].body,{expectedRevision:0,input:null,output:'uid:bt',voiceInstanceId:'standby'});
  assert.ok(view.getByText('设备选择已保存，下次开启语音时使用。'));
  view.rerender(React.createElement(VoiceDevices,{...f.props,voice:{...standby,seq:2}}));
  assert.equal(view.getByLabelText('外放').value,'uid:bt');
  assert.equal(f.calls.some(call=>call.name==='voice-control'),false);
  view.rerender(React.createElement(VoiceDevices,{...f.props,voice:{...live,deviceRevision:1,devices:{...live.devices,output:'uid:bt',activeOutput:'蓝牙音响'}}}));
  assert.equal(view.queryByText('设备选择已保存，下次开启语音时使用。'),null);
});

test('active apply waits for matching native revision after applied ack before reporting connection',async()=>{
  const f=fixture(live);f.setControl({id:'switch',status:'queued'});
  const view=render(React.createElement(VoiceDevices,f.props));await open(view);change(view,'外放','uid:bt');await save(view,'应用并重连');
  assert.ok(view.getByText('选择已保存，正在重连音频设备…'));
  const acked={...live,controls:[{id:'switch',status:'applied'}]};
  view.rerender(React.createElement(VoiceDevices,{...f.props,voice:acked}));
  assert.equal(view.queryByText('音频设备已连接。'),null);
  assert.equal(view.getByRole('button',{name:'正在重连…'}).disabled,true);
  view.rerender(React.createElement(VoiceDevices,{...f.props,voice:{...acked,deviceRevision:1,devices:{...live.devices,output:'uid:bt',activeOutput:'蓝牙音响'}}}));
  await waitFor(()=>assert.ok(view.getByText('音频设备已连接。')));
  assert.ok(view.getByText('外放：蓝牙音响'));assert.equal(writes(f).length,1);
});

test('failed native connection keeps selected devices visible and allows a new attempt',async()=>{
  const f=fixture(live);f.setControl({id:'switch',status:'queued'});
  const view=render(React.createElement(VoiceDevices,f.props));await open(view);change(view,'外放','uid:bt');await save(view,'应用并重连');
  view.rerender(React.createElement(VoiceDevices,{...f.props,voice:{...live,capture:'error',controls:[{id:'switch',status:'failed'}]}}));
  await waitFor(()=>assert.match(view.getByRole('alert').textContent,/连接未完成/));
  assert.equal(view.getByLabelText('外放').value,'uid:bt');
  assert.equal(view.getByRole('button',{name:'应用并重连'}).disabled,false);
  assert.equal(view.queryByText('音频设备已连接。'),null);
});

test('refresh retains a draft and requires reconciling a newer saved settings revision',async()=>{
  const f=fixture(),view=render(React.createElement(VoiceDevices,f.props));await open(view);change(view,'外放','uid:bt');
  f.setCatalog({...initial,revision:2,selection:{input:'uid:mic',output:'uid:builtin'}});
  await act(async()=>fireEvent.click(view.getByRole('button',{name:'刷新设备'})));
  assert.equal(view.getByLabelText('外放').value,'uid:bt');assert.equal(view.getByRole('button',{name:'保存选择'}).disabled,true);
  assert.ok(view.getByText(/设备设置已在其他窗口更新/));
  fireEvent.click(view.getByRole('button',{name:'载入已保存选择'}));
  assert.equal(view.getByLabelText('外放').value,'uid:builtin');await save(view,'保存选择');
  assert.equal(writes(f)[0].body.expectedRevision,2);
});

test('disconnected selected device remains visible and blocks silent fallback to default',async()=>{
  const f=fixture({...standby,deviceRevision:1,devices:{input:null,output:'uid:missing'}});
  f.setCatalog({...initial,revision:1,selection:{input:null,output:'uid:missing'}});
  const view=render(React.createElement(VoiceDevices,f.props));await open(view);
  assert.equal(view.getByLabelText('外放').value,'uid:missing');assert.match(view.getByLabelText('外放').selectedOptions[0].textContent,/未连接/);
  assert.doesNotMatch(view.container.textContent,/uid:missing/);assert.equal(view.getByRole('button',{name:'保存选择'}).disabled,true);
  change(view,'外放','');await save(view,'保存选择');assert.equal(writes(f)[0].body.output,null);
});

test('a new native owner does not make a pending change look connected',async()=>{
  const f=fixture(live);f.setControl({id:'switch',status:'queued'});
  const view=render(React.createElement(VoiceDevices,f.props));await open(view);change(view,'外放','uid:bt');await save(view,'应用并重连');
  view.rerender(React.createElement(VoiceDevices,{...f.props,voice:{...live,voiceInstanceId:'replacement',controls:[]}}));
  await waitFor(()=>assert.match(view.getByRole('alert').textContent,/语音连接已变化/));
  assert.equal(writes(f).length,1);assert.equal(view.queryByText('音频设备已连接。'),null);
});

test('legacy CLI names map only when unique and unknown UIDs never become visible labels',()=>{
  assert.equal(deviceSelection('mac 麦克风',devices,'input'),'uid:mic');
  assert.equal(deviceSelection('Mac',devices,'output'),'uid:builtin');
  const duplicate=[...devices,{...devices[1],id:'uid:duplicate'}];
  assert.equal(deviceSelection('Mac',duplicate,'output'),'Mac');
  const choices=deviceChoices(initial,'input','uid:missing');
  assert.equal(choices.at(-1).unavailable,true);assert.doesNotMatch(choices.at(-1).label,/uid:/);
});
