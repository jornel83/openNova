import test from 'node:test';import assert from 'node:assert/strict';
import {projectResearchReply} from '../research/reply.mjs';
const s={id:'s1',url:'https://example.com/weather',evidenceType:'search_summary',observationId:'o1'};
test('unknown_citation_not_promoted_to_source and project_and_browser_links_survive_projection',()=>{
 const text='北京20℃，见[天气](https://example.com/weather)。[陌生](https://unknown.example/x)，[文件](docs/report.md)，[当前页](https://xueqiu.com)。';
 const out=projectResearchReply({text,requestId:'r1',sources:{forReply:(id,t)=>{assert.equal(id,'r1');assert.equal(t,text);return [s];}}});
 assert.equal(out.text,text);assert.deepEqual(out.sources,[s]);assert.doesNotMatch(out.speechText,/https:|docs\/report/);
});
test('long report retains text and gives bounded speech without citations',()=>{
 const text='完整报告。'.repeat(200)+' [1]';const r=projectResearchReply({text,requestId:'r1',sources:{forReply:()=>[]}});
 assert.equal(r.text,text);assert.ok(r.speechText.length<=600);assert.doesNotMatch(r.speechText,/\[1\]/);
});
test('public source cards bound snippets while persistent evidence remains intact',()=>{
 const evidence={...s,excerpt:'x'.repeat(12000)};
 const r=projectResearchReply({text:'天气',requestId:'r',sources:{forReply:()=>[evidence]}});
 assert.equal(r.sources[0].excerpt.length,800);assert.equal(evidence.excerpt.length,12000);
});
