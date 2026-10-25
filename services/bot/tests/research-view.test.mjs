import test from 'node:test';import assert from 'node:assert/strict';
import {sourceCards,researchPhaseLabel} from '../web/research-view.mjs';
import {RESEARCH_VERSION} from '../research/config.mjs';
import {researchStartupNotice} from '../../../tools/voice/start.mjs';
test('model connection and incomplete turn failures have distinct actionable UI messages',async()=>{
 const {errorText}=await import('../web/api.mjs');
 const network=errorText({message:'network_error'}),incomplete=errorText({message:'incomplete_agent_turn'});
 assert.match(network,/ChatGPT/);assert.match(network,/网络|代理/);assert.doesNotMatch(network,/network_error/);
 assert.match(incomplete,/未完整|未完成/);assert.doesNotMatch(incomplete,/incomplete_agent_turn/);assert.notEqual(network,incomplete);
});
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
 assert.match(researchStartupNotice({research:{version:RESEARCH_VERSION,enabled:false,available:false,reason:'disabled'}}),/未开启/);
 assert.match(researchStartupNotice({}, {enabled:true}),/重启/);
 assert.match(researchStartupNotice({research:{version:RESEARCH_VERSION,available:true,enabled:true,provider:'deepseek'}}),/DeepSeek/);
 assert.match(researchStartupNotice({research:{version:RESEARCH_VERSION,available:false,enabled:true,reason:'deepseek_api_key_missing'}}),/密钥/);
});
test('API and script results preserve distinct evidence and failures',async()=>{
 const {derivationCards}=await import('../web/research-view.mjs');assert.equal(typeof derivationCards,'function');
 const [api]=sourceCards([{url:'https://example.com/api',evidenceType:'api_response',statusCode:200,encoding:'gb18030',quality:{state:'usable'}}]);assert.equal(api.evidenceLabel,'接口响应');assert.match(api.httpLabel,/200/);
 const [script]=derivationCards([{id:'d',summary:'Selected date',inputObservationIds:['o1'],artifactChanged:true,hasObservedInputs:true}]);assert.equal(script.evidenceLabel,'脚本处理结果');assert.match(script.warning,/变化/);assert.deepEqual(script.inputObservationIds,['o1']);
 for(const [phase,label] of [['requesting','正在获取数据'],['processing','正在处理数据'],['verifying','正在核对结果']])assert.equal(researchPhaseLabel({phase:'tool',tool:'web_request',research:{phase}}),label);
});
