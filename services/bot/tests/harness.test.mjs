/** Installed-runtime contract tests; no account, model calls, or user state. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadSettings} from '../../agent/settings.mjs';
import {textResult} from '../host.mjs';
import {ownResources} from '../lifecycle.mjs';
const require=createRequire(join(loadSettings().harnessRoot,'packages/bundle/base/package.json'));
const moduleOf=name=>import(pathToFileURL(require.resolve(name)).href);
const {Context}=await moduleOf('@deepseek-ai/cordis');
const {default:Tools,defineTool}=await moduleOf('@deepseek-ai/dsh-tools');
const {default:SystemPrompt}=await moduleOf('@deepseek-ai/dsh-system-prompt');
test('memory mutation wrapper satisfies the actual Harness canonical output contract',async()=>{
 const ctx=new Context(),system=ctx.plugin(SystemPrompt);await system;const tools=ctx.plugin(Tools);await tools;
 ctx.tools.register(defineTool({name:'remember',description:'test',parameters:{},output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},execute:async()=>assert.fail('wrapper must own mutation execution')}));
 ctx.on('tools/execute',async()=>textResult({id:'mutation',status:'applied'}));
 const result=await ctx.tools.execute({signal:new AbortController().signal,callId:'test',name:'remember',arguments:{}});
 assert.equal(result.isError,false);assert.equal(JSON.parse(result.value).status,'applied');assert.match(result.content[0].text,/mutation/);
 await tools.dispose();await system.dispose();
});
test('actual Cordis fiber disposal closes the acquired resource',async()=>{
 const ctx=new Context();let released=0;
 const fiber=ctx.plugin({name:'owned',apply(c){const owner=ownResources(c);owner.add(()=>released++);}});
 await fiber;await fiber.dispose();await new Promise(r=>setImmediate(r));
 assert.equal(released,1);
});
test('browser tool definitions compile and return canonical awaited JSON through actual Harness',async()=>{
 const {createBrowserTools}=await import('../desktop/tools.mjs');
 const ctx=new Context(),system=ctx.plugin(SystemPrompt);await system;const tools=ctx.plugin(Tools);await tools;
 try{
  const rows=[],definitions=createBrowserTools({ops:{put:r=>rows.push(r)},context:{},getRequest:()=>({id:'real-request'}),bridge:{execute:async()=>({status:'failed',error:'browser_disconnected'})}});
  for(const [name,description,parameters,execute] of definitions)ctx.tools.register(defineTool({name,description,parameters,output:{schema:{type:'string'},render:(_,v)=>[{type:'text',text:v}]},execute:async args=>JSON.stringify(await execute(args))}));
  const out=await ctx.tools.execute({signal:new AbortController().signal,callId:'browser-call',name:'browser_open',arguments:{url:'https://example.com/'}});
  assert.equal(out.isError,false);assert.equal(JSON.parse(out.value).error,'browser_disconnected');assert.equal(rows.at(-1).requestId,'real-request');
 }finally{await tools.dispose();await system.dispose();}
});
