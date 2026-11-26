import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {loadSettings} from '../../agent/settings.mjs';
import {createSubscriptionAdapter} from '../../agent/provider.mjs';
import {createProjectRouter} from '../projects/routing.mjs';
import {installModelGate} from '../model-gate.mjs';

const require=createRequire(join(loadSettings().harnessRoot,'packages/llm/llm/package.json'));
const {Context}=require('@deepseek-ai/cordis'),llm=require('@deepseek-ai/dsh-llm');

test('native provider error finish is recovered by classification without entering an agent session',async()=>{
  const ctx=new Context(),active={id:'routing-native',signal:new AbortController().signal,cancelled:false};let calls=0;
  try{
    await ctx.plugin(llm.default);
    const client={async streamItems(request){
      calls++;assert.equal(request.tools,undefined);
      if(calls===1)throw Object.assign(Error('private network details'),{code:'network_error',requestId:'req_route_native'});
      return {output:[{type:'message',id:'msg_route',role:'assistant',status:'completed',content:[{type:'output_text',text:'{"focus":"work","projectId":"project-a"}'}]}]};
    }};
    ctx.llm.registerAdapter(['opennova-chatgpt'],createSubscriptionAdapter(llm,client,{enableTools:true,allowedTools:[]}));
    installModelGate(ctx,{rt:{chatOf:()=> 'session-before',ownRequest:()=>false},bot:{id:'nova'},getActive:()=>active,isOwnedSession:()=>false});
    const router=createProjectRouter({ctx});
    const result=await router.classify({record:{id:active.id,input:'回到甲项目'},active,projects:[{id:'project-a',name:'甲',status:'active'}],context:{focus:'daily',projectId:'project-a'}});
    assert.equal(calls,2);assert.equal(result.focus,'work');assert.equal(result.projectId,'project-a');
    assert.equal(result.diagnostics.recovered,true);
    assert.deepEqual(result.diagnostics.failures[0].diagnostic,{type:'error',code:'network_error',stage:'routing',requestId:'req_route_native'});
    assert.equal(active.binding,undefined);assert.equal(active.sessionId,undefined);
    assert.ok(!JSON.stringify(result).includes('private'));
  }finally{await ctx.fiber.dispose();}
});

test('native adapter preserves reauthorization errors across the initial refresh rejection and later requests',async()=>{
  const ctx=new Context(),active={id:'routing-auth',signal:new AbortController().signal,cancelled:false};let calls=0;
  const context={focus:'work',projectId:'project-a'},before=structuredClone(context);
  try{
    await ctx.plugin(llm.default);
    const client={async streamItems(request){
      calls++;assert.equal(request.tools,undefined);
      throw Object.assign(Error('private-token'),calls===1?{code:'invalid_grant',status:400}:{code:'sign_in_required'});
    }};
    ctx.llm.registerAdapter(['opennova-chatgpt'],createSubscriptionAdapter(llm,client,{enableTools:true,allowedTools:[]}));
    installModelGate(ctx,{rt:{chatOf:()=> 'session-before',ownRequest:()=>false},bot:{id:'nova'},getActive:()=>active,isOwnedSession:()=>false});
    const router=createProjectRouter({ctx});
    for(const [index,code] of ['invalid_grant','sign_in_required'].entries()){
      active.id='routing-auth-'+index;
      const result=await router.classify({record:{id:active.id,input:'你好'},active,projects:[{id:'project-a',name:'甲',status:'active'}],context});
      assert.equal(calls,index+1);assert.equal(result.reason,'route_authorization_required');assert.equal(result.projectId,null);
      assert.equal(result.diagnostics.attempts,1);assert.equal(result.diagnostics.failures[0].diagnostic.code,code);
      assert.equal(result.failure.code,code);assert.equal(result.failure.stage,'routing');
      assert.match(result.question,/重新.*ChatGPT 授权/);assert.doesNotMatch(result.question,/稍后重试/);
      assert.deepEqual(context,before);assert.equal(active.binding,undefined);assert.equal(active.sessionId,undefined);
      assert.ok(!JSON.stringify(result).includes('private-token'));
    }
  }finally{await ctx.fiber.dispose();}
});
