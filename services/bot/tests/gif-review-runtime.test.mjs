import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,realpathSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {ROOT} from '../../runtime/sources.mjs';
import {installedImagePython} from '../images/runtime.mjs';
import {lifecycleHost} from './fixtures/lifecycle-host.mjs';

test('real project conversation stages GIF frames with the pinned executor and records only visual-confirmed PNG indices',{timeout:60000},async t=>{
  const installed=installedImagePython(),legacy=join(ROOT,'output/image/runtime/ark-py311/bin/python');
  const python=process.env.OPENNOVA_IMAGE_PYTHON||(existsSync(installed)?installed:legacy);
  assert.ok(existsSync(python),'Install the image skill runtime or provide OPENNOVA_IMAGE_PYTHON');
  const hostEnv={OPENNOVA_IMAGE_PYTHON:python};
  const f=await lifecycleHost(t,{hostEnv,nativeFileReaderModule:'gif-review-reader.mjs'});
  hostEnv.OPENNOVA_GIF_REVIEW_TRACE=join(realpathSync(f.home),'png-trace.log');
  const workspace=realpathSync(f.workspace),path=join(workspace,'伍宝.gif');
  const animation=spawnSync(python,['-I','-B','-c',`from PIL import Image
import sys
images=[Image.new('RGB',(20,16),(i*15,0,80)) for i in range(12)]
images[0].save(sys.argv[1], 'GIF', save_all=True, append_images=images[1:], duration=100, loop=0)`,path],{encoding:'utf8'});
  assert.equal(animation.status,0,animation.stderr);
  await f.start();
  const project=(await f.api('/project-action',{action:'create',actionId:'review-new-project',name:'伍宝审阅',directory:workspace})).result;
  const initial=await f.api('/projects');
  await f.api('/project-action',{action:'select',actionId:'review-new-selected',projectId:project.id,focus:'work',revision:initial.state.revision});
  const ctx=(await f.api('/snapshot')).workContext;
  await f.foreground('review-w-b','gif_review',{path:'伍宝.gif',question:'看看伍宝的手势。'});
  const rows=async()=>(await f.api('/operations')).filter(r=>r.operation==='gif_review');
  const row=(await rows())[0];assert.equal(row.status,'completed',JSON.stringify(row));
  const review=row.visualReview;
  assert.equal(review.sourceSha256,createHash('sha256').update(readFileSync(path)).digest('hex'));
  assert.equal(review.contactSheetSha256,readFileSync(hostEnv.OPENNOVA_GIF_REVIEW_TRACE,'utf8').trim());
  assert.equal(review.totalFrames,12);assert.equal(review.status,'partial');assert.deepEqual(review.checkedFrameIndices,[0,11]);
  assert.equal(review.sampledFrameIndices.length,9);assert.match(review.limitation,/未播放原 GIF/);
  assert.equal(row.skillVersion,row.runtime.skillVersion);assert.equal(row.runtime.pillow,'13.0.0');
  assert.deepEqual((await f.api('/snapshot')).workContext,ctx);
  const neighbor=join(realpathSync(f.home),'neighbor');mkdirSync(neighbor);
  const second=(await f.api('/project-action',{action:'create',actionId:'review-other-project',name:'其他项目',directory:neighbor})).result;
  await f.api('/project-action',{action:'select',actionId:'review-other-selected',projectId:second.id,focus:'work',revision:(await f.api('/projects')).state.revision});
  await f.foreground('review-wrong-project','gif_review',{path,question:'看看伍宝的手势。'});
  assert.equal((await rows())[0].status,'failed');
  assert.equal(readFileSync(hostEnv.OPENNOVA_GIF_REVIEW_TRACE,'utf8').trim().split('\n').length,1);
});
