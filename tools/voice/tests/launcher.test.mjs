import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {createServer as httpServer} from 'node:http';
import {spawn, spawnSync} from 'node:child_process';
import {launch, parseArgs, probeTts, ttsProvider} from '../start.mjs';

async function freePort() {
  const server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}

// Real local child processes stand in for cloud-backed Bot, SSH and microphone input.
// This checks service reuse, ownership and argv without opening devices or using credentials.
async function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'opennova launch '));
  const home=join(root,'state');
  for(const dir of ['tools/bot','tools/voice','bin','state'])mkdirSync(join(root,dir),{recursive:true});
  const botPort=await freePort(),ttsPort=await freePort();
  const env={...process.env,OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(botPort),
    OPENNOVA_BOT_WEB_PORT:String(await freePort()),FIXTURE_ROOT:root,FIXTURE_TTS_PORT:String(ttsPort),
    PATH:join(root,'bin')+':'+process.env.PATH};
  const script=(path,code)=>writeFileSync(join(root,path),`#!${process.execPath}\n${code}`,{mode:0o700});
  const serverCode=`
    const fs=require('node:fs'),http=require('node:http'),root=process.env.FIXTURE_ROOT;
    const tts=process.argv.includes('-N');
    fs.appendFileSync(root+'/starts', (tts?'tts':'bot')+'\\n');
    if(!tts)fs.writeFileSync(root+'/bot-args',JSON.stringify(process.argv.slice(2)));
    fs.appendFileSync(root+'/pids', process.pid+'\\n');
    if(!tts)fs.writeFileSync(root+'/state/client.token','fixture-token');
    const server=http.createServer((req,res)=>{
      res.setHeader('Content-Type','application/json');
      if(!tts && req.headers.authorization!=='Bearer fixture-token'){res.writeHead(401);return res.end('{}');}
      if(!tts){
        fs.appendFileSync(root+'/requests',req.url+'\\n');
        if(req.url==='/desktop/status')return res.end(JSON.stringify({paired:true,connected:process.env.EXTENSION_OFF!=='1'||fs.existsSync(root+'/browser-ready')}));
        if(req.url==='/desktop/open'){fs.appendFileSync(root+'/window-ensures','ensure\\n');return res.end(JSON.stringify({status:'completed',windows:{workWindowId:1,chatWindowId:2}}));}
        if(req.url==='/snapshot')return res.end(JSON.stringify({desktop:{voice:{connected:process.env.EXISTING_VOICE==='1'}}}));
      }
      const data=tts?{paths:{'/v1/audio/speech':{post:{}}}}:
        {ready:true,runtimeId:'fixture-boot',workspace:root,model:'opennova-chatgpt/gpt-6.1-sol'};
      res.end(JSON.stringify(data));
    });
    server.listen(Number(tts?process.env.FIXTURE_TTS_PORT:process.env.OPENNOVA_BOT_PORT),'127.0.0.1');
  `;
  script('tools/bot/run.command',serverCode);
  script('bin/ssh',`
    const fs0=require('node:fs');
    if(!process.argv.includes('-N')){
      fs0.appendFileSync(process.env.FIXTURE_ROOT+'/remote','started\\n');
      process.stdin.resume();process.stdin.on('end',()=>process.exit(Number(process.env.SSH_FAIL||0)));
    }else{${serverCode}}
  `);
  script('tools/voice/run-continuous.command',`
    const fs=require('node:fs'),root=process.env.FIXTURE_ROOT;
    fs.appendFileSync(root+'/voice-starts','start\\n');
    fs.writeFileSync(root+'/voice.json',JSON.stringify({args:process.argv.slice(2),proxy:process.env.OPENNOVA_PROXY}));
    if(process.env.WAIT_VOICE){
      process.on('SIGINT',()=>{fs.writeFileSync(root+'/voice-closed','yes');process.exit(0);});
      setInterval(()=>{},1000);
    }else process.exit(Number(process.env.VOICE_EXIT||0));
  `);
  t.after(()=>{
    if(existsSync(join(root,'pids')))for(const pid of readFileSync(join(root,'pids'),'utf8').trim().split('\n')){
      try{process.kill(Number(pid),'SIGTERM');}catch{}
    }
    rmSync(root,{recursive:true,force:true});
  });
  return {root,env,options:{ttsPort,studioHost:'studio-test',studioTtsDir:'/tmp/Studio project/tts'},
    runtime:{root,env,waitMs:3000,pollMs:30,log:()=>{}}};
}

