import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Operations} from '../operations.mjs';
import {createWorkContext} from '../desktop/context.mjs';
import {createImageGenerator} from '../images/generator.mjs';
import {CHARACTER_PROFILE_FILE} from '../images/characters.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XfV0AAAAASUVORK5CYII=','base64');
const sha256=createHash('sha256').update(png).digest('hex');
const create={mode:'create',prompt:'测试图',outputPath:'a.png'};
const edit={mode:'edit',prompt:'只换衣领',outputPath:'b.png'};
function fixture(t){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-image-host-')));
  const cwd=join(home,'project');mkdirSync(cwd);
  const ops=new Operations({home,workspace:cwd});
  const context=createWorkContext({});
  let state={focus:'work',projectId:'project-a',revision:2};
  let request;let serial=0;
  function next(){
    request={id:'ask-'+(++serial),projectId:state.projectId,binding:{...state,cwd,context:context.capture()},signal:new AbortController().signal};
    return request;
  }
  next();
  const projects={state:()=>state,saveContext(){ops.put({id:'ctx',kind:'project_context',file:context.capture().file});}};
  const envelopes=[];
  function receipt(env){
    const a=env.arguments;
    writeFileSync(a.outputPath,png,{flag:'wx'});
    return {tool:'image_generate',operationId:env.context.operationId,binding:env.context.binding,status:'completed',
      generation:{status:'succeeded',model:'fixture',remoteCalls:1},fileValidation:{status:'passed'},artifact:{path:a.outputPath,format:'png',bytes:png.length,sha256,width:1,height:1}};
  }
  const make=(runner,options={})=>createImageGenerator({home,ops,projects,context,getRequest:()=>request,...options,runner:(e,opts)=>{envelopes.push(e);return runner(e,opts);}});
  t.after(()=>{ops.close();rmSync(home,{recursive:true,force:true});});
  return {home,cwd,ops,context,next,make,receipt,envelopes,state:s=>state=s};
}

test('a follow-up edits the selected project image and verifies its pinned hash before generation',async t=>{
  const f=fixture(t),g=f.make(f.receipt);
  const first=await g.generate(create,{callId:'make'});
  assert.equal(first.status,'completed');assert.equal(f.context.capture().file.path,join(f.cwd,'a.png'));assert.equal(f.ops.get('ctx').file.id,first.file.id);
  // A duplicate with a new callId within the same turn must reuse the published file.
  assert.equal((await g.generate({...create},{callId:'retry'})).id,first.id);
  assert.equal(f.envelopes.length,1);
  f.next();
  const second=await g.generate(edit,{callId:'edit'});
  assert.equal(second.status,'completed');
  const envelope=f.envelopes[1];
  assert.deepEqual(envelope.arguments.references,[first.file.path]);
  assert.equal(envelope.context.expectedReferenceHashes[first.file.path],sha256);assert.equal(envelope.context.binding.projectId,'project-a');
  assert.equal(f.context.capture().file.path,join(f.cwd,'b.png'));
  f.next();writeFileSync(second.file.path,'changed');
  assert.equal((await g.generate({...edit,outputPath:'c.png'},{callId:'edit-changed'})).error,'image_reference_changed');
  assert.equal(f.envelopes.length,2);
});

