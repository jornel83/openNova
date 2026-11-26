import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeVoiceDevices} from '../desktop/voice-devices.mjs';
import {createActiveDocumentTracker} from '../desktop/active-document.mjs';
import {preparePdfPages} from '../desktop/pdf-pages.mjs';
import {verifyPdfQuotes} from '../desktop/pdf-evidence.mjs';
import {verifyOfficeQuotes} from '../desktop/office-evidence.mjs';
import {documentCapabilities,runDocumentGenerator} from '../documents/runner.mjs';

function fixture(t){
  const base=mkdtempSync(join(tmpdir(),'nova packaged helpers ')),bin=join(base,'bin'),workdir=join(base,'workspace');
  mkdirSync(bin);mkdirSync(workdir);
  const saved={};
  for(const key of ['OPENNOVA_PACKAGED','OPENNOVA_BIN_DIR','OPENNOVA_PYTHON'])saved[key]=process.env[key];
  Object.assign(process.env,{OPENNOVA_PACKAGED:'1',OPENNOVA_BIN_DIR:bin,OPENNOVA_PYTHON:join(bin,'python')});
  t.after(()=>{for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}rmSync(base,{recursive:true,force:true});});
  const binary=(name,source)=>writeFileSync(join(bin,name),`#!${process.execPath}\n${source}\n`,{mode:0o700});
  return {base,bin,workdir,binary};
}

test('packaged device enumeration runs only the bundled list helper without source or output directories',async t=>{
  const f=fixture(t);f.binary('opennova-audio',`if(process.argv.slice(2).join()!=='--list-devices')process.exit(2);console.log(JSON.stringify({type:'devices',devices:[]}));`);
  assert.deepEqual(await nativeVoiceDevices({root:join(f.base,'absent-resources'),platform:'darwin'})(),{devices:[],defaultInput:null,defaultOutput:null});
  assert.equal(existsSync(join(f.base,'absent-resources')),false);
  rmSync(join(f.bin,'opennova-audio'));
  await assert.rejects(nativeVoiceDevices({root:f.base,platform:'darwin'})(),/voice_devices_runtime_missing/);
  assert.equal(existsSync(join(f.base,'output')),false);
});

test('packaged PDF helpers receive operation arguments directly and never invoke Swift',{skip:process.platform!=='darwin'},async t=>{
  const f=fixture(t);
  f.binary('opennova-pdf-pages',`if(process.argv.length!==3||!process.argv[2].endsWith('source.pdf'))process.exit(2);console.log(JSON.stringify({pageCount:1}));`);
  f.binary('opennova-pdf-evidence',`if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['source.pdf','items.json']))process.exit(2);console.log(JSON.stringify([{page:1,verified:true,quote:'verified text'}]));`);
  const bytes=Buffer.from('%PDF-1.7\nfixture');
  assert.equal((await preparePdfPages({bytes})).pageCount,1);
  assert.deepEqual(await verifyPdfQuotes({bytes,items:[{page:1,quote:'verified text'}]}),[{verified:true,page:1,quote:'verified text'}]);
  delete process.env.OPENNOVA_BIN_DIR;
  await assert.rejects(preparePdfPages({bytes}),/pdf_pages_runtime_unavailable/);
  assert.equal((await verifyPdfQuotes({bytes,items:[{page:1,quote:'verified text'}]}))[0].reason,'pdf_evidence_unavailable');
});

test('packaged document and Office workers use bundled binaries without falling back to system runtimes',{skip:process.platform!=='darwin'},async t=>{
  const f=fixture(t),specPath=join(f.workdir,'content.json'),outputPath=join(f.workdir,'result.pdf');
  writeFileSync(specPath,'{}');
  f.binary('opennova-generate-pdf',`const fs=require('node:fs'),args=process.argv.slice(2);if(args.length!==4||args[0]!=='--spec'||args[2]!=='--output')process.exit(2);fs.writeFileSync(args[3],'generated');console.log(JSON.stringify({generation:{status:'completed'},contentValidation:{status:'passed'},layoutValidation:{status:'passed'}}));`);
  f.binary('python',`const args=process.argv.slice(2);if(args[0]!=='-I'||args[1]!=='-B'||!args[2].endsWith('office_evidence.py')||args[3]!=='docx')process.exit(2);console.log(JSON.stringify([{verified:true,quote:'verified text'}]));`);
  const capabilities=documentCapabilities();assert.equal(capabilities.pdf.command,join(f.bin,'opennova-generate-pdf'));assert.equal(capabilities.docx.command,join(f.bin,'python'));
  await runDocumentGenerator({format:'pdf',specPath,outputPath,workdir:f.workdir});assert.equal(readFileSync(outputPath,'utf8'),'generated');
  const mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  assert.deepEqual(await verifyOfficeQuotes({bytes:Buffer.from('fixture'),mime,items:[{quote:'verified text',locator:{paragraph:1}}]}),[{verified:true,quote:'verified text'}]);
  delete process.env.OPENNOVA_PYTHON;delete process.env.OPENNOVA_BIN_DIR;
  assert.equal(documentCapabilities().pdf.available,false);assert.equal(documentCapabilities().docx.available,false);
  assert.equal((await verifyOfficeQuotes({bytes:Buffer.from('fixture'),mime,items:[{quote:'verified text',locator:{paragraph:1}}]}))[0].reason,'office_evidence_unavailable');
});

test('packaged active-document observer launches its bundled executable',{skip:process.platform!=='darwin'},async t=>{
  const f=fixture(t);
  f.binary('opennova-active-document',`if(process.argv.length!==2)process.exit(2);console.log(JSON.stringify({ready:true}));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);console.log(JSON.stringify({id:request.id,status:'unavailable',reason:'no_document_window'}));});`);
  const tracker=createActiveDocumentTracker();t.after(()=>tracker.close());
  let result;
  for(let i=0;i<50;i++){result=await tracker.capture();if(result.reason!=='desktop_observer_starting')break;await delay(20);}
  assert.deepEqual(result,{status:'unavailable',reason:'no_document_window'});
});
