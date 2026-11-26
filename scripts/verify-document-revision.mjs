/** Manual authenticated acceptance. Work exclusively on real, synthetic artifacts in a fresh Bot home. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,appendFileSync,copyFileSync,existsSync,readdirSync,rmSync,realpathSync} from 'node:fs';
import {dirname,join,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {ROOT,requireBuiltHarness} from '../services/runtime/sources.mjs';
import {botSettings} from '../services/bot/settings.mjs';
import {runtimePatch} from '../services/bot/configuration.mjs';
import {loadSettings} from '../services/agent/settings.mjs';
import {Operations} from '../services/bot/operations.mjs';
import {createWorkContext} from '../services/bot/desktop/context.mjs';
import {createDocumentGenerator} from '../services/bot/documents/generator.mjs';

export const name='synthetic-revision-check',inject=['tools'];
export function apply(ctx,config){
  ctx.tools.guard(exec=>{
    if(exec.name!=='document_generate'||!['inspect','revise'].includes(exec.arguments?.action))return 'Synthetic revision tools only.';
    if(exec.arguments.path&&!config.files.includes(resolve(config.workspace,exec.arguments.path)))return 'Synthetic fixture only.';
  });
  ctx.on('tools/execute',async(exec,next)=>{const result=await next();
    appendFileSync(config.trace,JSON.stringify({tool:exec.name,arguments:exec.arguments,isError:result.isError??false})+'\n');return result;},{prepend:true});
  ctx.on('system-prompt/assemble',async(_args,_context,next)=>{const prompt=await next();return {...prompt,tools:prompt.tools.filter(t=>t.name==='document_generate')};});
}
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function extract(path){return path.endsWith('.docx')?execFileSync('python3',['-I','-c',
  'from sys import argv;from zipfile import ZipFile;from xml.etree.ElementTree import fromstring;print(" ".join(fromstring(ZipFile(argv[1]).read("word/document.xml")).itertext()))',path],{encoding:'utf8'}):
  execFileSync('/usr/bin/swift',['-e','import PDFKit; import Foundation; print(PDFDocument(url:URL(fileURLWithPath:CommandLine.arguments[1]))!.string!)',path],{encoding:'utf8'});}
async function run(){
  const sources=requireBuiltHarness(),home=realpathSync(mkdtempSync(join(tmpdir(),'nova-revision-live-'))),workspace=join(home,'workspace');
  const token=randomUUID(),address=await port();let web=await port();while(web===address)web=await port();
  const config={...botSettings({OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PORT:String(address),OPENNOVA_BOT_WEB_PORT:String(web)}),workspace};
  const dir=join(ROOT,'output','verification','document-revision-preview',randomUUID());mkdirSync(dir,{recursive:true});mkdirSync(workspace);
  const trace=join(dir,'calls.jsonl'),reportPath=join(dir,'report.json'),report={steps:[],artifacts:[]};writeFileSync(trace,'');writeFileSync(config.tokenPath,token,{mode:0o600});
  const patch=runtimePatch({bot:config,agent:{harnessRoot:sources.harnessRoot},desktop:false}),plugins=patch.find(x=>x.insert).insert;
  plugins.splice(plugins.findIndex(p=>p.id==='opennova-bot'),0,{id:name,name:import.meta.filename,config:{trace,workspace,files:['plan.docx','report.pdf'].map(f=>join(workspace,f))}});
  const patchPath=join(home,'patch.json');writeFileSync(patchPath,JSON.stringify(patch));
  const api=async(path,body={})=>{const r=await fetch('http://127.0.0.1:'+address+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});assert.ok(r.ok);return r.json();};
  const child=spawn(process.execPath,[join(sources.harnessRoot,'apps/cli/lib/bin.js'),'--profile','web','--patch',patchPath,'--host','127.0.0.1','--port',String(web),'--no-open'],{cwd:workspace,stdio:'ignore',env:{PATH:dirname(process.execPath)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',HOME:process.env.HOME,USER:process.env.USER,LANG:'en_US.UTF-8',DSH_HOME:join(home,'harness'),OPENNOVA_BOT_HOME:home,OPENNOVA_BOT_PLUGIN:sources.botRoot,OPENNOVA_HARNESS_ROOT:sources.harnessRoot,OPENNOVA_SIWC_STORAGE:loadSettings().storageDir,NODE_OPTIONS:'--import='+JSON.stringify(join(ROOT,'services/bot/resolve.mjs'))}});
  async function wait(fn,ms){const end=Date.now()+ms;while(Date.now()<end){if(child.exitCode!==null||child.signalCode)throw Error('host_exited');const r=await fn();if(r)return r;await delay(250);}throw Error('probe_deadline');}
  async function ask(text){
    const id=randomUUID(),s=(await api('/projects')).state;
    await api('/ask',{id,text,source:'text',expectedProject:{projectId:s.projectId,revision:s.revision}});
    const a=await wait(async()=>{const row=await api('/result',{id});return !['running','queued'].includes(row.status)&&row;},240000);
    const rows=(await api('/operations')).filter(o=>o.requestId===id).map(o=>({action:o.action,status:o.status,error:o.error,phase:o.phase,proposal:o.proposal}));
    report.steps.push({id,text,status:a.status,reply:a.text,rows});writeFileSync(reportPath,JSON.stringify(report,null,2));assert.equal(a.status,'completed',a.error);return rows;
  }
  let ops;
  try{
    await wait(async()=>{try{return (await api('/health')).ready;}catch{return false;}},30000);
    const projectId=(await api('/projects')).state.projectId;ops=new Operations({home,workspace});const context=createWorkContext();
    const req={id:'offline-seed',projectId,binding:{projectId,cwd:workspace,focus:'work',context:context.capture()}},generator=createDocumentGenerator({home,ops,context,getRequest:()=>req});
    const marker='UNCHANGED-'+randomUUID().slice(0,8),newAmount='Confirmed quantity: '+(1000+Math.floor(Math.random()*8000))+'.';
    const seedPath=join(home,'seed.json');writeFileSync(seedPath,JSON.stringify({schemaVersion:1,title:'Initial document',blocks:[{type:'paragraph',text:marker},{type:'paragraph',text:'Pending quantity.'}]}));
    const seed={};for(const [format,name] of [['docx','plan.docx'],['pdf','report.pdf']]){
      const r=await generator.generate({format,specPath:seedPath,outputPath:name},{id:'seed-'+format});assert.equal(r.status,'completed',r.error);seed[format]=r.artifact;
    }
    for(const [format,name] of [['docx','plan'],['pdf','report']]){
      const old=seed[format],files=readdirSync(workspace).sort();
      const rows=await ask('继续当前项目，请修改你此前生成的 '+name+'.'+format+'，把正文段落“Pending quantity.”整段替换成“'+newAmount+'”，其余内容保持原样。先给我看修改对照。');
      const revision=rows.find(r=>r.phase==='proposed'&&r.proposal?.baseArtifactId===old.id);assert.ok(revision,'missing_proposal');
      const state=(await api('/projects')).state;
      const proposal=await api('/document-proposal',{id:revision.proposal.id,expectedProject:{projectId:state.projectId,revision:state.revision}});
      assert.equal(proposal.status,'pending');assert.equal(proposal.baseRevision,1);assert.equal(proposal.baseSha256,old.sha256);
      assert.equal(proposal.changeCount,1);const [change]=proposal.changes;
      assert.ok(JSON.stringify(change.before).includes('Pending quantity.')&&JSON.stringify(change.after).includes(newAmount));
      const text=extract(old.path);assert.ok(text.includes(marker)&&text.includes('Pending quantity.')&&!text.includes(newAmount));
      assert.equal(hash(old.path),old.sha256);assert.equal(hash(old.snapshotPath),old.sha256);
      assert.deepEqual(readdirSync(workspace).sort(),files);assert.equal(ops.list('document_artifact').length,2);
      copyFileSync(old.path,join(dir,basename(old.path)));report.artifacts.push({format,original:old.sha256,proposalId:proposal.id,change,oldBytesIntact:true,noNewEdition:true});
    }
    const manual=join(workspace,'plan.docx');execFileSync('python3',['-I','-c',
      'import sys,io,zipfile;from pathlib import Path;p=Path(sys.argv[1]);z=zipfile.ZipFile(io.BytesIO(p.read_bytes()));o=zipfile.ZipFile(p,"w");[(o.writestr(v,z.read(v).replace(b"Pending quantity.",b"My private manual change:") if v.filename=="word/document.xml" else z.read(v))) for v in z.infolist()];o.close()',manual]);
    assert.ok(extract(manual).includes('My private manual change:'));const before=hash(manual),beforeList=readdirSync(workspace).sort();
    const rows=await ask('继续当前项目，把 plan.docx 的文档标题改为“下一轮清单”，请给我看修改对照。');
    assert.ok(rows.some(r=>r.error==='document_revision_source_changed'),'missing_conflict');assert.ok(!rows.some(r=>r.phase==='proposed'));
    assert.deepEqual(readdirSync(workspace).sort(),beforeList);assert.equal(hash(manual),before);assert.ok(!existsSync(join(workspace,'plan.v2.docx')));
    report.conflict={manualHash:before,untouched:true,noNewEdition:true};report.passed=true;
  }catch(e){report.error=e.message;throw e;}
  finally{ops?.close();if(child.exitCode===null&&!child.signalCode){const done=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{await done;}finally{clearTimeout(timer);}}
    rmSync(home,{recursive:true,force:true});writeFileSync(reportPath,JSON.stringify(report,null,2));console.log('Evidence:',dir);}
}
if(resolve(process.argv[1]??'')===import.meta.filename)await run();
