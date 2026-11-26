/** Opt-in network acceptance: a real background model, fresh Bot, synthetic files only. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ROOT,requireBuiltHarness} from '../services/runtime/sources.mjs';
import {botSettings} from '../services/bot/settings.mjs';
import {runtimePatch} from '../services/bot/configuration.mjs';
import {loadSettings} from '../services/agent/settings.mjs';
import {Operations} from '../services/bot/operations.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function sample(mark){
  const body='BT /F1 20 Tf 40 650 Td (Acceptance code: '+mark+') Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 610 810] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length '+body.length+' >>\nstream\n'+body+'\nendstream','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let b='%PDF-1.4\n';const offsets=[];
  for(const [i,o] of objects.entries()){offsets.push(String(b.length).padStart(10,'0'));b+=(i+1)+' 0 obj\n'+o+'\nendobj\n';}
  const loc=b.length;return Buffer.from(b+'xref\n0 6\n0000000000 65535 f \n'+offsets.map(n=>n+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+loc+'\n%%EOF\n');
}

async function run(){
  const sources=requireBuiltHarness(),home=realpathSync(mkdtempSync(join(tmpdir(),'nova-live-background-docs-'))),workspace=join(home,'workspace');
  const token=randomUUID(),address=await port();let web=await port();while(web===address)web=await port();
  const cfg={...botSettings({OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(address),OPENNOVA_BOT_WEB_PORT:String(web)}),workspace};
  const dir=join(ROOT,'output','verification','a2-background-research',randomUUID());mkdirSync(dir,{recursive:true});mkdirSync(workspace);
  const patchPath=join(home,'patch.json');writeFileSync(patchPath,JSON.stringify(runtimePatch({bot:cfg,agent:{harnessRoot:sources.harnessRoot},desktop:false})));writeFileSync(cfg.tokenPath,token,{mode:0o600});
  const report={lane:'authenticated background model + native reader + fixed DOCX writer',startedAt:Date.now()},reportPath=join(dir,'report.json');
  const save=()=>writeFileSync(reportPath,JSON.stringify(report,null,2));save();console.log('Evidence:',dir);
  const child=spawn(process.execPath,[join(sources.harnessRoot,'apps/cli/lib/bin.js'),'--profile','web','--patch',patchPath,'--host','127.0.0.1','--port',String(web),'--no-open'],{cwd:workspace,stdio:['ignore','ignore','pipe'],env:{PATH:dirname(process.execPath)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',HOME:process.env.HOME,USER:process.env.USER,LANG:'en_US.UTF-8',DSH_HOME:join(home,'harness'),OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PLUGIN:sources.botRoot,OPENNOVA_HARNESS_ROOT:sources.harnessRoot,OPENNOVA_SIWC_STORAGE:loadSettings().storageDir,NODE_OPTIONS:'--import='+JSON.stringify(join(ROOT,'services/bot/resolve.mjs'))}});
  let diagnostic='';child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk).slice(-5000);});
  const api=async(path,body={})=>{const r=await fetch('http://127.0.0.1:'+address+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});const row=await r.json();assert.ok(r.ok,JSON.stringify(row));return row;};
  async function wait(fn,ms){const end=Date.now()+ms;while(Date.now()<end){if(child.exitCode!==null||child.signalCode)throw Error('host_exited');const r=await fn();if(r)return r;await delay(400);}throw Error('acceptance_deadline');}
  const choose=async(project)=>api('/project-action',{action:'select',actionId:randomUUID(),projectId:project.id,focus:'work',revision:(await api('/projects')).state.revision});
  let db;
  try{
    await wait(async()=>{try{return (await api('/health')).ready;}catch{return false;}},30000);
    const projects=[];
    for(const name of ['alpha','beta']){const directory=join(home,name);mkdirSync(directory);projects.push((await api('/project-action',{action:'create',actionId:randomUUID(),name,directory})).result);}
    const [a,b]=projects;await choose(a);
    const marks=Array.from({length:3},()=>randomUUID().slice(0,8).toUpperCase()),[original,replacement,other]=marks.map(sample);
    const input=join(a.workspace,'stock.pdf'),output=join(a.workspace,'盘点.docx');
    writeFileSync(input,original);writeFileSync(join(b.workspace,'stock.pdf'),other);writeFileSync(join(dir,'original.pdf'),original);
    const id='research-'+randomUUID();report.id=id;
    const r=await api('/background-task-start',{id,kind:'agent',documentResearch:true,workspaceMode:'documents',inputFiles:['stock.pdf'],documentOutputPath:'盘点.docx',managementEnabled:false,
      title:'盘点报告',goal:'阅读启动时指定的 stock.pdf，找出第一页 Acceptance code 的完整英文字母和数字。在指定的 Word 成品中保留完整英文原句，并写一句中文解释。只需保存这个 Word，不要其他成果。',permission:'full',maxSteps:18,timeoutMs:280000});
    assert.equal(r.task.projectId,a.id);report.admittedInput=r.task.inputSnapshot.files[0].sha256;assert.equal(report.admittedInput,hash(original));
    writeFileSync(input,replacement);await choose(b);const before=(await api('/snapshot')).workContext;
    report.projectA=a.id;report.projectB=b.id;save();
    const final=await wait(async()=>{const d=await api('/background-task',{id});if(['failed','cancelled','waiting_input','paused','interrupted'].includes(d.task.status)){
      report.failedRun=d.runs.at(-1)?.result??{error:d.task.error};throw Error('task_'+d.task.status);}
      return d.task.cleanupConfirmed&&d.task.status==='completed'&&d;},320000);
    db=new Operations({home,workspace});const tools=db.list('tool').filter(o=>o.taskId===id);report.toolReceipts=tools.map(o=>({id:o.id,name:o.operation,status:o.status,error:o.error,readSha:o.source?.sha256,artifactSha:o.artifact?.sha256}));
    assert.ok(tools.some(o=>o.operation==='document_read'&&o.source?.sha256===hash(original)&&o.status==='completed'));assert.ok(tools.every(o=>o.projectId===a.id));
    assert.ok(existsSync(output));const text=execFileSync('python3',['-I','-c','import sys,zipfile,xml.etree.ElementTree as ET;print(" ".join(ET.fromstring(zipfile.ZipFile(sys.argv[1]).read("word/document.xml")).itertext()))',output],{encoding:'utf8'});
    assert.ok(text.includes(marks[0])&&!text.includes(marks[1])&&!text.includes(marks[2]));
    const delivered=hash(readFileSync(output));assert.ok(tools.some(o=>o.operation==='document_generate'&&o.artifact?.sha256===delivered&&o.status==='completed'));
    assert.ok(final.teamReview.current.artifacts.some(o=>o.sha256===delivered));assert.equal(hash(readFileSync(input)),hash(replacement));assert.ok(!existsSync(join(b.workspace,'盘点.docx')));
    assert.equal((await api('/projects')).state.projectId,b.id);assert.deepEqual((await api('/snapshot')).workContext,before);
    copyFileSync(output,join(dir,'盘点.docx'));Object.assign(report,{marks,verifiedText:text,delivered,frontProjectUnchanged:true,passed:true});
  }catch(e){report.error=e.message;report.host={code:child.exitCode,signal:child.signalCode,diagnostic:diagnostic.replace(/token=[^\s&]+/gi,'token=[redacted]')};
    if(existsSync(join(home,'bridge.sqlite'))){
      db??=new Operations({home,workspace});report.recordedTools=db.list('tool').filter(r=>r.taskId===report.id).map(r=>({name:r.operation,status:r.status,error:r.error}));
    }
    throw e;}
  finally{db?.close();if(child.exitCode===null&&!child.signalCode){const done=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),6000);try{await done;}finally{clearTimeout(timer);}}
    rmSync(home,{recursive:true,force:true});report.finishedAt=Date.now();save();}
}
if(resolve(process.argv[1]??'')===import.meta.filename)await run();
