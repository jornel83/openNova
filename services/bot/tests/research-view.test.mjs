import test from 'node:test';import assert from 'node:assert/strict';
import {sourceCards,researchPhaseLabel} from '../web/research-view.mjs';
import {researchStartupNotice} from '../../../tools/voice/start.mjs';
test('source_cards_restore_from_snapshot with evidence and separate timestamps',()=>{
 const snapshot=JSON.parse(JSON.stringify({sources:[{id:'s',observationId:'o',url:'https://example.com/x',title:'北京天气',evidenceType:'search_summary',retrievedAt:'2026-10-24T03:00:00Z',publishedAtRaw:'3 hours ago'}]}));
 const [card]=sourceCards(snapshot.sources);assert.equal(card.title,'北京天气');assert.equal(card.evidenceLabel,'搜索摘要');assert.match(card.retrievedLabel,/2026/);assert.match(card.publishedLabel,/3 hours ago/);
 assert.deepEqual(sourceCards(),[]);assert.deepEqual(sourceCards([{url:'javascript:alert(1)'}]),[]);
});
test('ring_label_matches_request_phase and does not hide ongoing project work',()=>{
 assert.equal(researchPhaseLabel({tool:'web_search',research:{phase:'searching'}}),'正在联网搜索');
 assert.equal(researchPhaseLabel({research:{phase:'reading'}}),'正在读取资料');
 assert.equal(researchPhaseLabel({research:{phase:'summarizing'}}),'正在整理回答');
 assert.equal(researchPhaseLabel({phase:'tool',tool:'bash',research:{phase:'summarizing'}}),null);
});
test('disabled_research_keeps_normal_startup while stale host is explicit',()=>{
 assert.match(researchStartupNotice({research:{version:1,enabled:false,available:false,reason:'disabled'}}),/未开启/);
 assert.match(researchStartupNotice({}, {enabled:true}),/重启/);
 assert.match(researchStartupNotice({research:{version:1,available:true,enabled:true,provider:'deepseek'}}),/DeepSeek/);
 assert.match(researchStartupNotice({research:{version:1,available:false,enabled:true,reason:'deepseek_api_key_missing'}}),/密钥/);
});
