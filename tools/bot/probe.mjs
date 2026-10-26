/** Explicit live probe: uses only disposable files under output/bot and synthetic memories. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {api,ask} from './client.mjs';
import {botSettings,ROOT} from '../../services/bot/settings.mjs';
const report={startedAt:new Date().toISOString(),checks:[],success:false};
const b=botSettings(),marker='样本'+randomUUID().slice(0,8),first=marker+'的测试饮品是柠檬水',second=marker+'的测试饮品是白开水';
async function appliedAfter(text,operation) {
  const old=new Set((await api('/operations')).map(r=>r.id));
  const reply=await ask(text);report.checks.push({name:operation+' model tool',text:reply.text,elapsed_ms:reply.elapsed_ms});
  const pending=(await api('/operations')).filter(r=>!old.has(r.id)&&r.status==='applied'&&r.executionMode==='direct'&&r.operation===operation);
  assert.equal(pending.length,1,'model must complete exactly one direct operation');return pending[0];
}
try {
  report.health=await api('/health');
  const file='output/bot/probe-direct-'+marker+'.md';
  const edit=await appliedAfter(`请新建 ${file}，内容为“直接执行验证通过。”。请立即保存。`,'file');
  assert.equal(readFileSync(join(b.workspace,file),'utf8'),edit.content);
  report.checks.push({name:'direct file write',ok:true});
  const memory=await appliedAfter(`请记住一条合成测试偏好：${first}。请保留样本编号，调用 remember 直接保存。`,'memory');
  const view=await api('/memory');assert.ok(view.entries.some(e=>e.text.includes(marker)&&e.text.includes('柠檬水')));
  report.checks.push({name:'upstream memory saved directly',ok:true,entry:memory.args.text});
  const corrected=await appliedAfter(`把已保存的测试偏好“${memory.args.text}”更正为“${second}”。请调用 remember 的 replace 直接更正。`,'memory');
  const recall=await ask(`请调用 recall 查询 ${marker} 当前的测试饮品，用一句话回答。`);
  assert.ok(recall.text.includes('白开水'));report.checks.push({name:'corrected memory',ok:true,text:recall.text});
  const forgotten=await appliedAfter(`请忘掉 ${marker} 的测试饮品这条记忆，仅匹配 ${marker}，调用 forget 直接删除。`,'memory');
  const after=await api('/memory');assert.ok(!after.entries.some(e=>e.text.includes(marker)));
  report.checks.push({name:'upstream memory removed',ok:true});
  const taskReply=await ask('请用 start_test_task 启动一个持续 120 秒、名为“重连验证”的计时任务，并告诉我编号。');
  const tasks=await api('/tasks');assert.ok(tasks.some(r=>r.status==='running'));
  report.checks.push({name:'independent controlled task',ok:true,text:taskReply.text,tasks});
  report.success=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{
  const dir=join(ROOT,'output/bot/verification');mkdirSync(dir,{recursive:true});
  const path=join(dir,'direct-live-probe.json');writeFileSync(path,JSON.stringify(report,null,2));
  console.log(JSON.stringify({success:report.success,checks:report.checks.map(c=>({name:c.name,ok:c.ok??true})),error:report.error,report:path},null,2));
}
