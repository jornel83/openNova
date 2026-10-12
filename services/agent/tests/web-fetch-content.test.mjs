import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadSettings} from '../settings.mjs';
import {createContentFetcher} from '../web-fetch-content.mjs';
const root=loadSettings().harnessRoot;
const {formatFetchOutput}=await import(pathToFileURL(join(root,'packages/web/tool-web/lib/index.js')));
const page=html=>({url:'https://example.com/report',statusCode:200,body:{kind:'html',content:html},truncated:false});

test('late article survives long HTML boilerplate while final model text stays bounded',async()=>{
 const p=await createContentFetcher(root);
 // Only replace the external network operation; use real extraction and native tool rendering.
 p.transport.fetch=async()=>page('<html><head><script>'+ 'x'.repeat(45000) +'</script></head><body><nav>'+Array.from({length:250},(_,i)=>`<a href="/nav${i}">栏目${i}</a>`).join(' ')+'</nav><article><h1>市场收盘</h1><p>2026-10-12 收盘：测试指数 12345.67 点。</p><table><tr><th>指数</th><th>点位</th></tr><tr><td>测试指数</td><td>12345.67</td></tr></table></article><footer>尾部</footer></body></html>');
 const result=await p.fetch({url:'https://example.com/report'});
 const rendered=formatFetchOutput(result,12000);
 assert.match(rendered,/12345\.67/);assert.match(rendered,/2026-10-12/);
 assert.doesNotMatch(rendered,/栏目249|xxxxxx|<script>/);
 assert.ok(rendered.length<=12000);
});
test('empty truncated pages fail clearly; HTTP blocks and cancellation remain explicit',async()=>{
 const p=await createContentFetcher(root);
 p.transport.fetch=async()=>({...page('<title>Weather</title>'),truncated:true});
 await assert.rejects(p.fetch({url:'https://example.com'}),/web_page_body_unavailable/);
 p.transport.fetch=async()=>({...page('<p>Request blocked</p>'),statusCode:418});
 assert.equal((await p.fetch({url:'https://example.com'})).statusCode,418);
 const c=new AbortController();c.abort();
 await assert.rejects(p.fetch({url:'https://example.com'},c.signal),e=>e.name==='AbortError');
});
test('content fetch keeps native public URL policy',async()=>{
 const p=await createContentFetcher(root);
 for(const url of ['http://127.0.0.1/','http://192.168.1.1/','file:///etc/passwd'])await assert.rejects(p.fetch({url}));
});