test('cold launch starts dependencies, forwards devices and keeps Bot for the next launch',async t=>{
  const f=await fixture(t);
  const options={...f.options,device:'Air 麦克风',outputDevice:'耳机 $(touch NEVER)',proxy:'http://127.0.0.1:7897'};
  assert.equal(await launch(options,f.runtime),0);
  const voice=JSON.parse(readFileSync(join(f.root,'voice.json'),'utf8'));
  assert.deepEqual(voice.args,['--bot','--tts-url',`http://127.0.0.1:${f.options.ttsPort}`,
    '--device','Air 麦克风','--output-device','耳机 $(touch NEVER)']);
  assert.equal(voice.proxy,'http://127.0.0.1:7897');
  assert.equal(await probeTts(`http://127.0.0.1:${f.options.ttsPort}`),false,'owned tunnel must close');
  assert.equal(await launch(options,f.runtime),0);
  assert.equal(readFileSync(join(f.root,'starts'),'utf8').split('\n').filter(x=>x==='bot').length,1);
});

test('cloud TTS skips Studio and an occupied local TTS port, and forwards voice selection',async t=>{
  const f=await fixture(t);f.env.SSH_FAIL='255';
  const server=httpServer((req,res)=>res.end('{}'));
  await new Promise(resolve=>server.listen(f.options.ttsPort,'127.0.0.1',resolve));
  t.after(()=>server.close());
  assert.equal(await launch({...f.options,ttsProvider:'cloud',ttsVoice:'female-test',check:true},f.runtime),0);
  assert.equal(existsSync(join(f.root,'remote')),false);
  assert.equal(readFileSync(join(f.root,'starts'),'utf8'),'bot\n');
  const args=JSON.parse(readFileSync(join(f.root,'voice.json'),'utf8')).args;
  assert.deepEqual(args,['--bot','--tts-provider','doubao','--tts-voice','female-test','--check']);
});

test('TTS provider precedence is CLI then environment then config, preserving the Studio default',async t=>{
  const f=await fixture(t);
  assert.equal(ttsProvider({}, {}, f.root),'studio');
  mkdirSync(join(f.root,'config'));
  writeFileSync(join(f.root,'config/voice.local.json'),JSON.stringify({tts:{provider:'doubao'}}));
  assert.equal(ttsProvider({}, {}, f.root),'doubao');
  assert.equal(ttsProvider({}, {OPENNOVA_TTS_PROVIDER:'studio'}, f.root),'studio');
  assert.equal(ttsProvider({ttsProvider:'cloud'}, {OPENNOVA_TTS_PROVIDER:'studio'}, f.root),'doubao');
  assert.throws(()=>parseArgs(['--tts-provider','invalid']),/TTS/);
});

test('existing TTS connection is reused and survives client exit',async t=>{
  const f=await fixture(t);
  const server=httpServer((req,res)=>res.end(JSON.stringify({paths:{'/v1/audio/speech':{post:{}}}})));
  await new Promise(resolve=>server.listen(f.options.ttsPort,'127.0.0.1',resolve));
  t.after(()=>server.close());
  await launch(f.options,f.runtime);
  assert.equal(existsSync(join(f.root,'remote')),false);
  assert.equal(await probeTts(`http://127.0.0.1:${f.options.ttsPort}`),true);
});

test('an unrelated occupied TTS port fails before SSH or microphone launch',async t=>{
  const f=await fixture(t);
  const server=httpServer((req,res)=>res.end('{}'));
  await new Promise(resolve=>server.listen(f.options.ttsPort,'127.0.0.1',resolve));
  t.after(()=>server.close());
  await assert.rejects(launch(f.options,f.runtime),/端口.*占用/);
  assert.equal(existsSync(join(f.root,'remote')),false);
  assert.equal(existsSync(join(f.root,'voice.json')),false);
});

