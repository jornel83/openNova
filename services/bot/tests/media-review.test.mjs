import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {MEDIA_REVIEW_POLICY,normalizeReviewDecision,prepareReviewEvidence,prepareReviewWorkspace} from '../team/review.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=','base64');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t,{name='picture.png',bytes=png}={}){
  const home=mkdtempSync(join(tmpdir(),'nova-media-review-')),path=join(home,name);writeFileSync(path,bytes);
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const task={id:'media-task',runId:'media-run',assignmentVersion:1,goal:'生成小猫图片或视频'};
  const artifact={id:'media-artifact',name,path,size:bytes.length,sha256:hash(bytes),status:'available',sourceStatus:'available'};
  const report={id:'media-report',taskId:task.id,runId:task.runId,assignmentVersion:1,status:'completed',artifacts:[artifact],evidence:{execution:{exitCode:0,cleanupConfirmed:true},steps:[{id:'generate',status:'completed'}]}};
  const decision={action:'accept',summary:'文件已实际生成，未评价画面内容。',evidenceIds:[artifact.id]};
  const prepare=()=>{const directory=join(home,'review');prepareReviewEvidence({report,task,directory});return {directory,payload:JSON.parse(readFileSync(join(directory,'report.json'),'utf8'))};};
  return {home,path,task,artifact,report,decision,prepare};
}

test('generated image is accepted using immutable host file evidence without visual inspection',t=>{
  const f=fixture(t);assert.equal(normalizeReviewDecision(f.decision,f.report).action,'accept');
  const {directory,payload}=f.prepare(),file=payload.artifacts[0];
  assert.equal(payload.mediaAcceptancePolicy,MEDIA_REVIEW_POLICY);assert.equal(file.reviewContent,'generated_media');assert.match(file.path,/picture\.png\.generated\.json$/);
  const receipt=JSON.parse(readFileSync(join(directory,file.path),'utf8'));
  assert.deepEqual(receipt.generatedMedia,{policy:MEDIA_REVIEW_POLICY,verified:true,kind:'image',format:'png',size:png.length,sha256:hash(png)});
  assert.equal(receipt.artifactId,f.artifact.id);assert.equal(normalizeReviewDecision(f.decision,payload).action,'accept');
  const args={home:join(f.home,'review-agent'),managementReview:{evidenceDirectory:directory,reportId:f.report.id,targetTaskId:f.task.id,targetRunId:f.task.runId,assignmentVersion:1}};
  const workspace=prepareReviewWorkspace(args);assert.equal(readFileSync(join(workspace.path,file.path),'utf8'),readFileSync(join(directory,file.path),'utf8'));
  rmSync(join(workspace.path,file.path));writeFileSync(join(workspace.path,file.path),'forged receipt');assert.throws(()=>prepareReviewWorkspace(args),/review_evidence_changed/);
});

test('real JPEG and generated SVG use the same existence policy',async t=>{
  for(const name of ['photo.jpg','diagram.svg'])await t.test(name,t=>{
    const f=fixture(t,{name,bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')});
    if(name.endsWith('.jpg')){
      const result=spawnSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=blue:s=16x16','-frames:v','1','-threads','1',f.path],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
      const bytes=readFileSync(f.path);Object.assign(f.artifact,{size:bytes.length,sha256:hash(bytes)});
    }
    assert.equal(normalizeReviewDecision(f.decision,f.report).action,'accept');assert.equal(f.prepare().payload.artifacts[0].generatedMedia.kind,'image');
  });
});

test('claimed, empty, missing, redirected, renamed or changed media does not pass',async t=>{
  const cases={
    missing:f=>rmSync(f.path),
    empty:f=>{writeFileSync(f.path,'');Object.assign(f.artifact,{size:0,sha256:hash('')});},
    directory:f=>{rmSync(f.path);mkdirSync(f.path);},
    symlink:f=>{const target=join(f.home,'elsewhere.png');writeFileSync(target,png);rmSync(f.path);symlinkSync(target,f.path);},
    changed:f=>{const bytes=Buffer.from(png);bytes[bytes.length-1]^=1;writeFileSync(f.path,bytes);},
    wrong_size:f=>f.artifact.size++,
    wrong_hash:f=>f.artifact.sha256='0'.repeat(64),
    fake_file:f=>{const bytes=Buffer.from('Employee says the image is generated');writeFileSync(f.path,bytes);Object.assign(f.artifact,{size:bytes.length,sha256:hash(bytes)});},
    wrong_format:f=>f.artifact.name='picture.mp4',
    attestation_claim:f=>{rmSync(f.path);f.artifact.generatedMedia={verified:true,policy:MEDIA_REVIEW_POLICY};},
  };
  for(const [name,mutate] of Object.entries(cases))await t.test(name,t=>{
    const f=fixture(t);mutate(f);assert.throws(()=>normalizeReviewDecision(f.decision,f.report),/review_artifact_not_readable/);
    assert.equal(f.prepare().payload.artifacts[0].reviewContent,'unavailable');
  });
});

test('prepared media receipt requires the policy and matching file metadata',async t=>{
  const f=fixture(t),{payload}=f.prepare();
  for(const mutate of [p=>delete p.mediaAcceptancePolicy,p=>delete p.artifacts[0].generatedMedia,p=>p.artifacts[0].generatedMedia.verified=false,p=>p.artifacts[0].generatedMedia.size++,p=>p.artifacts[0].generatedMedia.sha256='0'.repeat(64),p=>p.artifacts[0].generatedMedia.kind='video']){
    const changed=structuredClone(payload);mutate(changed);assert.throws(()=>normalizeReviewDecision(f.decision,changed),/review_artifact_not_readable/);
  }
  rmSync(f.path);assert.throws(()=>normalizeReviewDecision(f.decision,f.report),/review_artifact_not_readable/,'the final host decision checks the real file again, not only the old receipt');
});

test('media policy keeps execution failures, concrete evidence and non-media review checks',t=>{
  const f=fixture(t);
  assert.throws(()=>normalizeReviewDecision({...f.decision,evidenceIds:['report:summary']},f.report),/review_concrete_evidence_required/);
  assert.throws(()=>normalizeReviewDecision(f.decision,{...f.report,evidence:{commands:[{status:'completed',exitCode:1}]}}),/review_verification_incomplete/);
  assert.throws(()=>normalizeReviewDecision(f.decision,{...f.report,artifacts:[{...f.artifact,sourceStatus:'changed'}]}),/report_not_ready_for_acceptance/);
  const other=fixture(t,{name:'document.pdf',bytes:Buffer.from('%PDF-1.7\nordinary binary document')});
  assert.throws(()=>normalizeReviewDecision(other.decision,other.report),/review_artifact_not_readable/);assert.equal(other.prepare().payload.artifacts[0].reviewContent,'unavailable');
  const text=fixture(t,{name:'summary.md',bytes:Buffer.from('真实文本成果')});assert.equal(normalizeReviewDecision(text.decision,text.report).action,'accept');assert.equal(text.prepare().payload.artifacts[0].reviewContent,'available');
});