test('a character-bound image uses approved references and stops if the approved bytes change',async t=>{
  const f=fixture(t),g=f.make(f.receipt);
  const approved=join(f.cwd,'伍宝定稿.png');writeFileSync(approved,png);
  mkdirSync(join(f.cwd,'.opennova'));
  const profile=JSON.stringify({schemaVersion:1,characters:[{id:'wubao',name:'伍宝',version:'approved-v1',
    constraints:['保留短棕色侧分发'],references:[{path:'伍宝定稿.png',sha256}]}]});
  writeFileSync(join(f.cwd,CHARACTER_PROFILE_FILE),profile);
  const existing=await g.generate(create,{callId:'unrelated-current-image'});
  assert.equal(existing.status,'completed');
  f.next();
  const input={...edit,characterId:'wubao',prompt:'单独制作伍宝的表情包'};
  const result=await g.generate(input,{callId:'role-edit'});
  assert.equal(result.status,'completed',JSON.stringify(result));
  const envelope=f.envelopes[1];
  assert.deepEqual(envelope.arguments.references,[approved]);
  assert.equal(envelope.context.expectedReferenceHashes[approved],sha256);
  assert.match(envelope.arguments.prompt,/保留短棕色侧分发/);
  assert.equal(Object.hasOwn(envelope.arguments,'characterId'),false);
  assert.deepEqual(result.character.references,[{path:approved,sha256}]);
  assert.equal(result.character.version,'approved-v1');
  assert.equal(result.character.profileSha256,createHash('sha256').update(profile).digest('hex'));

  writeFileSync(approved,Buffer.concat([png,Buffer.from('changed')]));
  f.next();
  const blocked=await g.generate({...input,outputPath:'c.png'},{callId:'role-edit-changed'});
  assert.equal(blocked.status,'failed');
  assert.equal(blocked.error,'character_reference_changed');
  assert.equal(f.envelopes.length,2,'changed approved reference must never reach the media worker');
});

test('invalid input cannot forward host identities, remote sources, escaped paths, or symlink outputs to the worker',async t=>{
  const f=fixture(t),g=f.make(f.receipt);
  const outside=join(f.home,'other');mkdirSync(outside);symlinkSync(outside,join(f.cwd,'linked'));
  for(const [index,patch] of [{context:{projectId:'x'}},{outputPath:'../other/a.png'},{outputPath:'linked/b.png'},{references:['https://example.com/input.png']},{stateDir:f.home}].entries()){
    assert.equal((await g.generate({...create,...patch},{callId:'bad'+index})).status,'failed');
  }
  assert.equal(f.envelopes.length,0);
});

test('late success stays recorded in its original project while a new project has focus',async t=>{
  const f=fixture(t);
  let resume,started;
  const ready=new Promise(resolve=>started=resolve);
  const g=f.make(async envelope=>{started();await new Promise(resolve=>resume=resolve);return f.receipt(envelope);});
  const pending=g.generate(create,{callId:'late'});
  await ready;f.state({focus:'work',projectId:'project-b',revision:3});resume();
  const row=await pending;
  assert.equal(row.status,'completed');assert.equal(row.contextSelected,false);assert.equal(f.context.capture().kind,'none');assert.equal(row.artifact.projectId,'project-a');
  assert.deepEqual(readFileSync(row.artifact.path),png);
});

test('unknown submission stops repeat generation within a turn; startup reconciles persisted image without a new submit',async t=>{
  const f=fixture(t);
  const metadata={contentType:'application/json',declaredBytes:123,receivedBytes:0};
  const failed=f.make(()=>({status:'unknown',stage:'submitting',error:{code:'generation_completion_unknown'},
    generation:{status:'unknown',reason:'ark_response_incomplete',responseMetadata:metadata,remoteCalls:1,credentialScope:'private-fingerprint'}}));
  const result=await failed.generate(create,{callId:'first'});
  assert.equal(result.status,'unknown');
  assert.equal(result.generation.reason,'ark_response_incomplete');assert.deepEqual(result.generation.responseMetadata,metadata);
  assert.equal(Object.hasOwn(result.generation,'credentialScope'),false);
  await assert.rejects(failed.generate({...create,outputPath:'new.png'},{callId:'again'}),/prior_generation_unknown_no_retry/);
  const env=f.envelopes[0];
  const dir=join(env.context.stateDir,env.context.operationId);mkdirSync(dir,{recursive:true});
  const success=f.receipt(env);
  writeFileSync(join(dir,'operation.json'),JSON.stringify(success));
  const g=f.make(()=>assert.fail('completed journal must not submit a generation'));
  await g.recover();
  const recovered=f.ops.get(result.id);
  assert.equal(recovered.status,'completed');assert.equal(recovered.recovered,true);assert.equal(recovered.contextSelected,false);
  assert.equal(f.context.capture().kind,'none');assert.equal(f.envelopes.length,1);
});

