import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Operations} from '../operations.mjs';
import {botSettings,ROOT} from '../settings.mjs';
import {bindProject,settleBot,cancelBot,staleRequest,auditTool,recoverToolRuns,PROJECT_PLUGINS} from '../project.mjs';

function fixture(t){
 const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-project-'))),workspace=join(home,'repo'),legacyWorkspace=join(home,'project');
 mkdirSync(workspace);mkdirSync(legacyWorkspace);
 const ops=new Operations({home,workspace,legacyWorkspace});
 t.after(()=>{ops.close();rmSync(home,{recursive:true,force:true});});
 return {home,workspace,legacyWorkspace,ops};
}
test('default workspace is the real repo, independently of Bot state home',()=>{
 assert.equal(botSettings({OPENNOVA_BOT_HOME:'/tmp/example'}).workspace,ROOT);
});
test('binding an existing Bot preserves its conversation and gives future parts the same root and full access',async t=>{
 const {workspace}=fixture(t),events=[],saved=[];
 const session={id:'original'};
 const bot={id:'original',segments:[{sessionId:'earlier'}]},state={workspaceId:'old'};
 const ctx={workspaceRegistry:{resolveByPath:async()=>undefined,create:async(path)=>({id:'repo',path})},workingDirectory:{get:()=>'/old/project'}};
 const rt={state,chatOf:id=>id,resolveAgent:async()=>({session,whenIdle:async()=>{}}),setPermission:async(b,p)=>{b.permission=p;},save:async()=>saved.push(true),followFolder:async id=>events.push(id),switchJobs:()=>[]};
 await bindProject(ctx,rt,bot,workspace);
 assert.equal(bot.id,'original');assert.equal(bot.segments[0].sessionId,'earlier');
 assert.equal(bot.workDir,workspace);assert.equal(bot.permission,'danger-full-access');assert.equal(state.workspaceId,'repo');
 assert.deepEqual(events,['original']);assert.ok(saved.length);
 assert.deepEqual(PROJECT_PLUGINS.find(p=>p.id==='tool-bash').config,{enableRunInBackground:false,promoteOnTimeout:false});
});
test('legacy pending file edits cannot be replayed into the real repo',t=>{
 const {ops,home,workspace,legacyWorkspace}=fixture(t);
 writeFileSync(join(workspace,'brief.md'),'real');writeFileSync(join(legacyWorkspace,'brief.md'),'test');
 const proposal=ops.proposeFile('brief.md','changed','direct');
 delete proposal.workspace;ops.put(proposal);
 ops.close();const migrated=new Operations({home,workspace,legacyWorkspace});
 try{migrated.recoverDirectFiles();assert.equal(readFileSync(join(workspace,'brief.md'),'utf8'),'real');assert.equal(migrated.get(proposal.id).status,'failed');assert.throws(()=>migrated.approveFile(proposal.id),/workspace|pending/);}
 finally{migrated.close();ops.close=()=>{};}
});
test('native file audit uses actual before/after output and links to the originating request',async t=>{
 const {ops,workspace}=fixture(t),exec={name:'edit',callId:'c1',arguments:{file_path:'src/a.js'},signal:new AbortController().signal};
 const result={isError:false,value:{path:join(workspace,'src/a.js'),before:'old',after:'new'},content:[]};
 assert.equal(await auditTool(ops,exec,()=>Promise.resolve(result),{cwd:workspace,requestId:'r1'}),result);
 const row=ops.list('tool')[0];assert.equal(row.status,'applied');assert.equal(row.requestId,'r1');assert.equal(row.beforeContent,'old');assert.equal(row.content,'new');assert.equal(row.previewValid,true);
});
test('Shell output distinguishes nonzero exit, timeout, cancellation and success',async t=>{
 const {ops,workspace}=fixture(t);
 for(const [value,status] of [[{exitCode:0},'completed'],[{exitCode:2},'failed'],[{exitCode:null,timedOut:true},'timed_out'],[{exitCode:null,aborted:true},'cancelled']]){
  const exec={name:'bash',callId:status,arguments:{command:'node --test',description:'test'},signal:new AbortController().signal};
  await auditTool(ops,exec,async()=>({isError:false,value:{...value,cwd:workspace,stdout:{text:'x'.repeat(50000),truncated:true,spillPath:'/tmp/log'},stderr:{text:'err'}},content:[]}),{cwd:workspace,requestId:'req'});
  const row=ops.list('tool')[0];assert.equal(row.status,status);assert.equal(row.exitCode,value.exitCode);assert.equal(row.stderr,'err');assert.ok(row.stdout.length<50000);assert.equal(row.stdoutPath,'/tmp/log');
 }
});
test('crashed native operations are marked interrupted and never automatically rerun',async t=>{
 const {ops,workspace}=fixture(t);
 ops.put({id:'running',kind:'tool',status:'running',operation:'shell',command:'touch x',cwd:workspace});
 recoverToolRuns(ops);assert.equal(ops.get('running').status,'interrupted');
 const ac=new AbortController();ac.abort();
 await assert.rejects(auditTool(ops,{name:'bash',arguments:{},signal:ac.signal},async()=>{throw ac.signal.reason;},{cwd:workspace}),/abort/i);
 assert.equal(ops.list('tool')[0].status,'cancelled');
});
test('wait follows a native handoff to the new part and can cancel during maintenance',async()=>{
 let current='old',jobs=[],reads=0;
 const rt={chatOf:()=>current,switchJobs:()=>jobs,resolveAgent:async id=>({id,whenIdle:async()=>{
  reads++;if(id==='old'){jobs=[{botId:'b'}];setTimeout(()=>{current='new';jobs=[];},30);}
 }})};
 assert.equal((await settleBot(rt,{id:'b'})).id,'new');assert.equal(reads,2);
 jobs=[{botId:'b'}];const controller=new AbortController();setTimeout(()=>controller.abort(),20);
 await assert.rejects(settleBot(rt,{id:'b'},controller.signal),/abort/i);
});
test('cancel drains old/new parts and drops a late handoff from an earlier request',async()=>{
 let jobs=[{botId:'old',carry:[{source:{rpcId:'cancelled-request'}}]}],released=false;
 const calls=[],bot={id:'old',segments:[{sessionId:'old'}]};
 const rt={chatOf:()=> 'fresh',switchJobs:()=>jobs,resolveAgent:async id=>({cancel:()=>calls.push(id),whenIdle:async()=>{if(id==='old')await new Promise(r=>setTimeout(()=>{released=true;jobs=[];r();},30));}})};
 const pending=jobs[0];await cancelBot(rt,bot);
 assert.equal(released,true);assert.ok(calls.includes('old'));assert.ok(calls.includes('fresh'));assert.deepEqual(pending.carry,[]);
 assert.equal(staleRequest([{source:{rpcId:'cancelled-request'}}],{id:'new-request'}),true);
 assert.equal(staleRequest([{source:{rpcId:'new-request'}}],{id:'new-request'}),false);
});
test('large file audit preserves actual changed hunks instead of comparing identical tails',async t=>{
 const {ops}=fixture(t),tail='unchanged\n'.repeat(10000),diff={path:'/repo/a',oldText:'old header\nunchanged',newText:'new header\nunchanged'};
 await auditTool(ops,{name:'edit',arguments:{file_path:'a'},signal:new AbortController().signal},async()=>({isError:false,value:{path:'/repo/a',before:'old header\n'+tail,after:'new header\n'+tail},meta:{diffs:[diff]},content:[]}),{cwd:'/repo'});
 const row=ops.list('tool')[0];assert.deepEqual(row.diffs,[diff]);assert.equal(row.previewTruncated,true);assert.equal(row.previewValid,true);
});
test('an unavailable historical part cannot prevent cancellation of the current command',async()=>{
 const calls=[],bot={id:'archived',segments:[{sessionId:'missing'}]};
 const rt={chatOf:()=> 'current',switchJobs:()=>[],resolveAgent:async id=>{
  if(id!=='current')throw Error('Session unavailable');
  return {cancel:()=>calls.push(id),whenIdle:async()=>{}};
 }};
 await cancelBot(rt,bot);assert.ok(calls.includes('current'));
});
