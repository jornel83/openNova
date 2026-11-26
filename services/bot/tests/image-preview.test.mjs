import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBridge} from '../http.mjs';
import {createControls} from '../controls.mjs';
import {createWorkContext} from '../desktop/context.mjs';
import {generatedImageVersion} from '../images/preview.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
function setup(t){
  const workspace=realpathSync(mkdtempSync(join(tmpdir(),'nova-image-preview-')));
  t.after(()=>rmSync(workspace,{recursive:true,force:true}));
  const file={id:'file-version1',name:'言昕 v1.png',path:join(workspace,'言昕 v1.png'),projectId:'p1'};
  writeFileSync(file.path,png);
  const artifact={path:file.path,bytes:png.length,format:'png',sha256:createHash('sha256').update(png).digest('hex')};
  const record={id:'op-v1',projectId:'p1',kind:'tool',operation:'image_generate',status:'completed',file,artifact};
  const ops={get(id){assert.equal(id,record.id);return record;}};
  const expectedProject={projectId:'p1',revision:2};
  const state={...expectedProject,focus:'work'};
  const context=createWorkContext();
  let persisted;
  const projects={
    validateExpected(e){if(e.projectId!==state.projectId||e.revision!==state.revision)throw Error('project_state_changed');return state;},
    project:()=>({workspace}),saveContext(){persisted=context.capture();},
  };
  return {context,ops,projects,workspace,file,record,state,body:{operationId:record.id,expectedProject},saved:()=>persisted};
}

async function connectWeb(t,x,documents){
  const controls=createControls({...x,requests:{exclusive:action=>action()},documents});
  const server=createBridge({token:'unused',web:{assets:x.workspace},handle:controls});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  const post=(path,body,headers={})=>fetch(origin+path,{method:'POST',headers:{Origin:origin,'X-OpenNova-Web':'1','Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const session=await post('/web/session',{}),{csrf}=await session.json();
  const cookie={Cookie:session.headers.get('set-cookie').split(';')[0]};
  const auth={...cookie,'X-OpenNova-CSRF':csrf};
  return {post,cookie,auth};
}

test('authenticated image preview serves exact saved bytes, then selects a previous version for the next edit',async t=>{
  const x=setup(t);
  x.context.selectFile({id:'v2',path:join(x.workspace,'v2.png')});
  const openCalls=[];
  const {post,cookie,auth}=await connectWeb(t,x,{open(request){openCalls.push(request);return {status:'dispatched'};}});
  assert.equal((await post('/web/api/image-preview',x.body,cookie)).status,403);
  const response=await post('/web/api/image-preview',x.body,auth);
  assert.equal(response.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
  assert.equal(x.context.capture().file.id,'v2');
  const selected=await post('/web/api/image-select',x.body,auth);
  assert.equal((await selected.json()).file.id,x.file.id);
  assert.deepEqual(x.saved().file,x.file);
  const opened=await post('/web/api/image-open',x.body,auth);
  assert.equal(opened.status,200);
  assert.equal(openCalls[0].path,x.file.path);
  writeFileSync(x.file.path,Buffer.alloc(png.length));
  assert.equal((await (await post('/web/api/image-open',x.body,auth)).json()).error,'image_artifact_changed');
  assert.equal(openCalls.length,1);
});

test('preview rejects arbitrary paths, cross-project records, symlinks, and unfinished operations',async t=>{
  const x=setup(t);
  await assert.rejects(generatedImageVersion(x,{...x.body,path:'/tmp/other.png'}),/invalid_image_preview/);
  await assert.rejects(generatedImageVersion(x,{...x.body,expectedProject:{projectId:'p2',revision:2}}),/project_state_changed/);
  x.record.projectId='other';
  await assert.rejects(generatedImageVersion(x,x.body),/project_state_changed/);
  x.record.projectId='p1';x.record.status='running';
  await assert.rejects(generatedImageVersion(x,x.body),/image_preview_unavailable/);
  x.record.status='completed';
  writeFileSync(join(x.workspace,'moved.png'),png);unlinkSync(x.file.path);symlinkSync(join(x.workspace,'moved.png'),x.file.path);
  await assert.rejects(generatedImageVersion(x,x.body),/image_artifact_changed/);
});

test('GIF downloads are resolved by project, operation and artifact type while the selected image stays in place',async t=>{
  const x=setup(t);
  x.context.selectFile(x.file);
  const parts=[
    ['gif','gif','image/gif',Buffer.from('R0lGODlhAQABAIABAAAAAP///yH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==','base64')],
    ['firstFrame','png','image/png',png],
    ['video','mp4','video/mp4',Buffer.from('00000014667479706d703432000000006d703432','hex')],
  ];
  x.record.operation='gif_generate';
  delete x.record.file;
  x.record.artifacts=Object.fromEntries(parts.map(([part,format,,bytes])=>{
    const path=join(x.workspace,'言昕 GIF.'+format);
    writeFileSync(path,bytes);
    return [part,{path,format,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}];
  }));
  x.record.artifact=x.record.artifacts.gif;
  const opened=[];
  const {post,cookie,auth}=await connectWeb(t,x,{open:(command,options)=>{opened.push({command,options});return {status:'dispatched'};}});
  const gifBody={...x.body,artifact:'gif'};
  assert.equal((await post('/web/api/image-preview',gifBody,cookie)).status,403);
  for(const [part,,type,bytes] of parts){
    const result=await post('/web/api/image-preview',{...x.body,artifact:part},auth);
    assert.equal(result.status,200);
    assert.equal(result.headers.get('content-type'),type);
    assert.deepEqual(Buffer.from(await result.arrayBuffer()),bytes);
  }
  for(const action of ['image-open','image-select'])
    assert.equal((await (await post('/web/api/'+action,gifBody,auth)).json()).error,'invalid_image_preview');
  assert.equal((await post('/web/api/gif-open',x.body,cookie)).status,403);
  assert.equal((await (await post('/web/api/gif-open',gifBody,auth)).json()).error,'invalid_image_preview');
  assert.deepEqual(await (await post('/web/api/gif-open',x.body,auth)).json(),{status:'dispatched',path:x.record.artifacts.gif.path});
  assert.equal(opened.length,1);assert.equal(opened[0].command.path,x.record.artifacts.gif.path);assert.equal(opened[0].options.selectContext,false);
  assert.deepEqual(x.context.capture().file,x.file);
  for(const part of ['../outside','__proto__'])
    assert.equal((await (await post('/web/api/image-preview',{...x.body,artifact:part},auth)).json()).error,'invalid_image_preview');
  x.record.status='partial';
  assert.equal((await (await post('/web/api/image-preview',gifBody,auth)).json()).error,'image_preview_unavailable');
  x.record.status='completed';
  const video=x.record.artifacts.video;
  writeFileSync(video.path,Buffer.alloc(video.bytes));
  assert.equal((await (await post('/web/api/image-preview',{...x.body,artifact:'video'},auth)).json()).error,'image_artifact_changed');
  x.state.revision++;
  assert.equal((await (await post('/web/api/image-preview',gifBody,auth)).json()).error,'project_state_changed');
});
