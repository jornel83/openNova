import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {ROOT} from '../../runtime/sources.mjs';
import {archiveBundle,captureBundle,IMAGE_EXECUTOR_RESOURCES,LEGACY_IMAGE_EXECUTOR_RESOURCES} from '../skills/bundle.mjs';
import {imageRuntimeEnv} from '../images/runtime.mjs';
import {installedImagePython} from '../images/runtime-path.mjs';
import {pinImageRuntime,runImageGenerator} from '../images/runner.mjs';

function fixtures(t){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-image-pin-')));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const root=join(home,'checkout'),skill=join(root,'skills','image-production');
  mkdirSync(skill,{recursive:true});
  writeFileSync(join(skill,'SKILL.md'),'---\nname: image-production\ndescription: Test skill\n---\n\nImage production.\n');
  for(const file of IMAGE_EXECUTOR_RESOURCES){
    const out=join(root,file);mkdirSync(dirname(out),{recursive:true});copyFileSync(join(ROOT,file),out);
  }
  const archive=()=>archiveBundle(home,captureBundle(skill,{root,source:'bundled'}));
  return {root,home,archive};
}

test('an archived executor still exports after its checkout implementation changes',async t=>{
  const {root,home,archive}=fixtures(t),saved=archive();
  writeFileSync(join(root,'tools/image/tool.py'),'raise AssertionError("changed implementation")\n');
  assert.notEqual(archive().version,saved.version);
  const sourcePath=join(home,'preview.png'),outputPath=join(home,'first.png');
  writeFileSync(sourcePath,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGN0qzjxn4GBgYEJRIAwACYGAokYTrXWAAAAAElFTkSuQmCC','base64'));
  const result=await runImageGenerator({tool:'media_export',arguments:{action:'first_frame',sourcePath,outputPath},
    context:{operationId:'pinned-fixture',workspace:home,stateDir:join(home,'journals')}},{snapshot:saved});
  assert.equal(result.status,'completed',JSON.stringify(result.error));
  assert.equal(result.runtime.skillVersion,saved.version);
  assert.equal(result.runtime.pillow,'13.0.0');
  assert.equal(result.runtime.requirementsSha256,saved.resources.find(file=>file.path.endsWith('requirements.lock.txt')).sha256);
  assert.ok(readFileSync(outputPath).length>32);
  assert.deepEqual(readdirSync(saved.archiveRoot,{recursive:true}).filter(path=>path.includes('__pycache__')),[]);
});

test('an unmanifested file blocks startup before Python can import it',t=>{
  const {archive}=fixtures(t),saved=archive();
  const cache=join(saved.archiveRoot,'tools/image/__pycache__');mkdirSync(cache);
  writeFileSync(join(cache,'tool.cpython-311.pyc'),'untracked code');
  assert.throws(()=>pinImageRuntime(saved),/skill_snapshot_changed/);
});

test('lock changes select a different environment and override cannot bypass version validation',t=>{
  const {root,archive}=fixtures(t),saved=archive(),lockPath=join(root,'tools/image/requirements.lock.txt');
  const installed=process.env.OPENNOVA_IMAGE_PYTHON||installedImagePython();
  const original=readFileSync(lockPath);
  const changed=Buffer.from('pillow==0.0.1\n');writeFileSync(lockPath,changed);
  assert.notEqual(installedImagePython(changed),installedImagePython(original));
  assert.notEqual(archive().version,saved.version);
  const previous=process.env.OPENNOVA_IMAGE_PYTHON;process.env.OPENNOVA_IMAGE_PYTHON=installed;
  t.after(()=>{if(previous===undefined)delete process.env.OPENNOVA_IMAGE_PYTHON;else process.env.OPENNOVA_IMAGE_PYTHON=previous;});
  assert.throws(()=>pinImageRuntime(archive()),/image_runtime_incompatible/);
  const local=pinImageRuntime(saved,{credentials:false});
  assert.ok(!['ARK_API_KEY','OPENNOVA_IMAGE_ARK_KEY_FILE','OPENNOVA_IMAGE_REPOSITORY_ROOT'].some(key=>key in local.env));
});

test('Spark uses SSH connection settings, while Ark credentials stay scoped to the cloud provider',()=>{
  const source={ARK_API_KEY:'fixture-cloud-key',OPENNOVA_IMAGE_ARK_KEY_FILE:'fixture-key-file',
    OPENNOVA_SPARK_SSH_HOST:'fixture-spark',SSH_AUTH_SOCK:'/tmp/test-agent'};
  const local=imageRuntimeEnv({spark:true,source}),cloud=imageRuntimeEnv({source});
  assert.equal(local.SSH_AUTH_SOCK,source.SSH_AUTH_SOCK);assert.equal(local.OPENNOVA_SPARK_SSH_HOST,source.OPENNOVA_SPARK_SSH_HOST);
  assert.ok(!('ARK_API_KEY' in local)&&!('OPENNOVA_IMAGE_ARK_KEY_FILE' in local));
  assert.equal(cloud.ARK_API_KEY,source.ARK_API_KEY);assert.ok(!('SSH_AUTH_SOCK' in cloud));
});

test('older image skill snapshots still pin their original executor; Spark requires the complete new archive',t=>{
  const {root,home}=fixtures(t);
  const bundle=captureBundle(join(root,'skills/image-production'),{root,source:'bundled'});
  for(const key of IMAGE_EXECUTOR_RESOURCES.filter(key=>!LEGACY_IMAGE_EXECUTOR_RESOURCES.includes(key)))bundle.files.delete(key);
  const incomplete=archiveBundle(home,bundle);
  assert.throws(()=>pinImageRuntime(incomplete,{spark:true}),/invalid_image_executor_snapshot/);
  const path='tools/image/tool-definitions.json';
  const defs=JSON.parse(bundle.files.get(path));
  const fields=defs.find(item=>item.function.name==='image_generate').function.parameters.properties;
  fields.provider.enum=['ark'];fields.model.enum=fields.model.enum.filter(value=>value!=='minimax-h3-image');
  bundle.files.set(path,Buffer.from(JSON.stringify(defs)));
  const old=archiveBundle(home,bundle);
  assert.equal(pinImageRuntime(old).runtime.skillVersion,old.version);
  assert.throws(()=>pinImageRuntime(old,{spark:true}),/image_snapshot_model_unavailable/);
});
