/** Live model probe: modifies only a unique disposable directory under output/bot. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {api,ask} from './client.mjs';
import {ROOT} from '../../services/bot/settings.mjs';

const directory='output/bot/project-probe-'+randomUUID().slice(0,8),path=join(ROOT,directory);
mkdirSync(path,{recursive:true});
writeFileSync(join(path,'add.mjs'),'export const add = (a, b) => a - b;\n');
writeFileSync(join(path,'add.test.mjs'),"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {add} from './add.mjs';\ntest('adds two numbers',()=>assert.equal(add(1,2),3));\n");
const report={directory,startedAt:new Date().toISOString(),checks:[],success:false};
try{
 report.health=await api('/health');assert.equal(report.health.workspace,ROOT);assert.equal(report.health.permission,'danger-full-access');
 const reply=await ask(`做一次开发验收，只允许修改 ${directory}/add.mjs 和 ${directory}/result.md。先用 glob 浏览 services/bot 的 .mjs 文件，用 grep 找到 services/bot/settings.mjs 的 workspace 定义，然后 read 读取该文件和 ${directory} 内两个文件。用 bash 执行 node --test ${directory}/add.test.mjs，观察失败；再用 edit 修正 add.mjs 的减法错误，再运行同一测试通过。最后用 write 新建 ${directory}/result.md，记录实际修复与测试结果。不要修改测试文件或其他代码，无需确认。`);
 report.reply=reply;
 const rows=(await api('/operations')).filter(r=>r.requestId===reply.id);report.operations=rows;
 for(const name of ['glob','grep','read','edit','write','bash'])assert.ok(rows.some(r=>r.tool===name),'missing '+name);
 assert.ok(rows.some(r=>r.operation==='shell'&&r.exitCode!==0&&r.status==='failed'));
 assert.ok(rows.some(r=>r.operation==='shell'&&r.exitCode===0&&r.status==='completed'));
 assert.match(readFileSync(join(path,'add.mjs'),'utf8'),/a\s*\+\s*b/);assert.ok(existsSync(join(path,'result.md')));
 report.checks.push('browse/search/read/edit/write and failing→passing real test');
 const id=randomUUID(),pidFile=join(path,'cancel.pid');
 writeFileSync(join(path,'cancel.mjs'),"import {writeFileSync} from 'node:fs';\nwriteFileSync(new URL('./cancel.pid',import.meta.url),String(process.pid));\nconsole.log('started');\nsetTimeout(()=>writeFileSync(new URL('./cancel-leak',import.meta.url),'unexpected'),15000);\n");
 await api('/ask',{id,text:`仅测试停止功能：请使用 bash 执行 node ${directory}/cancel.mjs，timeoutMs 设为 30000。等待命令结束，不要启动后台任务，也不要修改文件。`,source:'text'});
 for(let i=0;i<900&&!existsSync(pidFile);i++){
  const r=await api('/result',{id});if(!['queued','running'].includes(r.status))throw Error('cancel command did not start: '+r.status);
  await delay(100);
 }
 assert.ok(existsSync(pidFile),'cancel process started');
 report.cancel=await api('/cancel',{id});assert.equal(report.cancel.status,'cancelled');
 const pid=Number(readFileSync(pidFile,'utf8'));
 let alive=true;for(let i=0;i<40&&alive;i++){try{process.kill(pid,0);}catch{alive=false;}if(alive)await delay(100);}
 assert.equal(alive,false,'cancelled child exited');assert.equal(existsSync(join(path,'cancel-leak')),false);
 report.checks.push('live foreground cancellation terminates the real command');
 report.success=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{
 const output=join(ROOT,'output/bot/verification/project-live-probe.json');mkdirSync(join(ROOT,'output/bot/verification'),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2));
 console.log(JSON.stringify({success:report.success,checks:report.checks,error:report.error,report:output},null,2));
}
