import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {installTaskResearch,taskResearchPlugins,taskResearchTools} from '../tasks/task-research.mjs';
import {readJson} from '../tasks/agent-files.mjs';

function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'nova-task-research-')),scopes=[];
  t.after(()=>{for(const scope of scopes)scope.close();rmSync(home,{recursive:true,force:true});});
  function start(taskId,runId,permission='full'){
    const workspace=join(home,taskId,'workspace');mkdirSync(workspace,{recursive:true});
    const config={policyVersion:2,taskId,runId,sessionId:'session-'+taskId,permission,
      agentHome:join(home,taskId),runDir:join(home,'runs',runId),workspace,goal:'整理公开资料',
      research:{enabled:true,available:true,httpAvailable:true}};
    const hooks=new Map(),contexts=[];
    const ctx={on:(name,fn)=>{const rows=hooks.get(name)??[];rows.push(fn);hooks.set(name,rows);},systemPrompt:{context:value=>contexts.push(value)}};
    const scope=installTaskResearch(ctx,config);scopes.push(scope);
    const emit=(type,data={},sessionId=config.sessionId)=>{for(const fn of hooks.get('session/event')??[])fn({id:sessionId},{type,data});};
    const call=(callId,tool='web_fetch',args={url:'https://example.com/source'})=>emit('tool/call',{callId,name:tool,arguments:JSON.stringify(args)});
    const result=(callId,{url='https://example.com/source',statusCode=200,content='Verified task source',isError=false,sources}={})=>emit('tool/result',{
      message:{role:'tool',toolCallId:callId,content:[{type:'text',text:content}],isError},meta:sources?{sources}:{url,statusCode}});
    return {...scope,config,emit,call,result,contexts,lookup:scope.sourceTool[3],evidence:()=>readJson(join(config.runDir,'research.json'))};
  }
  return {home,start};
}

test('native task web availability follows configured services without serializing credentials',()=>{
  const research={enabled:true,httpAvailable:true,available:false,childEnv:{DEEPSEEK_API_KEY:'must-not-persist'}};
  assert.deepEqual(taskResearchTools(research),['research_sources','web_fetch']);
  assert.deepEqual(taskResearchTools({...research,available:true}),['research_sources','web_search','web_fetch']);
  const plugins=taskResearchPlugins({harnessRoot:'/harness',research});
  assert.equal(plugins.find(p=>p.id==='tool-web').config.search,false);
  assert.equal(plugins.find(p=>p.id==='web').config.fetchProvider,'http');
  assert.doesNotMatch(JSON.stringify(plugins),/must-not-persist|research_exec|web_request/);
  assert.deepEqual(taskResearchPlugins({research:{enabled:false,httpAvailable:false,available:false}}),[]);
  assert.throws(()=>installTaskResearch({}, {policyVersion:1}),/requires_current_policy/);
});

test('task sources persist across runs and cannot read another employee task journal',t=>{
  const {home,start}=fixture(t),first=start('employee-one','run-one');
  first.call('search','web_search',{queries:['task-specific fact']});
  first.result('search',{sources:[{url:'https://example.com/source',snippet:'Search evidence'}]});
  first.call('fetch');first.result('fetch');
  assert.equal(first.lookup({}).sources.length,2);
  first.emit('turn/end',{reason:{kind:'completed'}});
  assert.equal(first.evidence().runId,'run-one');assert.equal(first.evidence().taskId,'employee-one');
  assert.equal(first.evidence().sources.length,2);assert.equal(first.evidence().research.usage.searchCalls,1);
  assert.equal(first.evidence().research.usage.fetchCalls,1);
  first.close();
  const resumed=start('employee-one','run-two','read-only');
  const remembered=resumed.lookup({}).sources;assert.equal(remembered.length,2);assert.equal(remembered[1].excerpt,'Verified task source');
  assert.equal(resumed.evidence().sources.length,2);
  assert.ok(resumed.contexts.some(c=>c.text().includes('当前为只读权限')));
  const unrelated=start('employee-two','run-three');
  assert.deepEqual(unrelated.lookup({}).sources,[]);
  assert.throws(()=>unrelated.lookup({requestId:'run-one'}),/source_not_found/);
  assert.throws(()=>unrelated.lookup({sourceIds:[remembered[0].id]}),/source_not_found/);
  assert.equal(existsSync(join(home,'bridge.sqlite')),false);
});

test('cancellation discards late sources and HTTP failures never become successful evidence',t=>{
  const {start}=fixture(t),scope=start('employee','cancelled');
  scope.call('failed');scope.result('failed',{statusCode:503,content:'Service unavailable'});
  assert.equal(scope.evidence().sources.length,0);
  scope.emit('tool/call',{name:'web_fetch',callId:'foreign',arguments:JSON.stringify({url:'https://example.com/foreign'})},'foreign-session');
  assert.equal(scope.ops.list('tool').length,1);
  scope.call('pending');scope.emit('turn/end',{reason:{kind:'aborted'}});
  scope.result('pending',{url:'https://example.com/late'});
  assert.equal(scope.evidence().sources.length,0);
  assert.equal(scope.ops.list('tool').find(r=>r.callId==='pending').status,'cancelled');
  assert.equal(scope.ops.list('tool').find(r=>r.callId==='failed').status,'failed');
  assert.throws(()=>scope.lookup({}),/closed/);
  scope.close();
});

test('failed and cancelled runs retain evidence already observed with the owning run identity',t=>{
  const {start}=fixture(t);
  for(const reason of ['error','aborted']){
    const scope=start('employee-'+reason,'run-'+reason);
    scope.call('observed');scope.result('observed');
    scope.call('unfinished');scope.emit('turn/end',{reason:{kind:reason}});scope.close();
    const evidence=scope.evidence();assert.equal(evidence.taskId,'employee-'+reason);assert.equal(evidence.runId,'run-'+reason);
    assert.equal(evidence.sources.length,1);assert.equal(evidence.sources[0].requestId,evidence.runId);
    assert.equal(evidence.sources[0].excerpt,'Verified task source');
  }
});
