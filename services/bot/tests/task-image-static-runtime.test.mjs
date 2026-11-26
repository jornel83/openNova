import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ROOT} from '../../runtime/sources.mjs';
import {installedImagePython} from '../images/runtime.mjs';
import {lifecycleHost} from './fixtures/lifecycle-host.mjs';

const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const plan=actions=>'M5_MEDIA_PLAN='+Buffer.from(JSON.stringify(actions)).toString('base64');

test('an editable employee creates a project image and edits a frozen reference into a separate task workspace',{timeout:90000},async t=>{
  const hostEnv={},f=await lifecycleHost(t,{hostEnv,provider:'task-image-media-provider.mjs'});
  const python=process.env.OPENNOVA_IMAGE_PYTHON??installedImagePython();
  const shim=join(f.home,'python-offline'),stub=join(ROOT,'services/bot/tests/fixtures/image-generation-offline.py'),key=join(f.home,'offline-key');
  writeFileSync(key,'test-only-offline-key\n',{mode:0o600});
  writeFileSync(shim,'#!/bin/sh\nif [ -n "${OPENNOVA_IMAGE_ARK_KEY_FILE-}" ]; then\ncase "$3" in */tools/image/tool.py) exec '+quote(python)+' -I -B '+quote(stub)+' "$@";; esac\nfi\nexec '+quote(python)+' "$@"\n',{mode:0o700});
  Object.assign(hostEnv,{OPENNOVA_IMAGE_PYTHON:shim,OPENNOVA_IMAGE_ARK_KEY_FILE:key});
  await f.start();const worker=await f.employee('静态图片员工');
  const catalog=await f.api('/skills',{botId:worker.id});
  await f.api('/skill-action',{action:'assign',actionId:'assign-static-image',botId:worker.id,names:['image-production'],revision:catalog.assignment.revision});
  const root=join(realpathSync(f.home),'static-project');mkdirSync(root);
  const project=(await f.api('/project-action',{action:'create',actionId:'create-static-project',name:'静态图项目',directory:root})).result;
  await f.api('/project-action',{action:'select',actionId:'select-static-project',projectId:project.id,focus:'work',revision:(await f.api('/projects')).state.revision});
  const ctx=(await f.api('/snapshot')).workContext;
  const settle=async id=>f.until(async()=>{
    const detail=await f.api('/background-task',{id});
    if(['failed','interrupted'].includes(detail.task.status))throw Error(JSON.stringify(detail.runs.at(-1)?.result));
    return detail.task.status==='completed'&&detail.task.cleanupConfirmed&&detail;
  },40000);
  const starter={kind:'agent',assignedBotId:worker.id,workspaceMode:'general',permission:'full',managementEnabled:false,skillNames:['image-production']};
  const initial={mode:'create',prompt:'元气满满',outputPath:'reference.png',outputScope:'project'};
  const firstInput={...starter,id:'employee-static-new',title:'新建项目原稿',goal:plan([['skill',{name:'image-production'}],['image_generate',initial],['image_generate',initial]]),
    media:{operation:'image_generate',outputPath:'reference.png'}};
  const denied=await f.api('/background-task-start',{...firstInput,id:'employee-static-readonly',permission:'read-only'},400);
  assert.equal(denied.error,'task_media_permission_denied');
  await f.api('/background-task-start',firstInput);
  const first=await settle(firstInput.id);
  assert.equal(first.task.projectId,project.id);
  assert.deepEqual(first.runs[0].jobs.map(({tool,status})=>[tool,status]),[['skill','completed'],['image_generate','completed'],['image_generate','completed']]);
  const original=join(root,'reference.png'),sourceHash=digest(original);
  assert.ok(first.teamReview.current.artifacts.some(file=>file.sourcePath===original&&file.sha256===sourceHash&&file.mediaRole==='image'));
  const secondInput={...starter,id:'employee-static-edit',title:'修改卫衣并保存新稿',goal:plan([['image_generate',{
    mode:'edit',prompt:'换白色圆领无帽卫衣',references:['reference.png'],outputPath:'edited.png',width:1024,height:512}]]),
    media:{operation:'image_generate',projectInputs:['reference.png']}};
  await f.api('/background-task-start',secondInput);
  const second=await settle(secondInput.id),files=second.teamReview.current.artifacts;
  assert.equal(files.length,1,JSON.stringify(files));
  assert.equal(files[0].mediaRole,'image');
  assert.equal(files[0].sourcePath,join(second.workspace.path,'edited.png'));
  assert.equal(files[0].sha256,digest(files[0].path));
  assert.notEqual(files[0].sha256,sourceHash);
  assert.equal(digest(original),sourceHash);
  assert.equal(existsSync(join(root,'edited.png')),false);
  assert.deepEqual((await f.api('/snapshot')).workContext,ctx);
  assert.deepEqual(readFileSync(join(f.home,'image-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse),[['post','create'],['post','edit']]);
});
