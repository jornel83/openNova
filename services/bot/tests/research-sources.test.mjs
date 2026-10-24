import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Operations} from '../operations.mjs';import {createSources} from '../research/sources.mjs';
function fixture(t){const home=mkdtempSync(join(tmpdir(),'research-sources-'));let ops=new Operations({home,workspace:home});t.after(()=>{ops.close();rmSync(home,{recursive:true,force:true});});const make=(botId='bot')=>createSources({ops,botId,workspace:home});return {make,get ops(){return ops;},restart(){ops.close();ops=new Operations({home,workspace:home});return make();}};}
const observation=(extra={})=>({requestId:'r1',callId:'c1',provider:'deepseek',url:'https://example.com/weather#today',title:'天气',excerpt:'北京20℃',retrievedAt:'2026-10-24T00:00:00Z',evidenceType:'search_summary',status:'completed',...extra});
test('same_url_keeps_old_and_new_observations and restart_retains_source_ids',t=>{
 const f=fixture(t),book=f.make(),old=book.record(observation());
 const newer=book.record(observation({requestId:'r2',callId:'c2',evidenceType:'page_body',excerpt:'北京18℃',retrievedAt:'2026-10-25T00:00:00Z'}));
 assert.equal(old.sourceId,newer.sourceId);assert.notEqual(old.observationId,newer.observationId);
 const restored=f.restart();assert.equal(restored.forRequest('r1')[0].excerpt,'北京20℃');assert.equal(restored.forRequest('r2')[0].excerpt,'北京18℃');assert.equal(restored.forRequest('r1')[0].id,old.sourceId);
});
test('failed_fetch_does_not_upgrade_summary and relative publication time stays raw',t=>{
 const b=fixture(t).make();b.record(observation({publishedAt:'3 hours ago'}));
 assert.equal(b.record(observation({evidenceType:'page_body',status:'failed'})),null);
 const [s]=b.forRequest('r1');assert.equal(s.evidenceType,'search_summary');assert.equal(s.publishedAt,undefined);assert.equal(s.publishedAtRaw,'3 hours ago');
});
test('source_lookup_reads_only_requested_scope_without_network',t=>{
 const f=fixture(t),b=f.make();const s=b.record(observation());f.ops.put({id:'r1',kind:'request',status:'completed',createdAt:1});
 assert.equal(b.lookup({})[0].id,s.sourceId);assert.equal(b.lookup({sourceIds:[s.sourceId]})[0].excerpt,'北京20℃');
 assert.throws(()=>f.make('other').lookup({sourceIds:[s.sourceId]}),/source_not_found/);
 assert.throws(()=>b.lookup({sourceIds:[s.sourceId],requestId:'r1'}),/invalid_source_lookup/);
 b.use('r3',b.lookup({requestId:'r1'}));assert.equal(b.forRequest('r3')[0].observationId,s.observationId);
});
test('source URLs preserve semantic query and cap evidence',t=>{
 const b=fixture(t).make();b.record(observation({url:'https://example.com/?city=beijing',excerpt:'x'.repeat(14000)}));b.record(observation({url:'https://example.com/?city=shanghai'}));
 assert.equal(b.forRequest('r1').length,2);assert.equal(b.forRequest('r1')[0].excerpt.length,12000);assert.equal(b.forRequest('r1')[0].truncated,true);
 assert.equal(b.record(observation({url:'javascript:alert(1)'})),null);
});
