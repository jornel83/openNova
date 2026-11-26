import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,statSync,writeFileSync,mkdirSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runtimeLayout,ensureConfiguration,saveSettings,settingsSummary,appEnvironment} from '../runner.mjs';

function fixture(t){
  const data=mkdtempSync(join(tmpdir(),'opennova-app-test-'));
  t.after(()=>rmSync(data,{recursive:true,force:true}));
  const layout=runtimeLayout('/Applications/OpenNova.app/Contents/Resources/app',{OPENNOVA_APP_DATA:data});
  ensureConfiguration(layout);return layout;
}
test('packaged profile lives outside application resources and is initialized privately',t=>{
  const l=fixture(t);
  assert.equal(l.node,'/Applications/OpenNova.app/Contents/Resources/runtime/bin/node');
  assert.equal(l.port,19560);assert.equal(l.webPort,19561);
  assert.equal(statSync(l.secrets).mode&0o777,0o600);
  assert.equal(statSync(l.settings).mode&0o777,0o600);
  assert.equal(JSON.parse(readFileSync(l.settings)).tts.provider,'doubao');
  assert.equal(settingsSummary(l).hasAsrKey,false);
});
test('saving settings preserves blank credentials and never returns their values',t=>{
  const l=fixture(t);
  saveSettings(l,{asrKey:'test-only-asr-value',ttsKey:'test-only-tts-value',proxy:'http://127.0.0.1:7897'});
  const result=saveSettings(l,{asrKey:'',ttsKey:'',proxy:''});
  assert.deepEqual(result,{proxy:'',hasAsrKey:true,hasTtsKey:true});
  assert.equal(JSON.parse(readFileSync(l.secrets)).doubao.api_key,'test-only-asr-value');
  assert.ok(!JSON.stringify(result).includes('test-only'));
  assert.equal(statSync(l.secrets).mode&0o777,0o600);
});
test('invalid preferences cannot partially alter secrets',t=>{
  const l=fixture(t),before=readFileSync(l.secrets,'utf8');
  assert.throws(()=>saveSettings(l,{asrKey:'replacement',proxy:'file:///tmp/test'}),/HTTP/);
  assert.throws(()=>saveSettings(l,{asrKey:'replacement',proxy:'http://user:secret@example.test'}),/HTTP/);
  assert.throws(()=>saveSettings(l,{asrKey:'bad\nkey',proxy:''}),/密钥/);
  assert.equal(readFileSync(l.secrets,'utf8'),before);
});
test('Finder environment uses bundled executables and private authorization',t=>{
  const l=fixture(t);
  const env=appEnvironment(l,{HOME:'/Users/example',PATH:'/opt/homebrew/bin',OPENNOVA_SIWC_STORAGE:'/private/developer-account',OPENNOVA_PROXY:'http://old.test',HTTPS_PROXY:'http://old.test',NODE_OPTIONS:'--require=outside.js',ARK_API_KEY:'developer-secret',DOUBAO_TTS_API_KEY:'developer-speech-secret',OPENAI_API_KEY:'developer-api-secret',PYTHONPATH:'/developer/modules'});
  assert.equal(env.OPENNOVA_NODE,l.node);assert.equal(env.OPENNOVA_PYTHON,l.python);
  assert.equal(env.OPENNOVA_SIWC_STORAGE,join(l.data,'auth'));assert.equal(env.OPENNOVA_SECRETS_FILE,l.secrets);
  assert.equal(env.OPENNOVA_ARK_KEY_FILE,join(l.config,'ark.key'));
  assert.equal(env.OPENNOVA_IMAGE_ARK_KEY_FILE,join(l.config,'ark.key'));
  assert.equal(env.OPENNOVA_GITHUB_TOKEN_FILE,join(l.config,'github.token'));
  assert.ok(!env.PATH.includes('homebrew'));
  for(const key of ['OPENNOVA_PROXY','HTTPS_PROXY','NODE_OPTIONS','ARK_API_KEY','DOUBAO_TTS_API_KEY','OPENAI_API_KEY','PYTHONPATH'])assert.equal(env[key],undefined,key);
  saveSettings(l,{proxy:'http://127.0.0.1:7897'});
  assert.equal(appEnvironment(l,{}).HTTPS_PROXY,'http://127.0.0.1:7897');
});
test('initialization leaves existing user settings and unrelated credentials intact',t=>{
  const l=fixture(t);
  writeFileSync(l.secrets,JSON.stringify({doubao:{api_key:'test-only'},web:{deepseek_api_key:'other-test-only'}}));
  saveSettings(l,{proxy:''});ensureConfiguration(l);
  assert.equal(JSON.parse(readFileSync(l.secrets)).web.deepseek_api_key,'other-test-only');
  assert.equal(settingsSummary(l).hasAsrKey,true);
});
test('ports must be valid and distinct',()=>{
  assert.throws(()=>runtimeLayout('/app',{OPENNOVA_BOT_PORT:'19560',OPENNOVA_BOT_WEB_PORT:'19560'}),/端口/);
  assert.throws(()=>runtimeLayout('/app',{OPENNOVA_BOT_PORT:'abc'}),/端口/);
});

