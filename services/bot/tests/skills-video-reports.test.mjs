import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,appendFileSync,rmSync,realpathSync,statSync,openSync,writeSync,closeSync,truncateSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {TeamReports} from '../team/reports.mjs';
import {VideoService} from '../skills/video.mjs';
import {normalizeReviewDecision,prepareReviewEvidence} from '../team/review.mjs';
import {saveJson} from '../tasks/agent-files.mjs';

const MiB=1024*1024;
function fixture(t,limits={}){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-video-reports-'))),workspace=join(home,'workspace'),agentHome=join(home,'agent'),jobDir=join(home,'job');
  for(const directory of [workspace,agentHome,jobDir])mkdirSync(directory);
  saveJson(join(agentHome,'workspace.json'),{path:workspace,kind:'general'});
  const db=new DatabaseSync(join(home,'state.sqlite'));
  const task={id:'video-task',kind:'agent',title:'Video report fixture',teamReportVersion:1,runId:'video-run',assignmentVersion:1,assignedBotId:'employee',permission:'full',policyVersion:2,status:'running',cwd:workspace};
  const run={id:task.runId,taskId:task.id,assignmentVersion:1,status:'running',skills:[{name:'video-production',version:'fixture'}]};
  const job={id:'video-job',taskId:task.id,runId:run.id,kind:'agent',status:'completed',cleanupConfirmed:true,exitCode:0,agentResult:{text:'Video delivered.'},artifacts:[]};
  const tasks={db,root:join(home,'tasks'),row:(kind,id)=>{const value=kind==='task'?task:kind==='run'?run:job;if(value.id!==id)throw Error('unknown_task');return value;},all:()=>[task],agentHome:()=>agentHome,directory:()=>jobDir};
  let resultStatus='completed',sequence=0;
  const video=new VideoService({db,home,tasks,transport:async({args})=>({status:resultStatus,path:args.config.output,size_bytes:statSync(args.config.output).size})});tasks.video=video;
  const reports=new TeamReports(tasks,limits);tasks.reports=reports;
  t.after(async()=>{await video.close();db.close();rmSync(home,{recursive:true,force:true});});
  const receipt=async(path,status='completed')=>{resultStatus=status;return video.execute({taskId:task.id,runId:run.id,stepId:'edit-'+(++sequence),name:'video_edit',args:{config:{clips:[{path}],output:path}}});};
  const capture=()=>{task.status='completed';run.status='completed';return reports.capture(task,run,job);};
  return {home,workspace,task,run,job,tasks,video,reports,receipt,capture};
}

