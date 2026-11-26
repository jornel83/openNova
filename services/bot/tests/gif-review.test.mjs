import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Operations} from '../operations.mjs';
import {createGifReviewer} from '../images/review.mjs';

const gif=Buffer.from('R0lGODlhAQABAIABAAAAAP///yH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==','base64');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const checked=[0,8,16,24,32,40,48,56,64];

function fixture(t,{native,sample}={}){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-gif-review-'))),workspace=join(home,'workspace');
  const ops=new Operations({home,workspace});t.after(()=>{ops.close();rmSync(home,{recursive:true,force:true});});
  const path=join(workspace,'伍宝.gif');writeFileSync(path,gif);
  const state={projectId:'project-w',revision:1,focus:'work'};
  const current={kind:'file',file:{path:join(workspace,'当前.png')}};
  const req={id:'request-1',projectId:state.projectId,binding:{...state,cwd:workspace,context:current}};
  const projects={state:()=>state,project:()=>({workspace}),validateExpected(expected){
    if(expected.projectId!==state.projectId||expected.revision!==state.revision)throw Error('project_state_changed');return state;
  }};
  const saved=ops.put({id:'op-1',kind:'tool',operation:'gif_generate',status:'completed',projectId:state.projectId,
    artifacts:{gif:{path,bytes:gif.length,format:'gif',sha256:hash(gif)}}});
  const calls={sample:0,native:0};
  const g=createGifReviewer({ops,projects,getRequest:()=>req,
    readNative:async params=>{calls.native++;assert.equal(params.mime,'image/png');assert.deepEqual(params.bytes,png);assert.match(params.question,/仅包含索引 0、8/);
      return native?native(params,state):{status:'read',content:JSON.stringify({checkedFrameIndices:checked,verdict:'deviation',conclusion:'动作偏慢。'}),limitation:null};},
    sample:async params=>{calls.sample++;assert.deepEqual(params.bytes,gif);return sample?sample(params):{frames:65,indices:checked,timestampsMs:checked.map(i=>i*100),sha256:hash(gif),png};}});
  return {g,ops,req,state,current,home,workspace,path,saved,calls};
}

test('GIF review uses only an immutable PNG contact sheet and reports exact reviewed frames without changing the current file',async t=>{
  const f=fixture(t),input={operationId:f.saved.id,question:'看伍宝的无奈动作是否过快。'};
  const result=await f.g.review(input,{callId:'first'});
  assert.equal(result.source.sha256,hash(gif));assert.equal(result.source.operationId,f.saved.id);
  assert.equal(result.visualReview.totalFrames,65);assert.deepEqual(result.visualReview.checkedFrameIndices,checked);
  assert.equal(result.visualReview.coverage,'png_contact_sheet');assert.equal(result.visualReview.status,'sampled');
  assert.equal(result.visualReview.verdict,'deviation');assert.equal(result.visualReview.reviewer.kind,'model');
  assert.match(result.visualReview.limitation,/未播放原 GIF/);
  assert.equal(f.ops.get(f.saved.id).visualReview.reviewOperationId,result.id);
  assert.equal(f.req.binding.context,f.current);
  assert.deepEqual(await f.g.review(input,{callId:'first'}),result);
  assert.deepEqual(f.calls,{native:1,sample:1});
});

test('actual decode but an unavailable reader remains not checked; foreign or modified bytes never reach sampling',async t=>{
  const f=fixture(t,{native:()=>{throw Error('secret transport data');}});
  const unavailable=await f.g.review({path:'伍宝.gif'},{callId:'model-fails'});
  assert.equal(unavailable.visualReview.status,'not_checked');assert.deepEqual(unavailable.visualReview.checkedFrameIndices,[]);
  assert.ok(!JSON.stringify(unavailable).includes('secret transport data'));
  f.ops.put({...f.saved,projectId:'other'});
  assert.equal((await f.g.review({operationId:f.saved.id},{callId:'wrong-project'})).error,'project_state_changed');
  f.ops.put(f.saved);writeFileSync(f.path,Buffer.alloc(gif.length));
  assert.equal((await f.g.review({operationId:f.saved.id},{callId:'edited'})).error,'image_artifact_changed');
  const external=join(f.home,'external.gif');writeFileSync(external,gif);symlinkSync(external,join(f.workspace,'外部.gif'));
  assert.equal((await f.g.review({path:'外部.gif'},{callId:'linked'})).error,'gif_review_source_unavailable');
  assert.deepEqual(f.calls,{native:1,sample:1});
});

test('a reader cannot attest unsupported frame indices; switched projects cannot receive a late review',async t=>{
  const f=fixture(t,{native:()=>({status:'read',content:'{"checkedFrameIndices":[0,1],"verdict":"matches","conclusion":"完成"}',limitation:null})});
  const value=await f.g.review({path:'伍宝.gif'},{callId:'wrong-frames'});
  assert.equal(value.error,'gif_review_invalid_model_receipt');assert.deepEqual(value.visualReview.checkedFrameIndices,[]);
  const stale=fixture(t,{native:(a,state)=>{state.revision++;return {status:'partial',content:'{"checkedFrameIndices":[0],"verdict":"uncertain","conclusion":"只读了首帧"}',limitation:null};}});
  const interrupted=await stale.g.review({operationId:stale.saved.id},{callId:'late'});
  assert.equal(interrupted.error,'project_state_changed');assert.equal(interrupted.visualReview.status,'not_checked');
  assert.equal(stale.ops.get(stale.saved.id).visualReview,undefined);
});
