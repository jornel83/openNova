import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceCards} from '../web/research-view.mjs';
import {researchStartupNotice} from '../../../tools/voice/start.mjs';
import {RESEARCH_VERSION} from '../research/config.mjs';
test('native link-only search and page responses do not claim verified facts',()=>{
 const cards=sourceCards([{url:'https://example.com/link',evidenceType:'search_link'},
  {url:'https://example.com/page',evidenceType:'page_response',statusCode:200},
  {url:'https://example.com/old',evidenceType:'page_body'}]);
 assert.equal(cards[0].evidenceLabel,'搜索链接');assert.equal(cards[1].evidenceLabel,'网页响应');assert.equal(cards[2].evidenceLabel,'已读取正文');
});
test('launcher distinguishes native readiness from a stale or rollback host',()=>{
 const research={version:RESEARCH_VERSION,mode:'native',available:true,enabled:true};
 assert.match(researchStartupNotice({research},{mode:'native',enabled:true}),/DSH 原生/);
 assert.match(researchStartupNotice({research:{...research,mode:'legacy'}},{mode:'native',enabled:true}),/重启/);
 assert.match(researchStartupNotice({research:{...research,mode:'legacy'}},{mode:'legacy',enabled:true}),/旧版/);
});