test('SSH failure stops before voice; list-devices skips every service',async t=>{
  const f=await fixture(t);f.env.SSH_FAIL='255';
  await assert.rejects(launch(f.options,f.runtime),/SSH|Studio/);
  assert.equal(existsSync(join(f.root,'voice.json')),false);
  await launch({...f.options,listDevices:true},f.runtime);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root,'voice.json'),'utf8')).args,['--list-devices']);
});

test('check mode passes --check and preserves failure exit status',async t=>{
  const f=await fixture(t);f.env.VOICE_EXIT='7';
  assert.equal(await launch({...f.options,check:true},f.runtime),7);
  assert.ok(JSON.parse(readFileSync(join(f.root,'voice.json'),'utf8')).args.includes('--check'));
  assert.equal(await probeTts(`http://127.0.0.1:${f.options.ttsPort}`),false);
});

test('cancellation lets voice clean up, closes owned tunnel and releases concurrent launch lock',async t=>{
  const f=await fixture(t);f.env.WAIT_VOICE='1';
  const controller=new AbortController();
  const running=launch(f.options,{...f.runtime,signal:controller.signal});
  const cancelled=assert.rejects(running,/test_cancel/);
  for(let i=0;i<100&&!existsSync(join(f.root,'voice.json'));i++)await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(existsSync(join(f.root,'voice.json')),true);
  await assert.rejects(launch(f.options,f.runtime),/已有.*运行/);
  controller.abort(Error('test_cancel'));
  await cancelled;
  assert.equal(existsSync(join(f.root,'voice-closed')),true,'voice must receive a graceful interrupt');
  assert.equal(await probeTts(`http://127.0.0.1:${f.options.ttsPort}`),false);
  delete f.env.WAIT_VOICE;
  assert.equal(await launch(f.options,f.runtime),0,'lock must be released after cancellation');
});

test('interrupt reaches the Python child of real uv',async t=>{
  const f=await fixture(t);
  writeFileSync(join(f.root,'tools/voice/interrupt_probe.py'),`
import os, signal, time
from pathlib import Path
root = Path(os.environ['FIXTURE_ROOT'])
with (root / 'pids').open('a') as pids: pids.write(str(os.getpid()) + '\\n')
def stopped(*_):
    (root / 'voice-closed').write_text('yes')
    raise SystemExit(0)
signal.signal(signal.SIGINT, stopped)
(root / 'voice.json').write_text('ready')
while True: time.sleep(0.1)
`);
  writeFileSync(join(f.root,'tools/voice/run-continuous.command'),
    '#!/bin/sh\nexec uv run --offline /usr/bin/python3 "$(dirname "$0")/interrupt_probe.py"\n',{mode:0o700});
  const controller=new AbortController();
  const cancelled=assert.rejects(launch(f.options,{...f.runtime,signal:controller.signal}),/test_cancel/);
  for(let i=0;i<125&&!existsSync(join(f.root,'voice.json'));i++)await new Promise(resolve=>setTimeout(resolve,40));
  controller.abort(Error('test_cancel'));
  await cancelled;
  assert.equal(existsSync(join(f.root,'voice-closed')),true,'uv must deliver SIGINT to Python cleanup');
});

test('an old incomplete lock is recoverable while a fresh incomplete lock remains protected',async t=>{
  const f=await fixture(t),lock=join(f.env.OPENNOVA_BOT_HOME,'voice-launch.lock');
  mkdirSync(lock);writeFileSync(join(lock,'pid'),'');
  await assert.rejects(launch(f.options,f.runtime),/已有.*运行/);
  const old=new Date(Date.now()-180000);utimesSync(lock,old,old);
  assert.equal(await launch(f.options,f.runtime),0);
});

