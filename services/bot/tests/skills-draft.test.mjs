import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runtimeSources} from '../../runtime/sources.mjs';
import {readJson,saveJson} from '../tasks/agent-files.mjs';
import {skillDocument,parseSkill} from '../skills/bundle.mjs';
import {apply,DRAFT_INSTRUCTIONS} from '../skills/draft-plugin.mjs';

const draft={name:'csv-amount-summary',description:'汇总金额并核对结果。',content:'# 汇总方法\n读取 {{input_csv}}，计算金额并验证 {{output_path}}。'};
async function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'nova-skill-draft-')),runDir=join(directory,'run'),workspace=join(directory,'workspace');
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const source={kind:'skill-extraction',candidateId:'candidate-1',candidateRevision:1,reportId:'report-1',reviewId:'review-1'};
  let tool;
  await apply({effect:fn=>fn(),tools:{register:value=>{tool=value;}}},{harnessRoot:runtimeSources().harnessRoot,managementReview:source,runDir,workspace,runId:'run-1'});
  return {tool,receipt:()=>readJson(join(runDir,'skill-draft.json')),inspect(){
    saveJson(join(runDir,'steps','read-report.json'),{tool:'read',status:'completed',arguments:{file_path:'report.json'},createdAt:1});
  }};
}

test('skill draft contract explains the identifier, Chinese prose and correction before submission',async t=>{
  const {tool}=await fixture(t),parameters=tool.parameters.properties;
  assert.match(parameters.name.description,/32/);
  assert.match(parameters.name.description,/小写英文字母/);
  assert.match(parameters.name.description,/中文/);
  assert.ok(parameters.name.examples.includes('csv-amount-summary'));
  assert.match(parameters.description.description,/2000/);
  assert.match(parameters.content.description,/64000.*UTF-8/);
  assert.match(DRAFT_INSTRUCTIONS,/32/);
  assert.match(DRAFT_INSTRUCTIONS,/再次调用 skill_draft/);
  assert.match(DRAFT_INSTRUCTIONS,/submitted:true/);
});

test('invalid names report the exact field and can be corrected without creating a receipt',async t=>{
  const f=await fixture(t);f.inspect();
  for(const name of ['a'.repeat(33),'中文技能名','','1-summary','sum amounts','sum--amounts','sum-','-sum','Sum-amounts','../sum','sum_amounts']){
    await assert.rejects(f.tool.execute({...draft,name},{}),error=>{
      assert.match(error.message,/invalid_skill.*name/);
      assert.match(error.message,/32/);
      assert.match(error.message,/小写英文字母/);
      assert.match(error.message,/中文/);
      assert.match(error.message,/再次调用 skill_draft/);
      return true;
    });
    assert.equal(f.receipt(),null);
  }
  const valid={...draft,name:'a'.repeat(32)};
  assert.equal(JSON.parse(await f.tool.execute(valid,{})).submitted,true);
  assert.deepEqual(f.receipt().draft,valid);
  assert.equal(JSON.parse(await f.tool.execute(valid,{})).submitted,true);
  await assert.rejects(f.tool.execute({...valid,name:'another-summary'},{}),/skill_draft_already_submitted/);
  assert.deepEqual(f.receipt().draft,valid);
});

test('description and content errors identify all invalid fields and preserve UTF-8 byte limits',async t=>{
  const f=await fixture(t);f.inspect();
  for(const [field,value] of [['description',' '],['description','中'.repeat(2001)],['content',' '],['content','中'.repeat(21334)],['content','bad\0content']]){
    await assert.rejects(f.tool.execute({...draft,[field]:value},{}),error=>{
      assert.match(error.message,new RegExp('invalid_skill.*'+field+':'));
      assert.doesNotMatch(error.message,/name:/);
      return true;
    });
    assert.equal(f.receipt(),null);
  }
  await assert.rejects(f.tool.execute({...draft,description:'',content:''},{}),error=>{
    assert.match(error.message,/description:.*content:/);return true;
  });
  const valid={...draft,description:'中'.repeat(2000),content:'中'.repeat(21333)+'a'};
  assert.equal(Buffer.byteLength(valid.content),64000);
  assert.equal(JSON.parse(await f.tool.execute(valid,{})).submitted,true);
});

test('draft validation retains source inspection and valid Chinese document content',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.tool.execute(draft,{}),/skill_source_not_inspected/);
  assert.equal(f.receipt(),null);f.inspect();
  assert.equal(JSON.parse(await f.tool.execute(draft,{})).submitted,true);
  const parsed=parseSkill(Buffer.from(skillDocument(draft.name,draft.description,draft.content)));
  assert.equal(parsed.name,draft.name);assert.equal(parsed.description,draft.description);assert.equal(parsed.content,draft.content);
  assert.throws(()=>skillDocument('中文',draft.description,draft.content),{message:'invalid_skill'},'public validation code stays compatible');
});
