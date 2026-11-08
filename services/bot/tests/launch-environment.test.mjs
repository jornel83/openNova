import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {launchEnvironment} from '../launch-environment.mjs';
import {videoCredential} from '../skills/credentials.mjs';

test('unified launcher passes the supported video credential without forwarding unrelated secrets',()=>{
  const source={PATH:process.env.PATH,HOME:'/private-home',ARK_API_KEY:'test-video-key',OTHER_API_KEY:'unrelated',
    ACCESS_TOKEN:'unrelated',MY_SECRET:'unrelated',PASSWORD:'unrelated',DSH_HOME:'old-home',NODE_OPTIONS:'--invalid-option'};
  const env=launchEnvironment(source);
  assert.deepEqual(env,{PATH:source.PATH,HOME:source.HOME,ARK_API_KEY:'test-video-key'});
  assert.equal(source.NODE_OPTIONS,'--invalid-option','the parent environment stays unchanged');
  assert.equal(videoCredential({root:'unused',env}),'test-video-key');
  const result=spawnSync(process.execPath,['--input-type=module','-e',
    'if(process.env.ARK_API_KEY!=="test-video-key"||process.env.OTHER_API_KEY||process.env.NODE_OPTIONS)process.exit(1);'],{env,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');
});

test('launcher does not create a video credential when none was configured',()=>{
  const env=launchEnvironment({PATH:'/usr/bin'});
  assert.equal(env.ARK_API_KEY,undefined);assert.equal(videoCredential({root:'unused',env}),'');
});
