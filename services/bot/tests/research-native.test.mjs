import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {loadResearchConfig,researchTools} from '../research/config.mjs';
import {researchPlugins} from '../research/plugins.mjs';
import {loadSettings} from '../../agent/settings.mjs';
import {installResearch} from '../research/runtime.mjs';

function config(t,web={enabled:true,limits:{searchCalls:1,fetchMs:1}},env={}) {
 const dir=mkdtempSync(join(tmpdir(),'native-research-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const configFile=join(dir,'voice.json'),secretsFile=join(dir,'secrets.json');
 writeFileSync(configFile,JSON.stringify({web}));writeFileSync(secretsFile,JSON.stringify({web:{deepseek_api_key:'fixture-key'}}));
 return loadResearchConfig({env,configFile,secretsFile});
}
test('native default ignores old research caps and exposes native tools plus source recall',t=>{
 const c=config(t);assert.equal(c.mode,'native');assert.equal(c.available,true);assert.equal(c.limits,undefined);
 assert.deepEqual(researchTools(['bash','read'],c),['bash','read','research_sources','web_search','web_fetch']);
 const plugins=researchPlugins({enabled:true,mode:c.mode});
 assert.equal(plugins.find(p=>p.id==='web').config.fetchProvider,'http');
 assert.equal(plugins.find(p=>p.id==='web-fetch-http').name,'@deepseek-ai/dsh-web-fetch-http');
 assert.deepEqual(plugins.find(p=>p.id==='web-search-deepseek').config,{});
 assert.deepEqual(plugins.find(p=>p.id==='tool-web').config,{search:true,fetch:true,searchTimeoutMs:60000});
});
test('explicit rollback restores legacy tools and caps without leaking credentials',t=>{
 const c=config(t,{enabled:true},{OPENNOVA_RESEARCH_MODE:'legacy'});
 assert.equal(c.mode,'legacy');assert.equal(c.limits.fetchCalls,6);
 assert.ok(researchTools(['bash'],c).includes('research_exec'));
 const plugins=researchPlugins({harnessRoot:'/harness',enabled:true,mode:c.mode});
 assert.equal(plugins.find(p=>p.id==='web').config.fetchProvider,'opennova-http');
});

// Native contracts, using real DSH tools/formatters; only remote provider IO is replaced.
const require=createRequire(join(loadSettings().harnessRoot,'packages/bundle/base/package.json'));
const moduleOf=name=>import(pathToFileURL(require.resolve(name)).href);
test('native tools return empty snippets, HTTP errors and later successes without product policy',async()=>{
 const {Context}=await moduleOf('@deepseek-ai/cordis');
 const {default:SystemPrompt}=await moduleOf('@deepseek-ai/dsh-system-prompt');
 const {default:Tools}=await moduleOf('@deepseek-ai/dsh-tools');
 const {default:Web}=await moduleOf('@deepseek-ai/dsh-web');
 const ToolWeb=await moduleOf('@deepseek-ai/dsh-tool-web');
 const ctx=new Context(),fibers=[];
 const mount=async(plugin,options)=>{const f=ctx.plugin(plugin,options);fibers.push(f);await f;};
 try {
  await mount(SystemPrompt);await mount(Tools);await mount(Web,{searchProvider:'fixture-search',fetchProvider:'fixture-http'});
  ctx.web.registerSearchProvider({id:'fixture-search',available:()=>true,search:async()=>({sources:[{url:'https://example.com/weather',title:'天气'}],truncated:false})});
  ctx.web.registerFetchProvider({id:'fixture-http',available:()=>true,fetch:async({url})=>({url,statusCode:url.endsWith('/bad')?503:200,body:{kind:'text',content:url.endsWith('/bad')?'Service unavailable':'Verified fixture weather'},truncated:false})});
  await mount(ToolWeb,{search:true,fetch:true,searchTimeoutMs:60000});
  const call=(name,args)=>ctx.tools.execute({name,arguments:args,callId:crypto.randomUUID(),signal:new AbortController().signal});
  for(let i=0;i<3;i++){const r=await call('web_search',{queries:['weather '+i]});assert.equal(r.isError,false);assert.equal(r.meta.sources[0].snippet,undefined);}
  const bad=await call('web_fetch',{url:'https://example.com/bad'});assert.equal(bad.value.statusCode,503);assert.match(bad.content[0].text,/503/);
  const ok=await call('web_fetch',{url:'https://example.com/good'});assert.match(ok.content[0].text,/Verified fixture weather/);
 } finally {for(const f of fibers.reverse())await f.dispose();}
});
test('observer consumes the installed DSH tool-result message envelope',async()=>{
 const {createToolResultMessage}=await moduleOf('@deepseek-ai/dsh-llm');
 const rows=new Map(),hooks={},r={id:'r',sessionId:'s',signal:new AbortController().signal},requests={active:r};
 const ops={put:v=>rows.set(v.id,v),finish(){},list:k=>[...rows.values()].filter(v=>v.kind===k)};
 const runtime=installResearch({on:(n,f)=>hooks[n]=f,systemPrompt:{context(){}}},{ops,requests,config:{mode:'native'}});runtime.begin(r);
 try{
  hooks['session/event']({id:'s'},{type:'tool/call',data:{callId:'native-call',name:'web_search',arguments:JSON.stringify({queries:['test']})}});
  hooks['session/event']({id:'s'},{type:'tool/result',data:{message:createToolResultMessage({callId:'native-call',content:[{type:'text',text:'Sources'}],isError:false}),meta:{sources:[{url:'https://example.com',snippet:'Native evidence'}]}}});
  assert.equal(runtime.sources.forRequest('r')[0].excerpt,'Native evidence');assert.equal(ops.list('tool')[0].status,'completed');
  assert.deepEqual(runtime.sources.forRequest('r')[0].queries,['test']);
 }finally{runtime.close();}
});
