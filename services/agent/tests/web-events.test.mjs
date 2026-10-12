import test from 'node:test';import assert from 'node:assert/strict';
import {VoiceControl} from '../voice-control.mjs';
import {SourceBook,projectWebReply,WebEvents} from '../web-events.mjs';
const source={url:'https://example.com/report',title:'报告'};
test('web mode suppresses every attempt delta; legacy still streams',()=>{
 const events=[],c=new VoiceControl(e=>events.push(e),{web:true});c.arm(1,'s');const agent={session:{id:'s'}};
 for(const attemptId of ['one','two','three']){c.frame(agent,{type:'start',attemptId});c.frame(agent,{type:'chunk',attemptId,chunk:{type:'text-delta',text:'工具前说明'}});}
 assert.equal(events.length,0);c.finish();
});
test('verified bare URLs retain citations beside sentence punctuation',()=>{
 const b=new SourceBook();b.add([source]);
 for(const suffix of ['.',',',';',':','!','?']) {
  const text=`See https://example.com/report${suffix}`;
  const r=projectWebReply(text,b);assert.equal(r.text,text);assert.equal(r.sources[0]?.url,source.url);
  assert.equal(r.speechText,`See ${suffix}`);
 }
 const r=projectWebReply('See (https://example.com/report).',b);
 assert.equal(r.text,'See (https://example.com/report).');assert.equal(r.sources.length,1);
 assert.equal(projectWebReply('Ignore https://invented.example/report.',b).text,'Ignore .');
});
test('balanced parentheses remain in verified Markdown and bare URL destinations',()=>{
 const url='https://en.wikipedia.org/wiki/Transformer_(deep_learning)',b=new SourceBook();b.add([{url}]);
 const text=`Read [Transformer](${url}).`;
 const r=projectWebReply(text,b);assert.equal(r.text,text);assert.equal(r.sources[0]?.url,url);assert.equal(r.speechText,'Read Transformer.');
 const bare=projectWebReply(`See (${url}).`,b);assert.equal(bare.sources[0]?.url,url);assert.equal(bare.text,`See (${url}).`);
 assert.equal(projectWebReply(`See [${url}](${url}).`,b).speechText,'See en.wikipedia.org.');
});
test('only structured successful results become sources; old or cancelled requests stay silent',()=>{
 const events=[],book=new SourceBook();let current={id:1};const e=new WebEvents({book,current:()=>current,send:v=>events.push(v)});
 const old=current;e.result(old,{name:'web_search'},{meta:{sources:[source]},isError:false});assert.equal(book.items().length,1);
 current={id:2};e.result(old,{name:'web_fetch'},{meta:{url:'https://example.com/old',statusCode:200}});
 e.result(current,{name:'web_fetch'},{meta:{url:'https://example.com/denied',statusCode:403}});
 current.cancelled=true;e.result(current,{name:'web_search'},{meta:{sources:[{url:'https://example.com/late'}]}});
 assert.equal(events.length,1);assert.equal(book.items().length,1);
});
test('follow-up cites retained actual sources, not invented URLs; original history stays untouched',()=>{
 const b=new SourceBook();b.add([source],'search');b.add([source],'fetch');
 const text='参考[报告](https://example.com/report)，[虚构](https://example.net/no) [99]。';
 const reply=projectWebReply(text,b);assert.equal(reply.sources.length,1);assert.equal(reply.sources[0].retrieval,'fetch');assert.ok(!reply.text.includes('example.net'));assert.ok(!reply.text.includes('[99]'));assert.match(reply.speechText,/报告/);assert.ok(!reply.speechText.includes('https'));
 assert.ok(text.includes('example.net'));
});
test('a URL used as a Markdown link label cannot swallow its own destination',()=>{
 const b=new SourceBook();b.add([{url:'https://example.com/'}],'fetch');
 const text='来自 [https://example.com/](https://example.com/) 网页正文。';
 const r=projectWebReply(text,b);assert.equal(r.text,text);assert.equal(r.speechText,'来自 example.com 网页正文。');
});
