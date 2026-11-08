import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {videoCredential} from '../skills/credentials.mjs';
test('video credentials read external files or injected environment without copying them into source',t=>{
  const home=mkdtempSync(join(tmpdir(),'nova-video-key-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const root=join(home,'source');mkdirSync(root);writeFileSync(join(home,'key'),'offline-key\n');
  assert.equal(videoCredential({root,path:join(home,'key'),env:{}}),'offline-key');
  assert.equal(videoCredential({root,path:join(home,'missing'),env:{}}),'');
  assert.equal(videoCredential({root,path:join(home,'missing'),env:{ARK_API_KEY:'injected-key'}}),'injected-key');
  writeFileSync(join(root,'key'),'must-stay-external');symlinkSync(join(root,'key'),join(home,'alias'));
  assert.throws(()=>videoCredential({root,path:join(root,'key'),env:{}}),/must_be_external/);
  assert.throws(()=>videoCredential({root,path:join(home,'alias'),env:{}}),/must_be_external/);
});
