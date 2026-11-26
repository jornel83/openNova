import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Operations} from '../operations.mjs';
import {createGifGenerator,createGifGenerateTool} from '../images/gif-generator.mjs';

const parameters={motion:'眨眼后回到原位',outputDir:'delivery'};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

function fixture(t){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'opennova-gif-host-')));
  const workspace=join(home,'project');mkdirSync(workspace);
  const ops=new Operations({home,workspace});
  const state={projectId:'yanxin',focus:'work',revision:1};
  const source=join(workspace,'selected.png');
  writeFileSync(source,'fixed reference');
  const request={id:'turn-1',projectId:state.projectId,binding:{...state,cwd:workspace,context:{kind:'file',file:{path:source,sha256:digest('fixed reference')}}}};
  const generators=[];
  t.after(async()=>{await Promise.all(generators.map(generator=>generator.close()));ops.close();rmSync(home,{recursive:true,force:true});});
  return {home,ops,state,request,source,make(runner){
    const generator=createGifGenerator({home,ops,projects:{state:()=>state},getRequest:()=>request,runner,retryDelayMs:1});
    generators.push(generator);return generator;
  }};
}

function pending(envelope){
  return {tool:'gif_generate',operationId:envelope.context.operationId,binding:envelope.context.binding,
    request:envelope.arguments,expectedReferenceHashes:envelope.context.expectedReferenceHashes,status:'pending',stage:'submitted',
    generation:{taskId:'task-yanxin',remoteCalls:1}};
}

test('GIF takes the bound current image and a duplicate call does not submit again',async t=>{
  const f=fixture(t);
  let submits=0;
  const generator=f.make((envelope,{recoverOnly})=>{
    if(recoverOnly)return {...pending(envelope),status:'failed',error:{code:'fixture_stopped'}};
    submits++;
    assert.equal(envelope.arguments.sourcePath,f.source);
    assert.equal(envelope.context.expectedReferenceHashes[f.source],digest('fixed reference'));
    return pending(envelope);
  });
  assert.equal(createGifGenerateTool(generator)[2].sourcePath.required,undefined);
  const initial=await generator.generate(parameters,{callId:'first'});
  assert.equal(initial.status,'pending');
  assert.equal((await generator.generate(parameters,{callId:'new-provider-id'})).id,initial.id);
  assert.equal(submits,1);
});

test('after a restart the GIF tool only resumes the recorded job in its original project',async t=>{
  const f=fixture(t);
  let envelope;
  const first=f.make((request,{recoverOnly})=>{
    assert.equal(recoverOnly,undefined);
    envelope=request;
    const directory=join(request.context.stateDir,request.context.operationId);
    mkdirSync(directory,{recursive:true});
    writeFileSync(join(directory,'operation.json'),JSON.stringify(pending(request)));
    return pending(request);
  });
  const initial=await first.generate(parameters,{callId:'first'});
  await first.close();
  f.state.projectId='another-project';
  const second=f.make((request,{recoverOnly})=>{
    assert.equal(recoverOnly,true);
    assert.deepEqual(request,envelope);
    const directory=request.arguments.outputDir;
    mkdirSync(directory);
    const artifacts=Object.fromEntries([['video','source.mp4','mp4'],['firstFrame','first-frame.png','png'],['gif','animation.gif','gif']].map(([role,name,format])=>{
      const path=join(directory,name);writeFileSync(path,role);
      return [role,{path,format,bytes:Buffer.byteLength(role),sha256:digest(role)}];
    }));
    return {...pending(request),artifacts,status:'completed',stage:'committed',fileValidation:{status:'passed'},firstFrameValidation:{status:'passed'}};
  });
  second.recover();
  for(let attempt=0;attempt<50&&f.ops.get(initial.id).status==='pending';attempt++)await delay(10);
  const finished=f.ops.get(initial.id);
  assert.equal(finished.status,'completed',finished.error);
  assert.equal(finished.generation.taskId,'task-yanxin');
  assert.equal(finished.projectId,'yanxin');
  assert.equal(finished.artifact.path,join(envelope.arguments.outputDir,'animation.gif'));
  assert.equal(f.state.projectId,'another-project');
});

test('an interrupted submission without task ID is not reissued',async t=>{
  const f=fixture(t);
  const first=f.make(envelope=>{
    const directory=join(envelope.context.stateDir,envelope.context.operationId);
    mkdirSync(directory,{recursive:true});
    writeFileSync(join(directory,'operation.json'),JSON.stringify({...pending(envelope),status:'running',stage:'submitting',generation:{remoteCalls:1}}));
    throw Error('image_executor_receipt_missing');
  });
  const record=await first.generate(parameters,{callId:'first'});
  const second=f.make(()=>assert.fail('must not submit again'));
  second.recover();
  assert.equal((await second.generate(parameters,{callId:'again'})).status,'unknown');
  assert.equal(f.ops.get(record.id).generation?.taskId,undefined);
});
