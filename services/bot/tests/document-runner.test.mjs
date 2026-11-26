import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {runDocumentGenerator} from '../documents/runner.mjs';
import {normalizeDocumentSpec} from '../documents/spec.mjs';

const mac=process.platform==='darwin';
const fixtureSource=`import Foundation
import Darwin
let source=CommandLine.arguments[2]
let output=CommandLine.arguments[4]
let mode=try String(contentsOfFile:source,encoding:.utf8)
let env=ProcessInfo.processInfo.environment
let temp=env["TMPDIR"]!
let info:[String:Any]=["temp":temp,"swiftCache":env["SWIFT_MODULECACHE_PATH"]!,"clangCache":env["CLANG_MODULE_CACHE_PATH"]!,"cwd":FileManager.default.currentDirectoryPath,"source":source,"output":output,"mode":(try FileManager.default.attributesOfItem(atPath:temp))[.posixPermissions]!]
try JSONSerialization.data(withJSONObject:info).write(to:URL(fileURLWithPath:output))
if mode == "signal" { kill(getpid(),SIGKILL) }
if mode == "exit" { fputs("private-token private-document-text\\n",stderr);exit(7) }
if mode == "timeout" { signal(SIGTERM,SIG_IGN) }
if mode == "cancel" || mode == "timeout" { while true { sleep(1) } }
print("{\\"generation\\":{\\"status\\":\\"completed\\"},\\"contentValidation\\":{\\"status\\":\\"passed\\"},\\"layoutValidation\\":{\\"visual\\":{\\"status\\":\\"not_checked\\"}}}")
`;

function fixture(t){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'nova-runner-fixture-'))),workdir=join(root,'中文 空格 😀 项目');
  mkdirSync(join(root,'tools/documents'),{recursive:true});mkdirSync(workdir);
  writeFileSync(join(root,'tools/documents/generate_pdf.swift'),fixtureSource);
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return {root,workdir};
}
function traceOf(path){
  const trace=JSON.parse(readFileSync(path,'utf8'));
  assert.match(trace.temp,/^[\x21-\x7e]+$/);assert.equal(trace.mode,0o700);
  assert.equal(trace.swiftCache,join(trace.temp,'swift-cache'));assert.equal(trace.clangCache,join(trace.temp,'clang-cache'));
  assert.equal(existsSync(trace.temp),false,'owned compiler runtime must be removed after close');
  return trace;
}
async function ready(path,deadlineMs=15000){
  const deadline=Date.now()+deadlineMs;
  while(Date.now()<deadline){if(existsSync(path))return;await delay(20);}
  assert.fail('fixture did not reach its running phase');
}

test('TC02 PDF supports Chinese, spaces and emoji in project/spec/output paths with a non-ASCII system TMPDIR',{skip:!mac,timeout:40000},async t=>{
  const base=realpathSync(mkdtempSync(join(tmpdir(),'nova-runner-tc02-'))),workdir=join(base,'中文 空格 😀 项目'),configuredTmp=join(base,'系统 临时目录😀');
  mkdirSync(workdir);mkdirSync(configuredTmp);t.after(()=>rmSync(base,{recursive:true,force:true}));
  const spec=normalizeDocumentSpec({schemaVersion:1,title:'测试物资采购清单。',layout:{pageSize:'A4',fontPreset:'cjk',header:'测试物资采购清单',footer:true},blocks:[
    {type:'paragraph',text:'本清单包含60条合成测试数据，用于检查分页和表格完整性。'},
    {type:'table',columns:['编号','物资名称','数量','说明'],rows:Array.from({length:60},(_,index)=>{
      const n=index+1,id=String(n).padStart(2,'0');return [id,'测试物资'+id,String(n),'用于检查中文显示与跨页表格完整性'];
    }),summary:['合计','','1830','']},
    {type:'paragraph',text:'A2-PDF-验收结束。'},
  ]});
  const specPath='内容 输入😀.json',outputPath='A2-TC02-物资 清单😀.pdf';writeFileSync(join(workdir,specPath),JSON.stringify(spec));
  const previous=process.env.TMPDIR;process.env.TMPDIR=configuredTmp;
  try{
    const receipt=await runDocumentGenerator({format:'pdf',specPath,outputPath,workdir});
    assert.equal(receipt.generation.status,'completed');assert.equal(receipt.contentValidation.status,'passed');
    assert.ok(receipt.pageCount>=2);assert.equal(receipt.contentValidation.tableCells,61*4);
    assert.equal(receipt.contentValidation.repeatedHeaderCells,receipt.pageCount*4);
    assert.equal(receipt.layoutValidation.visual.status,'not_checked');
    assert.ok(readFileSync(join(workdir,outputPath)).subarray(0,5).equals(Buffer.from('%PDF-')));
    assert.deepEqual(JSON.parse(readFileSync(join(workdir,specPath),'utf8')),spec);
  }finally{if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;}
});

