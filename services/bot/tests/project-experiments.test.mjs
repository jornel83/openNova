import assert from 'node:assert/strict';
import {appendFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,truncateSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Operations} from '../operations.mjs';
import {createExperimentTool,experimentControl,readExperimentSource} from '../experiments/service.mjs';

function audio(frames) {
  const bytes=Buffer.alloc(44+2*frames);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(24000,24);
  bytes.writeUInt32LE(48000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
  bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);bytes.writeInt16LE(2,44);
  return bytes;
}

function fixture(t) {
  const home=mkdtempSync(join(tmpdir(),'a4-runs-')),workspace=join(home,'project');
  mkdirSync(workspace);
  let ops=new Operations({home,workspace}), projectId='alpha';
  t.after(()=>{ops.close();rmSync(home,{recursive:true,force:true});});
  const files=[
    {role:'data',path:'input.txt'}, {role:'config',path:'config.json'},
    {role:'sample',path:'sample.wav'}, {role:'log',path:'run.log'},
  ];
  const original=audio(24000);
  writeFileSync(join(workspace,'input.txt'),'今天的播报');
  writeFileSync(join(workspace,'config.json'),'{"tempo":1,"voice":"test"}');
  writeFileSync(join(workspace,'run.log'),'ready');
  writeFileSync(join(workspace,'sample.wav'),original);
  const input={experiment:'中文播报',title:'原速',modelVersion:'TTS test 1',files};
  writeFileSync(join(workspace,'run.json'),JSON.stringify(input));
  return {workspace,home,input,original,
    tool(args,signal) {return createExperimentTool({ops,getRequest:()=>({id:'test-req',binding:{projectId,cwd:workspace,focus:'work'},signal})})[3](args);},
    evidence(run,file) {return experimentControl('/experiment-evidence',{ops,projects:{validateExpected:()=>({projectId,focus:'work'})}},
      {expectedProject:{projectId,revision:1},runId:run.id,path:file.path,sha256:file.sha256});},
    source(id){return readExperimentSource(ops,projectId,id);},
    inspect(){return ops;},select(id){projectId=id;},restart(){ops.close();ops=new Operations({home,workspace});}};
}

test('实验可重复登记，固定文件和实测依据保留至切换项目及重启之后',async t=>{
  const f=fixture(t);
  const a=await f.tool({action:'record',manifestPath:'run.json'});
  assert.equal((await f.tool({action:'record',...f.input})).id,a.id);
  assert.equal(f.tool({action:'list'}).runs.length,1);
  const [receipt]=f.inspect().list('tool');
  assert.equal(f.inspect().list('tool').length,1);assert.equal(receipt.operation,'project_experiment');
  assert.deepEqual(receipt.sourceIds,[a.id]);
  writeFileSync(join(f.workspace,'config.json'),'{"tempo":1.35,"voice":"test"}');
  writeFileSync(join(f.workspace,'sample.wav'),audio(18000));
  const b=await f.tool({action:'record',...f.input,title:'加速',findings:[{text:'听者偏好待评估',evidence:['run.log']}]});
  f.select('beta');
  assert.equal(f.tool({action:'list'}).runs.length,0);
  assert.throws(()=>f.tool({action:'compare',runIds:[a.id,b.id]}),/unknown_experiment_run/);
  assert.throws(()=>f.source(a.id),/unknown_experiment_run/);
  assert.throws(()=>f.evidence(a,a.files[2]),/unknown_experiment_run/);
  f.restart();f.select('alpha');
  const compare=f.tool({action:'compare',runIds:[a.id,b.id]});
  const detail=experimentControl('/project-experiments',{ops:f.inspect(),projects:{validateExpected:()=>({projectId:'alpha',focus:'work'})}},
    {expectedProject:{projectId:'alpha',revision:2},runIds:receipt.sourceIds});
  assert.deepEqual(detail.runs.map(run=>run.id),[a.id]);
  assert.deepEqual(f.inspect().list('tool').find(op=>op.action==='compare').sourceIds,[a.id,b.id]);
  assert.equal(compare.sameInput,true);
  assert.equal(compare.duration.deltaSeconds,-0.25);
  assert.deepEqual(compare.changes,[{key:'tempo',before:1,after:1.35}]);
  assert.deepEqual(compare.runs[1].findings.map(x=>x.kind),['reported','measured']);
  assert.deepEqual(f.evidence(a,a.files[2]).bytes,f.original);
  assert.equal(f.evidence(a,a.files[1]).bytes.toString(),'{"tempo":1,"voice":"test"}');
  assert.match(f.source(a.id).text,/SHA-256/);
  assert.throws(()=>f.evidence(a,{...a.files[2],sha256:b.files[2].sha256}),/unknown_experiment_evidence/);
  f.inspect().db.prepare('UPDATE experiment_blob SET bytes=? WHERE sha256=?').run(Buffer.from('oops'),a.files[2].sha256);
  assert.throws(()=>f.evidence(a,a.files[2]),/experiment_evidence_damaged/);
});

