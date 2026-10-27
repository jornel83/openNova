import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {browserSettings} from '../../desktop/settings.mjs';

test('managed browser config preserves external profile, with environment taking precedence',t=>{
 const dir=mkdtempSync(join(tmpdir(),'nova desktop config '));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const root=join(dir,'project');mkdirSync(join(root,'config'),{recursive:true});
 writeFileSync(join(root,'config/voice.local.json'),JSON.stringify({desktop:{browser_executable:'/Applications/browser',browser_user_data_dir:join(dir,'profile')}}));
 assert.equal(browserSettings({},root).profile,join(dir,'profile'));
 assert.equal(browserSettings({OPENNOVA_BROWSER_EXECUTABLE:'/other/browser'},root).executable,'/other/browser');
 assert.throws(()=>browserSettings({OPENNOVA_BROWSER_USER_DATA_DIR:join(root,'state')},root),/browser_profile_must_be_outside/);
 symlinkSync(root,join(dir,'escape'));
 assert.throws(()=>browserSettings({OPENNOVA_BROWSER_USER_DATA_DIR:join(dir,'escape/state')},root),/browser_profile_must_be_outside/);
});
