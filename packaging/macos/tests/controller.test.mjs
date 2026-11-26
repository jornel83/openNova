import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtempSync,readFileSync,rmSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const runner=fileURLToPath(new URL('../runner.mjs',import.meta.url));
function controller(t,data){
  const process=spawn(globalThis.process.execPath,[runner],{env:{...globalThis.process.env,OPENNOVA_APP_DATA:data},stdio:['pipe','pipe','pipe']});
  const events=[],waiters=[];let stderr='';
  const lines=createInterface({input:process.stdout});
  lines.on('line',line=>{const event=JSON.parse(line);events.push(event);for(const waiter of [...waiters])if(waiter.predicate(event)){clearTimeout(waiter.timer);waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(event);}});
  process.stderr.on('data',chunk=>stderr+=chunk);
  const exited=new Promise(resolve=>process.once('exit',(code,signal)=>resolve({code,signal})));
  t.after(()=>{process.kill('SIGKILL');lines.close();});
  return {process,events,exited,stderr:()=>stderr,send:message=>process.stdin.write(JSON.stringify(message)+'\n'),wait(predicate){
    const existing=events.find(predicate);if(existing)return Promise.resolve(existing);
    return new Promise((resolve,reject)=>{const waiter={predicate,resolve,timer:setTimeout(()=>reject(Error('controller event timeout: '+JSON.stringify(events))),5000)};waiters.push(waiter);});
  }};
}
test('headless controller initializes isolated state, handles settings and exits cleanly',async t=>{
  const data=mkdtempSync(join(tmpdir(),'opennova-controller-test-'));
  t.after(()=>rmSync(data,{recursive:true,force:true}));
  const c=controller(t,data);
  await c.wait(event=>event.type==='status'&&event.state==='stopped');
  assert.ok(existsSync(join(data,'application.lock/owner.json')));
  c.send({action:'save-settings',asrKey:'fake-controller-asr-only',ttsKey:'fake-controller-tts-only',proxy:''});
  await c.wait(event=>event.type==='settings'&&event.hasAsrKey===true);
  c.send({action:'status'});
  c.send({action:'quit'});
  assert.deepEqual(await c.exited,{code:0,signal:null});
  assert.equal(existsSync(join(data,'application.lock')),false);
  assert.equal(JSON.parse(readFileSync(join(data,'config/secrets.local.json'))).doubao.api_key,'fake-controller-asr-only');
  assert.ok(!JSON.stringify(c.events).includes('fake-controller'));
  assert.ok(!c.stderr().includes('fake-controller'));
});
test('a duplicate controller leaves the original instance and lock intact',async t=>{
  const data=mkdtempSync(join(tmpdir(),'opennova-controller-lock-'));
  t.after(()=>rmSync(data,{recursive:true,force:true}));
  const first=controller(t,data);
  await first.wait(event=>event.type==='status');
  const second=controller(t,data);
  await second.wait(event=>event.type==='error');
  assert.deepEqual(await second.exited,{code:1,signal:null});
  assert.equal(JSON.parse(readFileSync(join(data,'application.lock/owner.json'))).pid,first.process.pid);
  first.send({action:'quit'});assert.equal((await first.exited).code,0);
});
test('closing the UI pipe performs cleanup without launching network services',async t=>{
  const data=mkdtempSync(join(tmpdir(),'opennova-controller-eof-'));
  t.after(()=>rmSync(data,{recursive:true,force:true}));
  const c=controller(t,data);await c.wait(event=>event.type==='status');
  c.process.stdin.end();assert.equal((await c.exited).code,0);
  assert.equal(existsSync(join(data,'application.lock')),false);
});

test('missing or corrupt lock ownership receives recovery guidance without removing the lock',async t=>{
  for(const raw of [null,'broken JSON',JSON.stringify({pid:0})]){
    const data=mkdtempSync(join(tmpdir(),'opennova-controller-bad-lock-'));
    t.after(()=>rmSync(data,{recursive:true,force:true}));
    const lock=join(data,'application.lock');mkdirSync(lock);
    if(raw!==null)writeFileSync(join(lock,'owner.json'),raw);
    const c=controller(t,data),event=await c.wait(event=>event.type==='error');
    assert.match(event.text,/未自动删除/);assert.ok(event.text.includes(lock));
    assert.equal((await c.exited).code,1);assert.equal(existsSync(lock),true);
    if(raw!==null)assert.equal(readFileSync(join(lock,'owner.json'),'utf8'),raw);
  }
});