test('PDF runtime has private ASCII scratch space and cleans it after a successful child exit',{skip:!mac,timeout:20000},async t=>{
  const f=fixture(t),source='成功 内容.txt',output='成功 回执.json';writeFileSync(join(f.workdir,source),'success');
  await runDocumentGenerator({...f,format:'pdf',specPath:source,outputPath:output});
  const trace=traceOf(join(f.workdir,output));
  assert.equal(trace.cwd,f.workdir);assert.equal(trace.source,resolve(f.workdir,source));assert.equal(trace.output,resolve(f.workdir,output));
  assert.ok(!trace.temp.startsWith(f.workdir));assert.equal(existsSync(join(f.workdir,'runtime')),false);
});

test('PDF runtime keeps safe exit status and termination signal without exposing stderr, then cleans scratch space',{skip:!mac,timeout:30000},async t=>{
  const f=fixture(t);
  for(const mode of ['exit','signal']){
    const source=mode+'.txt',output=mode+'.json';writeFileSync(join(f.workdir,source),mode);
    await assert.rejects(runDocumentGenerator({...f,format:'pdf',specPath:source,outputPath:output}),error=>{
      assert.equal(error.message,mode==='signal'?'document_generator_crashed':'document_generator_failed');
      assert.deepEqual(error.details,mode==='signal'?{exitCode:null,signal:'SIGKILL'}:{exitCode:7,signal:null});
      assert.ok(!JSON.stringify(error).includes('private-'));return true;
    });
    traceOf(join(f.workdir,output));
  }
});

test('cancelling a running PDF child waits for its close before removing private runtime files',{skip:!mac,timeout:25000},async t=>{
  const f=fixture(t),controller=new AbortController(),output=join(f.workdir,'取消.json');writeFileSync(join(f.workdir,'mode.txt'),'cancel');
  const pending=runDocumentGenerator({...f,format:'pdf',specPath:'mode.txt',outputPath:output,signal:controller.signal});
  const assertion=assert.rejects(pending,error=>error.message==='cancelled'&&error.details.signal==='SIGTERM');
  await ready(output);const trace=JSON.parse(readFileSync(output,'utf8'));assert.ok(existsSync(trace.temp));
  controller.abort();await assertion;traceOf(output);
});

test('PDF timeout escalates a child ignoring SIGTERM and cleans scratch space only after SIGKILL',{skip:!mac,timeout:25000},async t=>{
  const f=fixture(t),output=join(f.workdir,'超时.json');writeFileSync(join(f.workdir,'mode.txt'),'timeout');
  const pending=runDocumentGenerator({...f,format:'pdf',specPath:'mode.txt',outputPath:output,timeoutMs:10000});
  const assertion=assert.rejects(pending,error=>error.message==='document_generation_timeout'&&error.details.signal==='SIGKILL');
  await ready(output);const trace=JSON.parse(readFileSync(output,'utf8'));assert.ok(existsSync(trace.temp));
  await assertion;traceOf(output);
});
