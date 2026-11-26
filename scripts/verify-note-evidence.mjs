/** Manual /ask acceptance on synthetic material, using a disposable Bot and the existing authorization. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,appendFileSync,rmSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ROOT,requireBuiltHarness} from '../services/runtime/sources.mjs';
import {botSettings} from '../services/bot/settings.mjs';
import {runtimePatch} from '../services/bot/configuration.mjs';
import {loadSettings} from '../services/agent/settings.mjs';

export const name='synthetic-note-check',inject=['tools'];
export function apply(ctx,config){
  const allowed=new Set(['document_read','research_note']);
  ctx.tools.guard(exec=>!allowed.has(exec.name)?'Synthetic materials only.':undefined);
  ctx.on('tools/execute',async(exec,next)=>{const result=await next();appendFileSync(config.trace,JSON.stringify({tool:exec.name,action:exec.arguments?.action,ok:!result.isError})+'\n');return result;},{prepend:true});
  ctx.on('system-prompt/assemble',async(_args,_context,next)=>{const prompt=await next();return {...prompt,tools:prompt.tools.filter(t=>allowed.has(t.name))};});
}
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function sample(line){
  const page=n=>`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 840] /Resources << /Font << /F1 7 0 R >> >> /Contents ${n} 0 R >>`;
  const body=t=>{const b=`BT /F1 16 Tf 30 700 Td (${t}) Tj ET`;return `<< /Length ${b.length} >>\nstream\n${b}\nendstream`;};
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>',page(4),body('Draft only. See final result on the next page.'),page(6),body(line),'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf='%PDF-1.4\n';const offsets=[];
  for(const [i,obj] of objects.entries()){offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
  const xref=pdf.length;return Buffer.from(pdf+`xref\n0 8\n0000000000 65535 f \n`+offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
async function run(){
  const sources=requireBuiltHarness(),home=realpathSync(mkdtempSync(join(tmpdir(),'nova-note-e2e-'))),workspace=join(home,'workspace');
  const token=randomUUID(),address=await port();let web=await port();while(web===address)web=await port();
  const config={...botSettings({OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(address),OPENNOVA_BOT_WEB_PORT:String(web)}),workspace};
  const dir=join(ROOT,'output','verification','a2-note-evidence',randomUUID());mkdirSync(dir,{recursive:true});mkdirSync(workspace);
  const line='Accepted units: '+(1000+Math.floor(Math.random()*8000))+'.',pdf=sample(line),sha=createHash('sha256').update(pdf).digest('hex');
  writeFileSync(join(workspace,'sample.pdf'),pdf);writeFileSync(config.tokenPath,token,{mode:0o600});
  const patch=runtimePatch({bot:config,agent:{harnessRoot:sources.harnessRoot},desktop:false}),plugins=patch.find(x=>x.insert).insert;
  const trace=join(dir,'calls.jsonl');writeFileSync(trace,'');
  plugins.splice(plugins.findIndex(p=>p.id==='opennova-bot'),0,{id:name,name:import.meta.filename,config:{trace}});const patchPath=join(home,'patch.json');writeFileSync(patchPath,JSON.stringify(patch));
  const api=async(path,body={})=>{const r=await fetch('http://127.0.0.1:'+address+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});assert.ok(r.ok);return r.json();};
  let child;const report={sha,line,steps:[]};
  async function wait(fn,ms){const end=Date.now()+ms;while(Date.now()<end){if(child.exitCode!==null||child.signalCode)throw Error('host_exited');const value=await fn();if(value)return value;await delay(250);}throw Error('probe_deadline');}
  async function start(){
    child=spawn(process.execPath,[join(sources.harnessRoot,'apps/cli/lib/bin.js'),'--profile','web','--patch',patchPath,'--host','127.0.0.1','--port',String(web),'--no-open'],{cwd:workspace,stdio:'ignore',env:{PATH:dirname(process.execPath)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',HOME:process.env.HOME,USER:process.env.USER,LANG:'en_US.UTF-8',DSH_HOME:join(home,'harness'),OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PLUGIN:sources.botRoot,OPENNOVA_HARNESS_ROOT:sources.harnessRoot,OPENNOVA_SIWC_STORAGE:loadSettings().storageDir,NODE_OPTIONS:'--import='+JSON.stringify(join(ROOT,'services/bot/resolve.mjs'))}});
    await wait(async()=>{try{return (await api('/health')).ready;}catch{return false;}},30000);
  }
  async function stop(){if(!child||child.exitCode!==null||child.signalCode)return;const done=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{await done;}finally{clearTimeout(timer);}}
  async function ask(text){
    const id=randomUUID(),s=(await api('/projects')).state;
    await api('/ask',{id,text,source:'text',expectedProject:{projectId:s.projectId,revision:s.revision}});
    const answer=await wait(async()=>{const row=await api('/result',{id});return !['running','queued'].includes(row.status)&&row;},220000);
    const ops=(await api('/operations')).filter(o=>o.requestId===id);
    report.steps.push({answer:answer.text,status:answer.status,operations:ops.map(o=>({operation:o.operation,status:o.status,error:o.error}))});
    assert.equal(answer.status,'completed',answer.error);return {answer,ops};
  }
  try{
    await start();
    await ask('继续当前项目，只读 sample.pdf 的物理第2页，抄录完整英文结果句。把验收数量作为一个关键事实，带可核查的版本、页码和完整英文原文，保存为项目内“验收.md”研究笔记。');
    const note=readFileSync(join(workspace,'验收.md'),'utf8');assert.ok(note.split('\n').some(s=>s.startsWith('> ')&&s.includes(line)));assert.ok(note.includes(sha));writeFileSync(join(dir,'note.md'),note);
    const before=readFileSync(trace,'utf8').length;
    await stop();rmSync(join(workspace,'sample.pdf'));await start();
    const {answer}=await ask('在当前项目中查回已存的“验收.md”研究笔记，使用笔记回查工具查询，不要重读或重建 sample.pdf。告诉我那条结论的原文件名、物理页码、原版完整 SHA-256 和逐字英文依据。');
    const calls=readFileSync(trace,'utf8').slice(before).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
    assert.ok(calls.some(c=>c.tool==='research_note'&&c.action==='lookup'&&c.ok));assert.ok(!calls.some(c=>c.tool==='document_read'));
    assert.ok(answer.text.includes(line));assert.ok(answer.text.toLowerCase().includes(sha));assert.match(answer.text,/sample\.pdf/i);assert.match(answer.text.replaceAll('*',''),/(?:第|页码[：: ]*|物理页[：: ]*)\s*2|page\s*2/i);
    report.passed=true;
  }catch(e){report.error=e.message;throw e;}
  finally{await stop();rmSync(home,{recursive:true,force:true});writeFileSync(join(dir,'report.json'),JSON.stringify(report,null,2));console.log('Evidence:',dir);}
}
if(resolve(process.argv[1]??'')===import.meta.filename)await run();
