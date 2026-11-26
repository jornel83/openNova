import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeDocumentSpec} from '../documents/spec.mjs';
import {runDocumentGenerator} from '../documents/runner.mjs';

test('summary errors identify the exact table and expected cells without dropping input',()=>{
  const source={schemaVersion:1,title:'报告',blocks:[{type:'table',columns:['编号','分组','说明','数量'],rows:[['1','A','说明','12']],summary:['合计12']}]};
  assert.throws(()=>normalizeDocumentSpec(source),error=>error.message==='document_summary_columns_mismatch'&&error.details.field==='blocks[0].summary'&&error.details.expectedColumns===4&&error.details.actualColumns===1);
  source.blocks[0].summary=['合计','','','12'];assert.deepEqual(normalizeDocumentSpec(source).blocks[0].summary,source.blocks[0].summary);
});
test('default header never splits a Unicode scalar and normalization rejects hidden execution fields',()=>{
  const source={schemaVersion:1,title:'甲'.repeat(79)+'😀末尾',blocks:[{type:'paragraph',text:'第一行\r\n第二行\t<>&'}]};
  const normalized=normalizeDocumentSpec(source);assert.ok(normalized.layout.header.isWellFormed());assert.ok(normalized.layout.header.endsWith('😀'));
  assert.equal(normalized.blocks[0].text,'第一行\n第二行\t<>&');assert.equal(normalized.layout.pageSize,'A4');
  assert.throws(()=>normalizeDocumentSpec({...source,script:'malicious code'}),/invalid_document_spec/);
});
test('fixed runtime preserves structured executor errors from stderr and stdout',{skip:process.platform!=='darwin',timeout:20000},async()=>{
  const workdir=mkdtempSync(join(tmpdir(),'nova-generator-errors-'));
  try{
    const specPath=join(workdir,'spec.json');writeFileSync(specPath,JSON.stringify({schemaVersion:99}));
    await assert.rejects(runDocumentGenerator({format:'docx',specPath,outputPath:join(workdir,'bad.docx'),workdir}),/invalid_document_spec/);
    const spec=normalizeDocumentSpec({schemaVersion:1,title:'报告',blocks:[{type:'table',columns:['编号','说明'],rows:[['A','不能裁掉任何内容。'.repeat(1000)]]}]});
    writeFileSync(specPath,JSON.stringify(spec));
    await assert.rejects(runDocumentGenerator({format:'pdf',specPath,outputPath:join(workdir,'bad.pdf'),workdir}),/table_row_too_tall/);
  }finally{rmSync(workdir,{recursive:true,force:true});}
});
