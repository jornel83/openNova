import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ROOT} from '../../runtime/sources.mjs';
import {archiveBundle,captureBundle} from '../skills/bundle.mjs';
import {TASK_MEDIA_OPERATIONS,TASK_MEDIA_TOOLS,allowedTaskTools} from '../tasks/execution.mjs';
import {taskMediaDefinitions} from '../tasks/media-tools.mjs';

const fakePin={name:'image-production',archiveRoot:'/fake/archive',version:'fake-pin'};
const mediaConfig={permission:'full',policyVersion:2,mode:'edit',bridge:{scoped:true},skills:[fakePin,{name:'video-production'}]};
const mediaNames=config=>allowedTaskTools(config).filter(name=>TASK_MEDIA_TOOLS.includes(name));

test('only the approved media operation is exposed to the bound editable Run',()=>{
  for(const operation of TASK_MEDIA_OPERATIONS){
    const config={...mediaConfig,media:{operation}},expected=[operation,'project_media_characters','task_media_status',...(operation==='gif_generate'?['gif_review']:[])];
    assert.deepEqual(mediaNames(config),expected);
    for(const alternate of ['video_submit','write','edit','task_command','task_check','browser_click'])
      assert.ok(!allowedTaskTools({...config,checksEnabled:true,hostTools:['browser_click']}).includes(alternate));
    for(const invalid of [{permission:'read-only'},{policyVersion:1},{bridge:{}},{managementReview:{}},{summaryRecovery:{}},{skills:[{name:'image-production'}]},{media:undefined}]){
      assert.deepEqual(mediaNames({...config,...invalid}),[]);
    }
  }
  assert.ok(allowedTaskTools(mediaConfig).includes('video_submit'),'unchanged standalone video lane');
});

test('API definitions come from an immutable version and include valid nested export fields',t=>{
  const home=mkdtempSync(join(tmpdir(),'nova-media-tools-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const snapshot=archiveBundle(home,captureBundle(join(ROOT,'skills/image-production'),{root:ROOT,source:'bundled'}));
  const config={...mediaConfig,skills:[snapshot],media:{operation:'media_export'}};
  const tools=taskMediaDefinitions(config);
  assert.deepEqual(tools.map(([name])=>name),['media_export','project_media_characters','task_media_status']);
  const params=tools[0][2];
  assert.equal(params.outputPath.required,true);
  assert.deepEqual(params.outputScope.enum,['task','project']);
  assert.equal(params.frames.items.additionalProperties,false);
  assert.equal(params.frames.items.properties.path.required,true);
  assert.equal(params.frames.items.properties.durationMs.type,'integer');
  const [imageTool]=taskMediaDefinitions({...config,media:{operation:'image_generate'}});
  assert.ok(imageTool[2].provider.enum.includes('spark'));assert.ok(imageTool[2].model.enum.includes('minimax-h3-image'));
  const schema=join(snapshot.archiveRoot,'tools/image/tool-definitions.json');
  chmodSync(schema,0o600);writeFileSync(schema,'[]');
  assert.throws(()=>taskMediaDefinitions(config),/skill_snapshot_changed/);
});
