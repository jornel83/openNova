/** Exercise our selected native tools with actual local filesystem/process backends. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,readFileSync,chmodSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {loadSettings} from '../../agent/settings.mjs';
import {PROJECT_PLUGINS} from '../project.mjs';
const root=loadSettings().harnessRoot,require=createRequire(join(root,'packages/bundle/base/package.json'));
const moduleOf=name=>import(pathToFileURL(name==='@deepseek-ai/dsh-bash-local'?join(root,'packages/shell/bash-local/lib/index.js'):require.resolve(name)).href);
const {Context}=await moduleOf('@deepseek-ai/cordis');
async function fixture(t){
 const cwd=realpathSync(mkdtempSync(join(tmpdir(),'nova-native-'))),ctx=new Context();
 t.after(async()=>{await ctx.fiber.dispose();rmSync(cwd,{recursive:true,force:true});});
 for(const name of ['llm','session','session-projection','system-prompt','fs-local','working-directory','tools','agent','agent-loop','subprocess-local','shell-env','bash-local']){
  const m=await moduleOf('@deepseek-ai/dsh-'+name);await ctx.plugin(m.default??m,name==='agent-loop'?{agents:[]}:{});
 }
 for(const p of PROJECT_PLUGINS.filter(p=>p.id!=='agent-instructions')){const m=await moduleOf(p.name);await ctx.plugin(m.default??m,p.config??{});}
 const agent=await ctx.agentLoop.create('native-project-test',{}, {cwd});let call=0;
 const execute=(name,args,signal=new AbortController().signal)=>ctx.tools.execute({name,arguments:args,agent,signal,callId:'test-'+ ++call});
 return {cwd,ctx,agent,execute};
}
test('native tools browse, search, read and edit real files, preserving executable mode',async t=>{
 const {cwd,execute}=await fixture(t);
 writeFileSync(join(cwd,'run.sh'),'#!/bin/sh\necho before\n');chmodSync(join(cwd,'run.sh'),0o755);
 let r=await execute('glob',{pattern:'**/*.sh'});assert.equal(r.isError,false);assert.ok(r.value.paths.includes('run.sh'));
 r=await execute('grep',{pattern:'before'});assert.equal(r.isError,false);assert.equal(r.value.matches[0].lineNumber,2);
 r=await execute('read',{file_path:'run.sh'});assert.equal(r.isError,false);
 r=await execute('edit',{file_path:'run.sh',old_string:'before',new_string:'after'});assert.equal(r.isError,false);assert.match(r.value.after,/after/);assert.equal(statSync(join(cwd,'run.sh')).mode&0o777,0o755);
 r=await execute('write',{file_path:'nested/new.txt',content:'created'});assert.equal(r.isError,false);assert.equal(readFileSync(join(cwd,'nested/new.txt'),'utf8'),'created');
 r=await execute('bash',{command:'pwd; ./run.sh; printf error >&2; exit 7',description:'execute project fixture'});assert.equal(r.isError,false,JSON.stringify(r));assert.equal(r.value.cwd,cwd);assert.equal(r.value.exitCode,7);assert.match(r.value.stdout.text,/after/);assert.equal(r.value.stderr.text,'error');
});
test('native foreground shell timeout and cancellation end commands and their children',async t=>{
 const {cwd,execute}=await fixture(t);
 for(const mode of ['timeout','cancel']){
  const ac=new AbortController();
  const args={description:mode,command:`(sleep 2; touch ${mode}-leak) & wait`,...(mode==='timeout'?{timeoutMs:150}:{})};
  const running=execute('bash',args,ac.signal);
  if(mode==='cancel')setTimeout(()=>ac.abort(),150);
  const r=await running;
  if(mode==='timeout'){assert.equal(r.isError,false,JSON.stringify(r));assert.equal(r.value.timedOut,true);}else assert.ok(r.value?.aborted||r.error?.info?.code==='ABORTED',JSON.stringify(r));
 }
 await new Promise(r=>setTimeout(r,2300));
 assert.equal(existsSync(join(cwd,'timeout-leak')),false);assert.equal(existsSync(join(cwd,'cancel-leak')),false);
});