test('restart resumes a downloaded provider result in local-only mode and preserves caller project context',async t=>{
  const f=fixture(t);
  const interrupted=f.make(()=>({status:'unknown',stage:'receiving',generation:{remoteCalls:1,status:'succeeded'}}));
  const row=await interrupted.generate(create,{callId:'interrupted'});
  const envelope=f.envelopes[0],dir=join(envelope.context.stateDir,row.id);
  mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'operation.json'),JSON.stringify({operationId:row.id,tool:'image_generate',
    request:envelope.arguments,binding:envelope.context.binding,status:'running',stage:'receiving'}));
  await f.make((e,{recoverOnly})=>{assert.equal(recoverOnly,true);assert.equal(e.context.operationId,row.id);return f.receipt(e);}).recover();
  assert.equal(f.ops.get(row.id).status,'completed');assert.equal(f.context.capture().kind,'none');
  assert.equal(f.ops.get(row.id).file.imageOperationId,row.id);
});

test('an abort after provider submission is marked unknown and a late local publication is recorded without activation',async t=>{
  for(const publish of [false,true]){
    const f=fixture(t),ac=new AbortController();
    const g=f.make(env=>{
      const dir=join(env.context.stateDir,env.context.operationId);mkdirSync(dir,{recursive:true});
      const saved=publish?f.receipt(env):{tool:env.tool,operationId:env.context.operationId,binding:env.context.binding,status:'running',stage:'submitting',generation:{status:'submitting',remoteCalls:1}};
      writeFileSync(join(dir,'operation.json'),JSON.stringify(saved));ac.abort();throw Error('image_executor_interrupted');
    });
    const row=await g.generate(create,{callId:'cancelled-worker',signal:ac.signal});
    assert.equal(row.status,publish?'completed':'unknown');assert.equal(row.contextSelected,false);
    assert.equal(f.context.capture().kind,'none');
  }
});

test('a Spark image survives lost submission acknowledgement and restart without submitting again or moving focus',async t=>{
  const f=fixture(t);
  writeFileSync(join(f.cwd,'square.png'),png);
  const args={...edit,model:'minimax-h3-image',references:['square.png']};
  const generation={provider:'spark',model:args.model,taskId:'h3-image-'+'a'.repeat(32),status:'submitted',remoteCalls:1};
  let creates=0,queries=0;
  const original=f.make(envelope=>{
    creates++;
    const {stateDir,operationId,binding}=envelope.context;
    const dir=join(stateDir,operationId);mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,'operation.json'),JSON.stringify({operationId,tool:envelope.tool,request:envelope.arguments,binding,generation,status:'running',stage:'submitting_spark'}));
    throw Error('image_executor_interrupted');
  });
  const pending=await original.generate(args,{callId:'spark-submit'});
  assert.equal(pending.status,'pending');
  assert.equal(pending.generation.taskId,generation.taskId);
  assert.equal((await original.generate(args,{callId:'spark-retry'})).id,pending.id);
  await original.close();
  f.state({focus:'work',projectId:'project-b',revision:3});
  const resumed=f.make((envelope,{recoverOnly})=>{
    assert.equal(recoverOnly,true);assert.equal(envelope.context.operationId,pending.id);
    assert.deepEqual(envelope.arguments.references,[join(f.cwd,'square.png')]);
    assert.ok(!Object.hasOwn(envelope.arguments,'size'));
    queries++;
    if(queries===1)return {operationId:pending.id,tool:envelope.tool,binding:envelope.context.binding,
      generation:{...generation,status:'running'},status:'pending',stage:'awaiting_provider'};
    return {...f.receipt(envelope),generation:{...generation,status:'succeeded'}};
  },{retryDelayMs:1});
  try{
    await resumed.recover();
    for(let n=0;n<100&&f.ops.get(pending.id).status==='pending';n++)await delay(5);
    const done=f.ops.get(pending.id);
    assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(done.artifact.sha256,sha256);
    assert.equal(done.generation.taskId,generation.taskId);
    assert.equal(done.contextSelected,false);assert.equal(done.projectId,'project-a');
    assert.equal(f.context.capture().kind,'none');assert.equal(creates,1);assert.equal(queries,2);
  }finally{await resumed.close();}
});