test('Studio bootstrap starts the installed service once and recovers an old empty lock',async t=>{
  const reservation=createServer();
  try {await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(8000,'127.0.0.1',resolve);});}
  catch {t.skip('Local port 8000 is occupied; do not touch its existing service.');return;}
  await new Promise(resolve=>reservation.close(resolve));
  const f=await fixture(t),ttsDir=join(f.root,'services/tts'),lock=join(f.root,'output/tts/launcher.lock');
  mkdirSync(ttsDir,{recursive:true});mkdirSync(lock,{recursive:true});
  writeFileSync(join(lock,'pid'),'');const old=new Date(Date.now()-180000);utimesSync(lock,old,old);
  writeFileSync(join(ttsDir,'server.cjs'),`
    const fs=require('node:fs');fs.appendFileSync(process.env.FIXTURE_ROOT+'/pids',process.pid+'\\n');
    fs.appendFileSync(process.env.FIXTURE_ROOT+'/remote-starts','start\\n');
    require('node:http').createServer((req,res)=>res.end(JSON.stringify({paths:{'/v1/audio/speech':{post:{}}}}))).listen(8000,'127.0.0.1');
  `);
  writeFileSync(join(ttsDir,'serve.sh'),`#!/bin/sh\nexec '${process.execPath}' server.cjs\n`);
  const bootstrap=()=>new Promise((resolve,reject)=>{
    const child=spawn('/bin/sh',[new URL('../ensure-studio-tts.sh',import.meta.url).pathname,ttsDir],
      {env:f.env,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
    child.on('error',reject);child.on('exit',code=>{if(code)reject(Error(output));else resolve(output);});
  });
  await bootstrap();assert.equal(await probeTts('http://127.0.0.1:8000'),true);
  await bootstrap();assert.equal(readFileSync(join(f.root,'remote-starts'),'utf8'),'start\n');
  assert.equal(existsSync(lock),false);
});

test('CLI validates mode and parameters before causing side effects',()=>{
  const args=parseArgs(['--device','MacBook Air麦克风','--output-device','SRS-XB100','--check']);
  assert.equal(args.device,'MacBook Air麦克风');assert.equal(args.check,true);
  for(const argv of [['--web'],['--device'],['--tts-port','0'],['--studio-host','-evil']])
    assert.throws(()=>parseArgs(argv));
});

