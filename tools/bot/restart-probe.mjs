/** Two-phase, explicit live probe. Run --before, restart the host, then --after. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {api,ask} from './client.mjs';
import {ROOT} from '../../services/bot/settings.mjs';
const dir=join(ROOT,'output/bot/verification'),file=join(dir,'restart-probe.json');mkdirSync(dir,{recursive:true});
if(process.argv.includes('--before')){
 const health=await api('/health');
 const reply=await ask('本次会话测试暗号是蓝海314。不记入长期记忆，只回复已知晓。');
 const taskReply=await ask('请启动一个 120 秒的测试任务，名称为重启接续验证，并告诉我编号。');
 const task=(await api('/tasks')).find(r=>r.label.includes('重启接续')&&r.status==='running');assert.ok(task);
 writeFileSync(file,JSON.stringify({health,reply,taskReply,task},null,2));console.log('重启前状态已保存；请重启宿主后运行 --after。');
}else if(process.argv.includes('--after')){
 const saved=JSON.parse(readFileSync(file,'utf8')),health=await api('/health');
 assert.equal(health.botId,saved.health.botId);
 const prior=await api('/result',{id:saved.reply.id});assert.equal(prior.status,'completed');assert.equal(prior.text,saved.reply.text);
 const task=await api('/task',{id:saved.task.id});assert.equal(task.dueAt,saved.task.dueAt);assert.ok(['running','completed'].includes(task.status));
 const recall=await ask('刚才我告诉你的本次会话测试暗号是什么？');assert.ok(recall.text.includes('蓝海314'));
 const id=randomUUID();await api('/ask',{id,text:'请用一句话解释测试取消。'});await api('/cancel',{id});
 assert.equal((await api('/result',{id})).status,'cancelled');
 assert.notEqual((await api('/task',{id:saved.task.id})).status,'cancelled');
 const cancellation=await api('/cancel-task',{id:saved.task.id});assert.ok(['cancelled','completed'].includes(cancellation.status));
 writeFileSync(file,JSON.stringify({...saved,success:true,after:{health,task,recall,foregroundCancelled:true,independentTaskUnaffected:true,cancellation}},null,2));
 console.log('重启后 Bot 身份、会话暗号、既有结果、任务截止时间和前台取消隔离验证通过。');
}else throw Error('usage: restart-probe.mjs --before | --after');
