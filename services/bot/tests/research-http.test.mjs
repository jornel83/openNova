import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createSources} from '../research/sources.mjs';
const http=await import('../research/http.mjs').catch(()=>({}));
function fixture(t,status=200,content='{"date":"2026-10-23","price":1}'){
 const root=mkdtempSync(join(tmpdir(),'research-http-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const rows=new Map();
 const ops={put:r=>rows.set(r.id,r),list:k=>[...rows.values()].filter(r=>r.kind===k)};const sources=createSources({ops,botId:'b',workspace:root});
 const transport={async fetchWithOptions({url},options){return {url,statusCode:options.headers.referer?'200'*1:status,contentType:'application/javascript; charset=GB18030',encoding:'gb18030',replacementCount:0,truncated:false,body:{kind:'text',content}};}};
 return {root,rows,sources,run:http.createResearchHttp({transport,sources,ops,artifactRoot:root})};
}
const context=()=>({requestId:'r1',callId:'c1',origin:'tool',signal:new AbortController().signal});
test('referer_fetch_records_real_response and legacy_sources_still_read',async t=>{
 assert.equal(typeof http.createResearchHttp,'function');const f=fixture(t,403);
 const r=await f.run({url:'https://finance.example/api',headers:{Referer:'https://finance.example/'}},context());
 assert.equal(r.statusCode,200);assert.equal(r.quality.state,'usable');assert.equal(r.encoding,'gb18030');assert.ok(r.artifactHash);
 const [source]=f.sources.forRequest('r1');assert.equal(source.evidenceType,'api_response');assert.equal(source.statusCode,200);assert.equal(source.observationId,r.observationId);
 assert.equal(readFileSync(r.artifactPath,'utf8'),' {"date":"2026-10-23","price":1}'.trim());
 f.sources.record({requestId:'old',url:'https://example.com',status:'completed',evidenceType:'search_summary'});assert.equal(f.sources.forRequest('old')[0].evidenceType,'search_summary');
});
test('502_never_becomes_evidence',async t=>{
 assert.equal(typeof http.createResearchHttp,'function');const f=fixture(t,502,'Bad gateway');const r=await f.run({url:'https://example.com/api'},context());
 assert.equal(r.statusCode,502);assert.equal(r.ok,false);assert.equal(f.sources.forRequest('r1').length,0);assert.equal(f.rows.get(r.receiptId).status,'failed');
});
test('javascript_payload_is_text and json_dates_preserved',async t=>{
 assert.equal(typeof http.createResearchHttp,'function');const f=fixture(t,200,'globalThis.RESEARCH_TEST_EXECUTED=true;');const r=await f.run({url:'https://example.com/q'},context());
 assert.equal(globalThis.RESEARCH_TEST_EXECUTED,undefined);assert.match(r.excerpt,/RESEARCH_TEST/);
 const bad=await f.run({url:'https://example.com/q',responseType:'json'},context());assert.equal(bad.error,'invalid_json');
 const j=fixture(t);const good=await j.run({url:'https://example.com/q',responseType:'json'},context());assert.match(good.excerpt,/2026-10-23/);
});
test('invalid headers and cancellation never create a receipt',async t=>{
 assert.equal(typeof http.createResearchHttp,'function');const f=fixture(t);
 await assert.rejects(f.run({url:'https://example.com',headers:{Cookie:'secret'}},context()),/header/);
 const c=new AbortController();c.abort();await assert.rejects(f.run({url:'https://example.com'}, {...context(),signal:c.signal}));assert.equal(f.rows.size,0);
});
test('research schemas compile through the actual Harness tool compiler',async()=>{
 const {loadSettings}=await import('../../agent/settings.mjs');const {pathToFileURL}=await import('node:url');
 const {defineTool}=await import(pathToFileURL(join(loadSettings().harnessRoot,'packages/core/tools/lib/index.js')));
 const {httpTool}=await import('../research/http-tool.mjs');const {executionTool}=await import('../research/exec.mjs');const {derivationTool}=await import('../research/derivation.mjs');
 for(const [name,description,parameters] of [httpTool,executionTool,derivationTool])assert.doesNotThrow(()=>defineTool({name,description,parameters,output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},execute:async()=>''}));
});
test('a 600KB JSON response remains parseable in the artifact while the model excerpt is bounded',async t=>{
 const {createServer}=await import('node:http');const {createContentFetcher}=await import('../../agent/web-fetch-content.mjs');const {loadSettings}=await import('../../agent/settings.mjs');
 const content=JSON.stringify({data:'x'.repeat(600000)}),server=createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(content);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const provider=await createContentFetcher(loadSettings().harnessRoot,async()=>[{address:'127.0.0.1',family:4}]);
 const f=fixture(t),ops={put:r=>f.rows.set(r.id,r)};
 const run=http.createResearchHttp({transport:provider.transport,sources:f.sources,ops,artifactRoot:f.root});
 const receipt=await run({url:`http://example.com:${server.address().port}/`,responseType:'json'},context());
 assert.equal(receipt.ok,true);assert.equal(receipt.truncated,false);assert.equal(receipt.excerpt.length,11000);
 assert.equal(JSON.parse(readFileSync(receipt.artifactPath,'utf8')).data.length,600000);
});
