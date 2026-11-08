import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import * as desktop from '../../desktop/start.mjs';

test('configured browser launches the paired profile and extension, including paths with spaces',async t=>{
 const root=mkdtempSync(join(tmpdir(),'nova paired browser '));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const executable=join(root,'browser'),record=join(root,'argv.json'),profile=mkdtempSync(join(tmpdir(),'nova browser profile '));
 t.after(()=>rmSync(profile,{recursive:true,force:true}));
 // Publish the fixture receipt only after its contents are fully written.
 writeFileSync(executable,`#!${process.execPath}\nconst fs=require('node:fs'),record=${JSON.stringify(record)};fs.writeFileSync(record+'.tmp',JSON.stringify(process.argv.slice(2)));fs.renameSync(record+'.tmp',record);`,{mode:0o700});
 await desktop.openChrome('http://127.0.0.1:18564/',{root,env:{OPENNOVA_BROWSER_EXECUTABLE:executable,OPENNOVA_BROWSER_USER_DATA_DIR:profile}});
 for(let i=0;i<100&&!existsSync(record);i++)await delay(20);
 assert.deepEqual(JSON.parse(readFileSync(record,'utf8')),[
  '--no-first-run','--no-default-browser-check',
  '--user-data-dir='+profile,'--load-extension='+join(root,'extensions/browser'),
  '--disable-extensions-except='+join(root,'extensions/browser'),'http://127.0.0.1:18564/',
 ]);
});

test('configured browser needs an explicit profile and reports a missing executable',async()=>{
 await assert.rejects(desktop.openChrome(undefined,{root:'/tmp/nova',env:{OPENNOVA_BROWSER_EXECUTABLE:'/missing/browser'}}),/OPENNOVA_BROWSER_USER_DATA_DIR/);
 await assert.rejects(desktop.openChrome(undefined,{root:'/tmp/nova',env:{OPENNOVA_BROWSER_EXECUTABLE:'/missing/browser',OPENNOVA_BROWSER_USER_DATA_DIR:'/tmp/nova-profile'}}),/ENOENT/);
});