test('all writable paths are rejected before any initialization write inside an app',t=>{
  const base=mkdtempSync(join(tmpdir(),'opennova-layout-test-'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const app=join(base,'OpenNova.app'),root=join(app,'Contents/Resources/app');
  mkdirSync(root,{recursive:true});
  for(const key of ['OPENNOVA_APP_DATA','OPENNOVA_BOT_HOME','OPENNOVA_WORKSPACE']){
    const outside=join(base,'outside-'+key),inside=join(app,'bad-'+key);
    const layout=runtimeLayout(root,{OPENNOVA_APP_DATA:outside,[key]:inside});
    assert.throws(()=>ensureConfiguration(layout),/OpenNova.app 之外/);
    assert.equal(existsSync(inside),false);
    assert.equal(existsSync(outside),false);
  }
});
test('an external data path pointing into the application cannot modify the bundle',t=>{
  const base=mkdtempSync(join(tmpdir(),'opennova-layout-symlink-'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const app=join(base,'OpenNova.app'),root=join(app,'Contents/Resources/app'),link=join(base,'state-link');
  mkdirSync(root,{recursive:true});symlinkSync(app,link,'dir');
  assert.throws(()=>ensureConfiguration(runtimeLayout(root,{OPENNOVA_APP_DATA:link})),/OpenNova.app 之外/);
  assert.equal(existsSync(join(app,'config')),false);
});
test('preexisting settings symlinks into the bundle are rejected before creating directories',t=>{
  const base=mkdtempSync(join(tmpdir(),'opennova-layout-settings-'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const app=join(base,'OpenNova.app'),root=join(app,'Contents/Resources/app'),data=join(base,'data');
  mkdirSync(root,{recursive:true});mkdirSync(join(data,'config'),{recursive:true});
  const immutable=join(root,'immutable.json');writeFileSync(immutable,'{}');
  symlinkSync(immutable,join(data,'config/voice.local.json'));
  assert.throws(()=>ensureConfiguration(runtimeLayout(root,{OPENNOVA_APP_DATA:data})),/OpenNova.app 之外/);
  assert.equal(existsSync(join(data,'logs')),false);assert.equal(readFileSync(immutable,'utf8'),'{}');
});

test('new installs default to cloud speech while preserving manually configured Studio',t=>{
  const l=fixture(t);
  assert.equal(appEnvironment(l,{}).OPENNOVA_TTS_PROVIDER,'doubao');
  const config=JSON.parse(readFileSync(l.settings));
  config.tts={provider:'studio',studio_host:'my-studio',studio_tts_dir:'/Users/example/tts'};
  writeFileSync(l.settings,JSON.stringify(config));
  saveSettings(l,{asrKey:'test-only-unused-key',proxy:''});
  assert.deepEqual(JSON.parse(readFileSync(l.settings)).tts,config.tts);
  assert.equal(appEnvironment(l,{}).OPENNOVA_TTS_PROVIDER,'studio');
  config.tts.provider='cloud';writeFileSync(l.settings,JSON.stringify(config));
  assert.equal(appEnvironment(l,{}).OPENNOVA_TTS_PROVIDER,'doubao');
  config.tts.provider='unknown';writeFileSync(l.settings,JSON.stringify(config));
  assert.throws(()=>appEnvironment(l,{}),/TTS 后端/);
});