function largePlayableVideo(path){
  const generated=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=24','-t','0.5','-c:v','libx264',path],{encoding:'utf8'});
  assert.equal(generated.status,0,generated.stderr);
  // A valid MP4 free box pads real on-disk media beyond the old 20 MiB limit.
  const padding=Buffer.alloc(21*MiB-statSync(path).size);padding.writeUInt32BE(padding.length,0);padding.write('free',4);appendFileSync(path,padding);
  assert.equal(statSync(path).size,21*MiB);
  assert.equal(spawnSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1',path],{stdio:'ignore'}).status,0);
}

test('a real 21 MiB video receives an independent snapshot and supports manual, not automatic, acceptance',async t=>{
  const f=fixture(t),source=join(f.workspace,'result.mp4');largePlayableVideo(source);await f.receipt(source);
  const report=f.capture(),file=report.artifacts[0];
  assert.equal(report.artifacts.length,1,'the persisted receipt adds media even if directory scanning omitted it');
  assert.equal(file.media,true);assert.equal(file.status,'available');assert.equal(file.sourceStatus,'available');assert.equal(file.size,21*MiB);
  assert.notEqual(file.path,source);assert.notEqual(statSync(file.path).ino,statSync(source).ino,'snapshot must not be a hard link');
  const decision={action:'accept',summary:'Human reviewed the delivered video.',evidenceIds:[file.id]};
  assert.throws(()=>normalizeReviewDecision(decision,report),/review_artifact_not_readable/);
  assert.equal(normalizeReviewDecision(decision,report,{manual:true}).action,'accept');
  const evidenceDirectory=prepareReviewEvidence({report,task:f.task,directory:join(f.home,'review')});
  const evidence=JSON.parse(readFileSync(join(evidenceDirectory,'report.json'),'utf8'));assert.equal(evidence.artifacts[0].reviewContent,'unavailable');assert.equal(evidence.artifacts[0].path,undefined);
  const fd=openSync(source,'r+');try{writeSync(fd,Buffer.from([127]),0,1,100);}finally{closeSync(fd);}
  const changed=f.reports.get(report.id,{fresh:true});assert.equal(changed.artifacts[0].status,'available');assert.equal(changed.artifacts[0].sourceStatus,'changed');
  assert.throws(()=>f.reports.assertCurrent(f.task,report.id),/artifact_changed/);
  assert.equal(f.reports.artifact({id:f.task.id,reportId:report.id,artifactId:file.id}).path,file.path,'the historical immutable snapshot stays openable');
});

test('only a successful receipt for this task and Run grants the large-media allowance',async t=>{
  for(const scenario of ['unrecorded','old-run','other-task','failed']){
    await t.test(scenario,async t=>{
      const f=fixture(t),path=join(f.workspace,'result.mp4');writeFileSync(path,Buffer.alloc(21*MiB));
      if(scenario!=='unrecorded'){
        await f.receipt(path,scenario==='failed'?'failed':'completed');
        if(['old-run','other-task'].includes(scenario)){
          const action=JSON.parse(f.video.db.prepare('SELECT body FROM task_video_action').get().body);
          f.video.put('action',{...action,...scenario==='old-run'?{runId:'older-run'}:{taskId:'other-task'}});
        }
      }
      f.job.artifacts=[{name:'result.mp4',path}];const report=f.capture();
      assert.equal(report.artifacts[0].status,'too_large');assert.equal(report.artifacts[0].media,undefined);
      assert.throws(()=>normalizeReviewDecision({action:'accept',summary:'Do not accept an uncaptured output.'},report,{manual:true}),/not_ready_for_acceptance/);
    });
  }
});

test('trusted canonical external video output is snapshotted only under Full Access',async t=>{
  const f=fixture(t),outside=join(f.home,'external');mkdirSync(outside);const path=join(outside,'external.mp4');writeFileSync(path,Buffer.alloc(21*MiB));await f.receipt(path);
  const report=f.capture();assert.equal(report.artifacts[0].status,'available');assert.equal(report.artifacts[0].sourcePath,path);assert.equal(report.artifacts[0].media,true);
  const other=fixture(t),target=join(other.home,'untrusted.mp4');writeFileSync(target,'not a recorded delivery');other.job.artifacts=[{name:'external.mp4',path:target}];
  assert.equal(other.capture().artifacts[0].status,'changed','a matching-looking filename does not authorize an outside path');
  const scoped=fixture(t),scopedPath=join(scoped.home,'scoped.mp4');writeFileSync(scopedPath,'recorded media');await scoped.receipt(scopedPath);scoped.task.permission='read-only';
  assert.equal(scoped.capture().artifacts[0].status,'changed','a receipt does not expand current filesystem permissions');
});

test('media receipts cannot authorize redirected or replaced file paths',async t=>{
  const f=fixture(t),path=join(f.workspace,'result.mp4'),outside=join(f.home,'other.mp4');writeFileSync(path,'original');await f.receipt(path);writeFileSync(outside,'different');rmSync(path);symlinkSync(outside,path);
  const report=f.capture();assert.equal(report.artifacts[0].status,'changed');assert.equal(report.artifacts[0].path,undefined);
  const changed=fixture(t),replacement=join(changed.workspace,'result.mp4');writeFileSync(replacement,'initial');await changed.receipt(replacement);appendFileSync(replacement,'replaced');
  assert.equal(changed.capture().artifacts[0].status,'changed','receipt size must match the captured source');
});

test('video-specific file and total limits remain explicit while ordinary file limits stay unchanged',async t=>{
  const f=fixture(t);assert.equal(f.reports.maxMediaFileBytes,512*MiB);assert.equal(f.reports.maxMediaTotalBytes,1024*MiB);assert.equal(f.reports.maxFileBytes,20*MiB);assert.equal(f.reports.maxTotalBytes,64*MiB);
  const oversized=join(f.workspace,'oversized.mp4');writeFileSync(oversized,'');truncateSync(oversized,512*MiB+1);await f.receipt(oversized);
  const report=f.capture();assert.equal(report.artifacts[0].status,'too_large');assert.equal(report.artifacts[0].path,undefined,'oversized media is rejected before copying or hashing its contents');
  const total=fixture(t,{maxFileBytes:10,maxTotalBytes:16,maxMediaFileBytes:32,maxMediaTotalBytes:48});
  for(const name of ['one.mp4','two.mp4']){const path=join(total.workspace,name);writeFileSync(path,Buffer.alloc(32));await total.receipt(path);}
  for(const name of ['one.txt','two.txt']){const path=join(total.workspace,name);writeFileSync(path,Buffer.alloc(9));total.job.artifacts.push({name,path});}
  const limited=total.capture();assert.deepEqual(limited.artifacts.filter(file=>file.name.endsWith('.mp4')).map(file=>file.status).sort(),['available','too_large']);
  assert.deepEqual(limited.artifacts.filter(file=>file.name.endsWith('.txt')).map(file=>file.status).sort(),['available','too_large']);
});
