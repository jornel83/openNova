import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {promisify} from 'node:util';
import {BUILD_ARTIFACTS,checkBuild,recordBuild} from '../build-record.mjs';
import {ROOT} from '../../services/runtime/sources.mjs';

const run=promisify(execFile);
const textArgs=['--no-voice','--no-ui','--output-device','Fixture speaker'];

// Run the real launcher, freshness check, execution plan and interprocess build
// lock. Only the expensive compilers and the final audio/UI process are fixtures.
function checkout(t) {
  const root=mkdtempSync(join(tmpdir(),'nova-start-build-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  function write(path,contents) {
    mkdirSync(dirname(join(root,path)),{recursive:true});
    writeFileSync(join(root,path),contents);
  }
  for(const path of ['start.command','upstream.lock.json','scripts/project.mjs','scripts/build-record.mjs',
    'scripts/team-soak-lock.mjs','services/runtime/sources.mjs','services/bot/images/runtime-path.mjs']) {
    mkdirSync(dirname(join(root,path)),{recursive:true});
    copyFileSync(join(ROOT,path),join(root,path));
  }
  const {components}=JSON.parse(readFileSync(join(root,'upstream.lock.json')));
  for(const [id,name,dir] of [['harness','@deepseek-ai/dsh-root','engine/harness'],
    ['bot','ds-bot','engine/bot/ds-bot'],['siwc','sign-in-with-chatgpt','engine/siwc']]) {
    const pkg={name,version:components[id].version,scripts:{build:':'}};
    if(id==='siwc')pkg.workspaces=['packages/local'];
    write(join(dir,'package.json'),JSON.stringify(pkg));
    write(join(dir,'LICENSE'),'fixture');
  }
  write('engine/siwc/packages/local/package.json',JSON.stringify({name:'@siwc/local',version:'1.0.0',scripts:{build:':'}}));
  for(const path of BUILD_ARTIFACTS)write(path,'fixture artifact');
  if(process.platform==='darwin')write('output/bin/siwc-keychain','fixture helper');
  write('services/bot/web/build.mjs','');
  write('config/.env.daily','OPENNOVA_TTS_PROVIDER=doubao\n');
  write('fixture-pnpm.mjs',`
    import {appendFileSync} from 'node:fs';
    import {setTimeout as delay} from 'node:timers/promises';
    appendFileSync(process.env.BUILD_EVENTS,'build\\n');
    if(process.env.BUILD_DELAY)await delay(Number(process.env.BUILD_DELAY));
    if(process.env.BUILD_FAIL){console.error('fixture compiler failed');process.exitCode=7;}
  `);
  write('tools/voice/start.mjs',`
    import {appendFileSync} from 'node:fs';
    export {parseArgs} from ${JSON.stringify(new URL('../../tools/voice/start.mjs',import.meta.url).href)};
    if(process.argv[1]===import.meta.filename){
      const entry={args:process.argv.slice(2),tts:process.env.OPENNOVA_TTS_PROVIDER};
      appendFileSync(process.env.LAUNCH_EVENTS,JSON.stringify(entry)+'\\n');
    }
  `);
  const env={PATH:process.env.PATH,OPENNOVA_NODE:process.execPath,OPENNOVA_PYTHON:'/usr/bin/true',
    npm_execpath:join(root,'fixture-pnpm.mjs'),npm_config_cache:join(root,'npm-cache'),
    BUILD_EVENTS:join(root,'build-events'),LAUNCH_EVENTS:join(root,'launch-events')};
  const events=file=>existsSync(file)?readFileSync(file,'utf8').trimEnd().split('\n'):[];
  return {root,write,
    start:(args,overrides={})=>run(join(root,'start.command'),args,{env:{...env,...overrides},cwd:root,timeout:20000}),
    builds:()=>events(env.BUILD_EVENTS),launches:()=>events(env.LAUNCH_EVENTS).map(line=>JSON.parse(line))};
}

test('one-command launch builds once, skips a fresh build and rebuilds after a source edit',async t=>{
  const f=checkout(t);
  for(const state of ['missing','fresh','stale']){
    if(state==='stale')f.write('tools/changed-source.mjs','export const changed=true;');
    assert.equal(checkBuild(f.root).ready,state==='fresh');
    await f.start(textArgs);
    assert.equal(checkBuild(f.root).ready,true);
    assert.equal(f.builds().length,state==='stale'?2:1);
  }
  assert.deepEqual(f.launches(),Array(3).fill({args:textArgs,tts:'doubao'}));
});

test('a failed automatic build never launches and a second invocation can recover',async t=>{
  const f=checkout(t);
  recordBuild(f.root);
  f.write('tools/changed-source.mjs','export const changed=true;');
  await assert.rejects(f.start(textArgs,{BUILD_FAIL:'1'}),error=>{
    assert.match(error.stderr,/fixture compiler failed/);
    return true;
  });
  assert.equal(checkBuild(f.root).ready,false);
  assert.deepEqual(f.launches(),[]);
  await f.start(textArgs);
  assert.equal(checkBuild(f.root).ready,true);
  assert.equal(f.builds().length,2);
  assert.deepEqual(f.launches(),[{args:textArgs,tts:'doubao'}]);
});

test('help and device listing reach their entry points without building',async t=>{
  const f=checkout(t);
  await assert.rejects(f.start(['--device']),error=>error.stderr.includes('--device'));
  for(const arg of ['--help','--list-devices'])await f.start([arg]);
  assert.equal(checkBuild(f.root).ready,false);
  assert.deepEqual(f.builds(),[]);
  assert.deepEqual(f.launches().map(entry=>entry.args),[['--help'],['--list-devices']]);
});

test('simultaneous one-command launches share a single build and both continue',async t=>{
  const f=checkout(t);
  const results=await Promise.allSettled([f.start(textArgs,{BUILD_DELAY:'700'}),f.start(['--no-voice'],{BUILD_DELAY:'700'})]);
  for(const result of results)if(result.status==='rejected')throw result.reason;
  assert.equal(f.builds().length,1);
  assert.equal(checkBuild(f.root).ready,true);
  assert.deepEqual(f.launches().map(entry=>entry.args).sort((a,b)=>a.length-b.length),[['--no-voice'],textArgs]);
});
