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

test('packaged browser reads external configuration and rejects a profile inside the app',t=>{
 const dir=mkdtempSync(join(tmpdir(),'nova packaged browser '));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const app=join(dir,'OpenNova.app'),root=join(app,'Contents/Resources/app'),data=join(dir,'user data');
 mkdirSync(root,{recursive:true});mkdirSync(join(data,'config'),{recursive:true});
 writeFileSync(join(data,'config/voice.local.json'),JSON.stringify({desktop:{browser_executable:'/Applications/browser',browser_user_data_dir:join(data,'browser profile')}}));
 const env={OPENNOVA_PACKAGED:'1',OPENNOVA_APP_DATA:data};
 assert.equal(browserSettings(env,root).profile,join(data,'browser profile'));
 assert.throws(()=>browserSettings({...env,OPENNOVA_BROWSER_USER_DATA_DIR:join(app,'Contents/Resources/browser profile')},root),/packaged_state_must_be_outside_application/);
});