test('缺少文件、非法引用、变动的摘要和跨项目路径不能留下半套证据',async t=>{
  const f=fixture(t);
  const register=extra=>f.tool({action:'record',...f.input,...extra});
  await assert.rejects(()=>register({files:[...f.input.files,{role:'config',path:'../no'}]}),/invalid_experiment_path/);
  symlinkSync(join(f.workspace,'input.txt'),join(f.workspace,'alias.txt'));
  await assert.rejects(()=>register({files:[{role:'data',path:'alias.txt'}]}),/invalid_experiment_path/);
  await assert.rejects(()=>register({files:[{...f.input.files[0],sha256:'stale'}]}),/experiment_file_changed/);
  await assert.rejects(()=>register({findings:[{text:'未经实测',evidence:['another.wav']}]}),/experiment_finding_requires_evidence/);
  await assert.rejects(()=>register({files:[f.input.files[0],f.input.files[0]]}),/duplicate_experiment_file/);
  writeFileSync(join(f.workspace,'sample.wav'),'broken');
  await assert.rejects(()=>register({}),/invalid_experiment_wave/);
  assert.equal(f.tool({action:'list'}).runs.length,0);
});

test('其他数据或缺项的轮次不会被当作相同输入，模型版本和报告引用明确',async t=>{
  const f=fixture(t);
  const a=await f.tool({action:'record',...f.input});
  writeFileSync(join(f.workspace,'input.txt'),'另一段');
  const b=await f.tool({action:'record',...f.input,modelVersion:'TTS test 2'});
  let diff=f.tool({action:'compare',runIds:[a.id,b.id]});
  assert.equal(diff.sameInput,false);assert.equal(diff.modelChanged,true);
  const c=await f.tool({action:'record',...f.input,files:[f.input.files[1]]});
  diff=f.tool({action:'compare',runIds:[a.id,c.id]});
  assert.equal(diff.sameInput,null);assert.equal(diff.duration,undefined);
  const d=await f.tool({action:'record',...f.input,experiment:'另一个实验'});
  assert.throws(()=>f.tool({action:'compare',runIds:[a.id,d.id]}),/experiment_group_mismatch/);
  const withoutVersion=await f.tool({action:'record',...f.input,modelVersion:null});
  assert.equal(withoutVersion.modelVersion,null);
  assert.equal(f.tool({action:'compare',runIds:[a.id,withoutVersion.id]}).modelChanged,null);
  writeFileSync(join(f.workspace,'config.json'),'{"modelVersion":"model-3"}');
  await assert.rejects(()=>f.tool({action:'record',...f.input}),/experiment_model_version_conflict/);
  const fromConfig=await f.tool({action:'record',...f.input,modelVersion:null});
  assert.equal(fromConfig.modelVersion,'model-3');
  assert.deepEqual(fromConfig.modelEvidence,['config.json']);
});

test('大模型仅引用支持取消，保存准确摘要和原件位置，引用不读作已归档文件',async t=>{
  const f=fixture(t),path='checkpoint.bin',fullPath=join(f.workspace,path);
  writeFileSync(fullPath,'model');truncateSync(fullPath,12*1024*1024);
  const args={action:'record',...f.input,files:[{role:'model',path,mode:'reference'}]};
  const abort=new AbortController();
  const interrupted=f.tool(args,abort.signal);
  setImmediate(()=>abort.abort());
  await assert.rejects(interrupted,{name:'AbortError'});
  assert.equal(f.tool({action:'list'}).runs.length,0);
  let heartbeat=false;
  const pending=f.tool(args);setImmediate(()=>{heartbeat=true;});
  const run=await pending;
  assert.equal(heartbeat,true);
  assert.equal(run.files[0].sha256,createHash('sha256').update(readFileSync(fullPath)).digest('hex'));
  assert.equal(run.files[0].mode,'reference');assert.ok(run.files[0].location.endsWith(path));
  assert.equal(f.inspect().db.prepare('SELECT COUNT(*) n FROM experiment_blob').get().n,0);
  assert.throws(()=>f.evidence(run,run.files[0]),/experiment_reference_has_no_snapshot/);
  assert.match(f.source(run.id).text,/仅引用/);
  const inspect=()=>f.tool({action:'inspect',runIds:[run.id]});
  assert.equal((await inspect()).files[0].sourceStatus.state,'version_matches');
  appendFileSync(fullPath,'delta');
  assert.equal((await inspect()).files[0].sourceStatus.state,'changed');
  f.restart();rmSync(fullPath);
  assert.equal((await inspect()).files[0].sourceStatus.state,'missing');
  f.select('beta');assert.throws(inspect,/unknown_experiment_run/);
});

test('嵌套配置的摘要差异可见，原 WAV 删除后仍可读登记时的样音',async t=>{
  const f=fixture(t),config=join(f.workspace,'config.json');
  writeFileSync(config,'{"voice":{"tempo":1}}');
  const a=await f.tool({action:'record',...f.input});
  writeFileSync(config,'{"voice":{"tempo":1.35}}');
  const b=await f.tool({action:'record',...f.input});
  const comparison=f.tool({action:'compare',runIds:[a.id,b.id]});
  assert.equal(comparison.configurationChanged,true);assert.match(comparison.configurationSummary,/内容有变化/);
  rmSync(join(f.workspace,'sample.wav'));
  const sample=a.files.find(file=>file.role==='sample');
  const projects={project:()=>({workspace:f.workspace}),validateExpected:()=>({projectId:'alpha',focus:'work'})};
  const target={expectedProject:{projectId:'alpha',revision:1},runId:a.id,path:sample.path,sha256:sample.sha256,checkSource:true};
  assert.equal((await experimentControl('/project-experiments',{ops:f.inspect(),projects},target)).state,'missing');
  assert.deepEqual(f.evidence(a,sample).bytes,f.original);
});
