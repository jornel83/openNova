import test from 'node:test';import assert from 'node:assert/strict';
import {join} from 'node:path';import {pathToFileURL} from 'node:url';
import {loadSettings} from '../settings.mjs';
const root=loadSettings().harnessRoot;
const moduleAt=p=>import(pathToFileURL(join(root,p,'lib/index.js')));
const {ExaSearchProvider}=await moduleAt('packages/web/web-search-exa');
const {HttpFetchProvider}=await moduleAt('packages/web/web-fetch-http');
const {apply:toolWeb}=await moduleAt('packages/web/tool-web');
const exa=()=>new ExaSearchProvider({apiKey:'synthetic-exa',baseURL:'https://api.exa.ai',searchType:'auto',highlightsPerResult:1,numResults:5});
test('actual Web plugin registers exactly the two allowed tools',()=>{
 const registered=[];const ctx={tools:{register:t=>registered.push(t)},systemPrompt:{section:()=>{},getSectionOrder:()=>0}};
 toolWeb(ctx,{search:true,fetch:true,searchMaxResults:5,searchMaxQueries:1,searchTimeoutMs:15000,fetchTimeoutMs:10000,fetchMaxOutputChars:12000});
 assert.deepEqual(registered.map(t=>t.name),['web_search','web_fetch']);assert.deepEqual(registered.map(t=>t.timeoutMs),[15000,10000]);
});
test('Exa empty result and 401/429 failures stay structured; caller signal reaches fetch',async t=>{
 const signal=new AbortController().signal;
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(options.signal,signal);assert.equal(JSON.parse(options.body).numResults,5);return Response.json({results:[]});});
 assert.deepEqual(await exa().search({query:'test',maxResults:5},signal),{sources:[],truncated:false});
 for(const status of [401,429]){globalThis.fetch=async()=>Response.json({error:'synthetic failure'},{status});await assert.rejects(exa().search({query:'test'}),e=>e.code==='WEB_PROVIDER_ERROR');}
 globalThis.fetch=async()=>{throw new DOMException('aborted','AbortError');};await assert.rejects(exa().search({query:'test'},signal),e=>e.code==='WEB_ABORTED');
});
test('HTTP fetch rejects private and loopback URLs with production policy',async()=>{
 const p=new HttpFetchProvider({maxResponseBytes:1000,maxBodyChars:500,timeoutMs:100,maxRedirects:1,userAgent:'opennova-test'});
 for(const url of ['http://127.0.0.1/','http://192.168.1.1/','http://[::1]/','file:///etc/passwd'])await assert.rejects(p.fetch({url}));
 const c=new AbortController();c.abort();await assert.rejects(p.fetch({url:'https://example.com'},c.signal),e=>e.code==='WEB_ABORTED');
});
test('HTTP 403 remains explicit in the actual tool result; cancellation passes through',async()=>{
 const tools=[];const signal=new AbortController().signal;
 const ctx={tools:{register:t=>tools.push(t)},systemPrompt:{section:()=>{},getSectionOrder:()=>0},web:{fetch:async({url},s)=>{assert.equal(s,signal);return {url,statusCode:403,body:{kind:'text',content:'denied'},truncated:false};}}};
 toolWeb(ctx,{search:false,fetch:true,searchMaxResults:5,searchMaxQueries:1,searchTimeoutMs:15000,fetchTimeoutMs:10000,fetchMaxOutputChars:12000});
 const tool=tools[0],value=await tool.execute({url:'https://example.com'},{signal});
 assert.equal(tool.output.presentationMeta({},value).statusCode,403);assert.match(tool.output.render({},value)[0].text,/HTTP 403/);
 ctx.web.fetch=async()=>{throw new DOMException('aborted','AbortError');};
 await assert.rejects(tool.execute({url:'https://example.com'},{signal}),e=>e.name==='AbortError');
});