test('root command works outside the project and help needs no services',()=>{
  const result=spawnSync(new URL('../../../start.command',import.meta.url).pathname,['--help'],
    {cwd:tmpdir(),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/--device/);assert.match(result.stdout,/--check/);
});


test('UI startup opens windows before TTS and voice, enables desktop on a cold Bot',async t=>{
 const f=await fixture(t);f.env.SSH_FAIL='255';const logs=[];
 await assert.rejects(launch({...f.options,ui:true},{...f.runtime,log:s=>logs.push(s)}),/Studio/);
 assert.deepEqual(JSON.parse(readFileSync(join(f.root,'bot-args'),'utf8')),['--desktop']);
 assert.equal(readFileSync(join(f.root,'window-ensures'),'utf8'),'ensure\n');
 assert.equal(existsSync(join(f.root,'voice.json')),false);
 assert.ok(logs.some(x=>x.includes('文字')&&x.includes('http://127.0.0.1:')));
 assert.equal(existsSync(join(f.env.OPENNOVA_BOT_HOME,'voice-launch.lock')),false);
});
test('UI reconnect reuses an active launcher without another microphone or SSH connection',async t=>{
 const f=await fixture(t);f.env.WAIT_VOICE='1';const c=new AbortController();
 const first=assert.rejects(launch({...f.options,ui:true},{...f.runtime,signal:c.signal}),/test_cancel/);
 try{
  for(let i=0;i<100&&!existsSync(join(f.root,'voice.json'));i++)await new Promise(r=>setTimeout(r,40));
  assert.equal(await launch({...f.options,ui:true},f.runtime),0);
  assert.equal(readFileSync(join(f.root,'voice-starts'),'utf8'),'start\n');
  assert.equal(readFileSync(join(f.root,'remote'),'utf8'),'started\n');
  assert.equal(readFileSync(join(f.root,'window-ensures'),'utf8'),'ensure\nensure\n');
  assert.equal(existsSync(join(f.env.OPENNOVA_BOT_HOME,'voice-launch.lock')),true);
 }finally{c.abort(Error('test_cancel'));await first;}
});
test('a voice client started directly is reused without taking its microphone ownership',async t=>{
 const f=await fixture(t);f.env.EXISTING_VOICE='1';
 assert.equal(await launch({...f.options,ui:true},f.runtime),0);
 assert.equal(existsSync(join(f.root,'voice.json')),false);
 assert.equal(existsSync(join(f.root,'remote')),false);
});
test('missing extension keeps text and voice, opens fallback once per Bot boot without credentials',async t=>{
 const f=await fixture(t);f.env.EXTENSION_OFF='1';const opened=[],logs=[];
 const runtime={...f.runtime,uiWaitMs:10,openBrowser:async url=>opened.push(url),log:s=>logs.push(s)};
 assert.equal(await launch({...f.options,ui:true,ttsProvider:'doubao'},runtime),0);
 assert.equal(await launch({...f.options,ui:true,ttsProvider:'doubao'},runtime),0);
 assert.equal(opened.filter(Boolean).length,1);
 assert.equal(opened.filter(Boolean)[0],`http://127.0.0.1:${f.env.OPENNOVA_BOT_PORT}/`);
 assert.equal(existsSync(join(f.root,'window-ensures')),false);
 assert.ok(logs.some(x=>x.includes('扩展')));
 assert.equal(existsSync(join(f.root,'voice.json')),true);
});
test('UI launch reconnects the configured paired browser before opening windows and voice',async t=>{
 const f=await fixture(t);f.env.EXTENSION_OFF='1';
 f.env.OPENNOVA_BROWSER_EXECUTABLE=join(f.root,'bin/paired-chrome');
 f.env.OPENNOVA_BROWSER_USER_DATA_DIR=join(f.root,'paired profile');
 writeFileSync(f.env.OPENNOVA_BROWSER_EXECUTABLE,`#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(f.root,'browser-args'))},JSON.stringify(process.argv.slice(2)));fs.writeFileSync(${JSON.stringify(join(f.root,'browser-ready'))},'ready');`,{mode:0o700});
 assert.equal(await launch({...f.options,ui:true,ttsProvider:'doubao'},f.runtime),0);
 const args=JSON.parse(readFileSync(join(f.root,'browser-args'),'utf8'));
 assert.ok(args.includes('--user-data-dir='+join(f.root,'paired profile')));
 assert.ok(args.includes('--load-extension='+join(f.root,'extensions/browser')));
 assert.equal(readFileSync(join(f.root,'window-ensures'),'utf8'),'ensure\n');
 assert.equal(existsSync(join(f.env.OPENNOVA_BOT_HOME,'ui-fallback.json')),false);
 assert.equal(existsSync(join(f.root,'voice.json')),true);
});
test('UI preflight and list-devices never open windows; explicit no-ui overrides UI',async t=>{
 const f=await fixture(t);const openBrowser=async()=>assert.fail('must not open a browser');
 assert.equal(parseArgs(['--ui','--no-ui']).ui,false);
 await launch({...f.options,ui:true,check:true},{...f.runtime,openBrowser});
 assert.equal(existsSync(join(f.root,'window-ensures')),false);
 await launch({...f.options,ui:true,listDevices:true},{...f.runtime,openBrowser});
 assert.equal(existsSync(join(f.root,'window-ensures')),false);
});
test('microphone startup failure keeps the text service and reports recovery URL',async t=>{
 const f=await fixture(t);f.env.VOICE_EXIT='7';const logs=[];
 assert.equal(await launch({...f.options,ui:true,ttsProvider:'doubao'},{...f.runtime,log:s=>logs.push(s)}),7);
 assert.ok(logs.some(s=>s.includes('文字对话仍可使用')&&s.includes(f.env.OPENNOVA_BOT_PORT)));
 assert.equal(existsSync(join(f.env.OPENNOVA_BOT_HOME,'voice-launch.lock')),false);
 f.env.VOICE_EXIT='0';await launch({...f.options,ui:true,ttsProvider:'doubao'},f.runtime);
 assert.equal(readFileSync(join(f.root,'starts'),'utf8'),'bot\n');
});
