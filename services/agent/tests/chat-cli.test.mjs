import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('/quit cancels the active turn before it can dispatch another tool',()=>{
 const mock=`export class AgentClient {
  async start(){return {tools:true};}
  ask(){this.active=true;return new Promise(resolve=>{this.resolve=resolve;this.timer=setTimeout(()=>{console.log('LATE_TOOL');this.active=false;resolve({text:'late'});},150);});}
  cancel(){if(this.active){console.log('CANCEL');clearTimeout(this.timer);this.active=false;this.resolve({type:'cancelled'});}}
  async close(){console.log('CLOSE');this.cancel();}
 }`;
 const moduleURL='data:text/javascript,'+encodeURIComponent(mock);
 const loader=`import {registerHooks} from 'node:module';registerHooks({resolve(spec,ctx,next){return spec==='./client.mjs'?{url:${JSON.stringify(moduleURL)},shortCircuit:true}:next(spec,ctx);}});`;
 const result=spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(loader),fileURLToPath(new URL('../../../tools/agent/chat.mjs',import.meta.url)),'--web'],{input:'slow question\n/quit\n',encoding:'utf8',timeout:3000});
 assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout,/LATE_TOOL/);assert.match(result.stdout,/CANCEL/);
});
