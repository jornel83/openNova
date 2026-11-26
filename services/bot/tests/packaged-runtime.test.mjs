import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {runtimePaths,writableRuntimePath} from '../../runtime/paths.mjs';
import {ROOT} from '../../runtime/sources.mjs';
import {botSettings} from '../settings.mjs';
import {loadSettings} from '../../agent/settings.mjs';
import {imageRuntimeEnv} from '../images/runtime.mjs';
import {installedImagePython} from '../images/runtime-path.mjs';
import {launchEnvironment} from '../launch-environment.mjs';

function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'Nova packaged 中文 '));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const app=join(directory,'OpenNova.app'),root=join(app,'Contents/Resources/app'),data=join(directory,'Application Support/OpenNova');
  mkdirSync(root,{recursive:true});mkdirSync(data,{recursive:true});
  return {directory,app,root,data,env:{OPENNOVA_PACKAGED:'1',OPENNOVA_APP_DATA:data}};
}

test('packaged defaults keep resources separate from writable user state and preserve development defaults',t=>{
  const {root,data,env}=fixture(t),paths=runtimePaths(env,root);
  assert.equal(paths.workspace,join(data,'workspace'));
  assert.equal(paths.botHome,join(data,'bot-spike'));
  assert.equal(paths.configFile,join(data,'config/voice.local.json'));
  assert.equal(paths.siwcStorage,join(data,'accounts'));
  assert.equal(paths.logsRoot,join(data,'logs'));
  const b=botSettings({...env,OPENNOVA_WORKSPACE:join(data,'my work')});
  assert.equal(b.workspace,join(data,'my work'));
  assert.equal(b.videoKeyPath,join(data,'config/ark.key'));
  assert.equal(botSettings({OPENNOVA_WORKSPACE:join(data,'ignored in development')}).workspace,ROOT);
  assert.equal(runtimePaths({},root).configFile,join(root,'config/voice.local.json'));
});

test('packaged writable paths reject the entire application and symlink aliases',t=>{
  const {directory,app,root,env}=fixture(t);
  for(const path of [root,join(app,'Contents/Resources/state'),join(root,'config/new.json')])
    assert.throws(()=>writableRuntimePath(path,env,root),/packaged_state_must_be_outside_application/);
  symlinkSync(app,join(directory,'alias'));
  assert.throws(()=>runtimePaths({...env,OPENNOVA_BOT_HOME:join(directory,'alias/Contents/state')},root),/packaged_state_must_be_outside_application/);
  assert.throws(()=>runtimePaths({...env,OPENNOVA_WORKSPACE:root},root),/packaged_state_must_be_outside_application/);
});

test('packaged agent reads user configuration and leaves executable helpers in resources',t=>{
  const {data,env}=fixture(t),file=join(data,'config/voice.local.json');
  mkdirSync(join(data,'config'));
  writeFileSync(file,JSON.stringify({agent:{siwc_storage:join(data,'configured accounts')}}));
  const settings=loadSettings(env);
  assert.equal(settings.storageDir,join(data,'configured accounts'));
  assert.equal(settings.keychainPath,join(ROOT,'output/bin/siwc-keychain'));
  assert.equal(settings.harnessRoot,join(ROOT,'engine/harness'));
  assert.throws(()=>loadSettings({...env,OPENNOVA_SIWC_STORAGE:join(ROOT,'accounts')}),/packaged_state_must_be_outside_application/);
});

test('packaged launch and image subprocesses keep runtime paths and certificates without unrelated credentials',t=>{
  const {env,root,data}=fixture(t),bin=join(root,'../runtime/bin'),python=join(root,'../runtime/python/bin/python3');
  const source={...env,OPENNOVA_BIN_DIR:bin,OPENNOVA_NODE:join(bin,'node'),OPENNOVA_PYTHON:python,OPENNOVA_IMAGE_PYTHON:python,
    OPENNOVA_CONFIG:join(data,'config/voice.local.json'),OPENNOVA_SECRETS_FILE:join(data,'config/secrets.local.json'),
    SSL_CERT_FILE:join(root,'../runtime/cert.pem'),OPENNOVA_IMAGE_ARK_KEY_FILE:join(data,'config/ark.key'),
    OTHER_API_KEY:'must-not-pass',ACCESS_TOKEN:'must-not-pass',NODE_OPTIONS:'--invalid-option'};
  const host=launchEnvironment(source);
  assert.equal(host.OPENNOVA_SECRETS_FILE,source.OPENNOVA_SECRETS_FILE);
  assert.equal(host.OPENNOVA_IMAGE_ARK_KEY_FILE,source.OPENNOVA_IMAGE_ARK_KEY_FILE);
  assert.equal(host.OPENNOVA_IMAGE_PYTHON,python);
  assert.equal(host.OTHER_API_KEY,undefined);assert.equal(host.NODE_OPTIONS,undefined);
  const image=imageRuntimeEnv({source,credentials:false});
  assert.ok(image.PATH.startsWith(join(root,'../runtime/bin')+':'));
  assert.equal(image.SSL_CERT_FILE,source.SSL_CERT_FILE);
  assert.equal(image.OPENNOVA_IMAGE_ARK_KEY_FILE,undefined);
  assert.equal(installedImagePython(undefined,root,source),python);
});

test('packaged launcher reuses only a host for the selected external workspace',async t=>{
  const {env,data}=fixture(t),home=join(data,'bot'),workspace=join(data,'selected workspace');
  mkdirSync(home);mkdirSync(workspace);writeFileSync(join(home,'client.token'),'test-only-token');
  let reportedWorkspace=workspace;
  const server=createServer((request,response)=>{
    assert.equal(request.url,'/health');assert.equal(request.headers.authorization,'Bearer test-only-token');
    response.setHeader('Content-Type','application/json');response.end(JSON.stringify({ready:true,workspace:reportedWorkspace}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const port=server.address().port,childEnv={...env,PATH:'/usr/bin:/bin',OPENNOVA_BOT_HOME:home,OPENNOVA_WORKSPACE:workspace,
    OPENNOVA_BOT_PORT:String(port),OPENNOVA_BOT_WEB_PORT:String(port===65535?65534:port+1),
    OPENNOVA_CONFIG:join(data,'missing-config.json'),OPENNOVA_SECRETS_FILE:join(data,'missing-secrets.json')};
  const run=()=>promisify(execFile)(process.execPath,[join(ROOT,'services/bot/launch.mjs'),'--no-ui'],{env:childEnv,timeout:10000});
  const result=await run();assert.match(result.stdout,/复用现有会话/);
  reportedWorkspace=ROOT;
  await assert.rejects(run(),error=>error.code===1&&/现有 Bot 使用了其他工程/.test(error.stderr));
});
