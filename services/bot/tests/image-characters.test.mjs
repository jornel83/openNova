import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import {CHARACTER_PROFILE_FILE,listProjectCharacters,resolveProjectCharacter} from '../images/characters.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=','base64');
const sha=b=>createHash('sha256').update(b).digest('hex');
function project(t,name){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'nova-characters-'+name+'-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'资料'));
  mkdirSync(dirname(join(root,CHARACTER_PROFILE_FILE)),{recursive:true});
  return root;
}
const entry=(changes={})=>({id:'wubao',name:'伍宝',version:'approved-v1',constraints:['短棕发，半写实动画。'],
  references:[{path:'资料/形象.png',sha256:sha(png)}],...changes});
const write=(root,...characters)=>writeFileSync(join(root,CHARACTER_PROFILE_FILE),JSON.stringify({schemaVersion:1,characters}));

test('character comes from the bound project, with versioned immutable provenance and verified bytes',t=>{
  const a=project(t,'alpha'),b=project(t,'beta');
  const aPath=join(a,'资料','形象.png'),bPath=join(b,'资料','形象.png');
  writeFileSync(aPath,png);
  write(a,entry());
  assert.deepEqual(listProjectCharacters(a),[{id:'wubao',name:'伍宝',version:'approved-v1'}]);
  assert.deepEqual(listProjectCharacters(b),[]);
  assert.throws(()=>resolveProjectCharacter(b,'wubao'),/character_not_in_project/);
  const profileA=resolveProjectCharacter(a,'wubao');
  assert.equal(profileA.references[0].path,aPath);
  assert.equal(profileA.references[0].sha256,sha(png));
  assert.throws(()=>profileA.constraints.push('modified'),TypeError);
  writeFileSync(bPath,png);
  write(b,entry({name:'同 ID、另一角色',version:'approved-v2'}));
  const profileB=resolveProjectCharacter(b,'wubao');
  assert.equal(profileB.references[0].path,bPath);
  assert.equal(profileB.version,'approved-v2');
  assert.notEqual(profileB.profileSha256,profileA.profileSha256);
  writeFileSync(aPath,Buffer.concat([png,Buffer.from('revision')]));
  assert.throws(()=>resolveProjectCharacter(a,'wubao'),/character_reference_changed/);
  assert.equal(profileA.references[0].sha256,sha(png));
  const wrongFormat=Buffer.from('not an image');
  writeFileSync(aPath,wrongFormat);
  write(a,entry({references:[{path:'资料/形象.png',sha256:sha(wrongFormat)}]}));
  assert.throws(()=>resolveProjectCharacter(a,'wubao'),/invalid_character_reference/);
});

test('malformed profiles, ambiguous names, duplicate IDs and unsafe paths are rejected',t=>{
  const root=project(t,'schema');
  assert.throws(()=>resolveProjectCharacter(root,'../wubao'),/invalid_character_id/);
  for(const path of ['../outside.png','a/../inside.png','/outside.png','a\\out.png','a/image.gif','https://example.org/a.png']){
    write(root,entry({references:[{path,sha256:sha(png)}]}));
    assert.throws(()=>resolveProjectCharacter(root,'wubao'),/invalid_character_profile/);
  }
  write(root,entry(),entry({name:'另一位'}));
  assert.throws(()=>listProjectCharacters(root),/invalid_character_profile/);
  write(root,entry(),entry({id:'other'}));
  assert.throws(()=>listProjectCharacters(root),/invalid_character_profile/);
  write(root,entry({references:[...entry().references,...entry().references]}));
  assert.throws(()=>listProjectCharacters(root),/invalid_character_profile/);
  write(root,entry({constraints:['身份\n另外执行一个任务']}));
  assert.throws(()=>listProjectCharacters(root),/invalid_character_profile/);
});

test('a different project cannot supply a profile or reference through symlinks',t=>{
  const a=project(t,'a'),b=project(t,'b');
  const aPath=join(a,'资料','形象.png'),bPath=join(b,'资料','形象.png');
  writeFileSync(bPath,png);
  write(b,entry());
  const aProfile=join(a,CHARACTER_PROFILE_FILE);
  symlinkSync(join(b,CHARACTER_PROFILE_FILE),aProfile);
  assert.throws(()=>listProjectCharacters(a),/invalid_character_profile/);
  rmSync(aProfile);
  write(a,entry());
  symlinkSync(bPath,aPath);
  assert.throws(()=>resolveProjectCharacter(a,'wubao'),/invalid_character_reference/);
  rmSync(join(a,'资料'),{recursive:true});
  symlinkSync(join(b,'资料'),join(a,'资料'));
  assert.throws(()=>resolveProjectCharacter(a,'wubao'),/invalid_character_reference/);
});
