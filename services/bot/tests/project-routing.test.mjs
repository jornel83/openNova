import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectRouter,routingAuthorization,validateProjectRoute} from '../projects/routing.mjs';
import {installModelGate} from '../model-gate.mjs';
import {diagnosticHint} from '../../agent/errors.mjs';

const projects=[{id:'project-a',name:'甲',workspace:'/a',goal:'完成演示',body:'private-project-document'},{id:'project-b',name:'乙',workspace:'/b'}];
const active=()=>({id:'request',cancelled:false,signal:new AbortController().signal});
function fixture(reply,{chunks,intercept,timeoutMs}={}) {
  let seen,hook,current=active(),count=0;
  const ctx={on:(_,fn)=>{hook=fn;},llm:{stream(options){seen=options;count++;intercept?.(options,current);return hook(options,async function*(){
    if(chunks){yield* typeof chunks==='function'?chunks(count):chunks;return;}
    yield {type:'text-delta',index:0,text:typeof reply==='string'?reply:JSON.stringify(reply)};
    yield {type:'finish',reason:{kind:'stop'}};
  });}}};
  installModelGate(ctx,{rt:{chatOf:()=> 'current',ownRequest:()=>false},bot:{id:'identity'},getActive:()=>current,isOwnedSession:id=>id==='current'});
  const router=createProjectRouter({ctx,...(timeoutMs?{timeoutMs}:{})});
  return {classify:(input={})=>router.classify({record:{id:'request',input:'今天心情有些低落'},active:current,projects,context:{focus:'work',projectId:'project-a',resumableProjectId:'project-a'},...input}),
    seen:()=>seen,count:()=>count,hook:()=>hook,current:()=>current,setCurrent:value=>{current=value;}};
}

test('semantic classification is a no-tool identity-free model call with bounded metadata only',async()=>{
  const f=fixture({focus:'daily',projectId:null,reason:'独立生活话题'});
  const result=await f.classify({record:{id:'request',input:'今天心情有些低落',context:{body:'private-reference-body'}},
    context:{focus:'work',projectId:'project-a',resumableProjectId:'project-a',projectContext:'private-context'},
    recent:[{role:'user',text:'我朋友后来找到一份工作'},{role:'tool',text:'private-tool-output'}]});
  assert.equal(result.focus,'daily');
  const options=f.seen();assert.deepEqual(options.tools,[]);assert.equal(options.sessionId,undefined);assert.equal(options.purpose,undefined);
  const text=JSON.stringify(options.messages);for(const secret of ['private-project-document','private-reference-body','private-context','private-tool-output','/a'])assert.ok(!text.includes(secret));
  assert.match(text,/我朋友/);assert.equal(routingAuthorization(options),undefined);
});

test('routing uses model semantics for natural transitions and mixed work requests',async()=>{
  for(const [input,decision] of [
    ['周末我想试着画画',{focus:'daily',projectId:null}],
    ['他后来怎么样了',{focus:'daily',projectId:null}],
    ['今天真累，甲项目的后台测试还是继续吧',{focus:'work',projectId:'project-a'}],
    ['接着做刚才那个演示',{focus:'work',projectId:'project-a'}],
    ['乙那边也该推进一下了',{focus:'work',projectId:'project-b'}],
  ])assert.deepEqual(await fixture(decision).classify({record:{id:'request',input}}),decision);
});

test('document decisions bind an existing choice and current user quote, and ambiguous choices stay open',async()=>{
  const docx={id:'proposal-one',name:'物资.docx',format:'docx'},pdf={id:'proposal-two',name:'物资.pdf',format:'pdf'};
  const context={projectId:'project-a',focus:'work',documentReviews:[docx,{...pdf,spec:'private-recipe'}]};
  const text='就按 PDF 这份改。',route={focus:'work',projectId:'project-a'};
  const decision={action:'confirm',id:pdf.id,quote:'就按 PDF 这份改',targetQuote:'PDF'};
  const f=fixture({...route,documentDecision:decision});
  const result=await f.classify({context,record:{id:'request',input:text}});
  assert.deepEqual(result.documentDecision,{action:'confirm',id:pdf.id,quote:decision.quote});
  assert.deepEqual(JSON.parse(f.seen().messages[0].content[0].text).context.documentReviews,[docx,pdf]);
  for(const patch of [{id:docx.id},{id:'not-listed'},{quote:'确认并应用'},{targetQuote:undefined},{targetQuote:'物资'}]){
    const invalid=validateProjectRoute({...route,documentDecision:{...decision,...patch}},{context,projects,text});
    assert.equal(invalid.focus,'clarify');
  }
  assert.equal(validateProjectRoute({...route,projectId:'project-b',documentDecision:decision},{context,projects,text}).focus,'clarify');
  assert.equal(validateProjectRoute({...route,documentDecision:decision},{context:{...context,documentReviews:[]},projects,text}).focus,'clarify');
});

test('undo binds only a named or explicitly selected applied edition and is independent of pending reviews',async()=>{
  const pdf={id:'change-pdf',name:'物资清单.pdf',appliedName:'物资清单.v2.pdf',format:'pdf',status:'applied',selected:true};
  const word={id:'change-word',name:'物资清单.docx',appliedName:'物资清单.v2.docx',format:'docx',status:'undone'};
  const context={focus:'work',projectId:'project-a',documentUndos:[pdf,word],documentReviews:[{...pdf,id:'pending-pdf'}]};
  const route={focus:'work',projectId:context.projectId};
  const decide=(targetQuote,quote)=>({...route,documentDecision:{action:'undo',id:pdf.id,quote,targetQuote}});
  for(const name of ['当前文件','PDF','物资清单.v2.pdf']){
    const text='请撤销'+name+'上次已应用的修改';
    const f=fixture(decide(name,text));
    assert.deepEqual((await f.classify({context,record:{id:'request',input:text}})).documentDecision,{action:'undo',id:pdf.id,quote:text});
    assert.match(f.seen().system,/说不要撤销/);
  }
  const text='撤销物资清单刚才的修改',ambiguous=decide('物资清单',text);
  for(const decision of [ambiguous,decide(undefined,text),{...ambiguous,projectId:'project-b'},
    {...route,documentDecision:{action:'undo',id:'pending-pdf',quote:text}},
    {...route,documentDecision:{action:'discard',id:pdf.id,quote:text}}]){
    assert.equal(validateProjectRoute(decision,{context,projects,text}).focus,'clarify');
  }
  const noAction=await fixture(route).classify({context,record:{id:'request',input:'请保留这个版本，不要撤销 PDF。'}});
  assert.equal(noAction.documentDecision,undefined);
});

test('task ownership hints are bounded metadata without commands or task bodies',async()=>{
  const f=fixture({focus:'work',projectId:'project-b'}),tasks=Array.from({length:25},(_,index)=>({id:'task-'+index,projectId:'project-b',title:'标题',status:'paused',command:'private-command',goal:'private-task-body'}));
  assert.equal((await f.classify({record:{id:'request',input:'继续 task-0'},context:{focus:'work',projectId:'project-a',tasks}})).projectId,'project-b');
  const input=JSON.parse(f.seen().messages[0].content[0].text);
  assert.equal(input.context.tasks.length,20);
  assert.deepEqual(Object.keys(input.context.tasks[0]).sort(),['id','projectId','status','title']);
  assert.ok(!JSON.stringify(input).includes('private-'));
});

test('unknown, archived, ambiguous and malformed routes clarify without choosing a project',async()=>{
  for(const value of [{focus:'work',projectId:'missing'},{focus:'daily',projectId:'project-a'},{focus:'work',projectId:null},{focus:'work',projectId:'project-a',command:'execute'},[],null]){
    assert.equal((await fixture(value).classify()).focus,'clarify');
  }
  assert.equal((await fixture('```json\n{"focus":"daily","projectId":null}\n```').classify()).focus,'clarify');
  assert.equal(validateProjectRoute({focus:'work',projectId:'project-a'},{projects:[{...projects[0],status:'archived'}]}).reason,'archived_project');
  const sameName=[{id:'alpha',name:'同名'},{id:'beta',name:'同名'}];
  assert.equal(validateProjectRoute({focus:'work',projectId:'alpha'},{projects:sameName}).reason,'ambiguous_project');
  assert.equal(validateProjectRoute({focus:'work',projectId:'alpha'},{projects:sameName,context:{projectId:'alpha'}}).focus,'work');
});

test('routing never accepts tool calls or incomplete model output',async()=>{
  for(const chunks of [[{type:'tool-call-delta',index:0,id:'call',name:'bash',argumentsDelta:'{}'}],
    [{type:'text-delta',index:0,text:'{"focus":"daily","projectId":null}'},{type:'finish',reason:{kind:'max-tokens'}}]]){
    assert.equal((await fixture(null,{chunks}).classify()).focus,'clarify');
  }
});

const sameNameProjects=[{id:'growth-home',name:'增长',goal:'国内业务',status:'active'},{id:'growth-abroad',name:'增长',goal:'海外业务',status:'active'}];
test('same-name goal selection is tied to unique words from this user turn',()=>{
  for(const [text,projectId,goalQuote] of [['切到增长项目的海外业务','growth-abroad','海外'],['国内','growth-home','国内']]){
    const route={focus:'work',projectId,goalQuote};
    assert.deepEqual(validateProjectRoute(route,{projects:sameNameProjects,text}),route);
  }
  for(const [goalQuote,text] of [['海外','国内'],['业务','继续业务'],['海外业务','海外'],['海','海外'],['不存在','不存在']]){
    assert.equal(validateProjectRoute({focus:'work',projectId:'growth-abroad',goalQuote},{projects:sameNameProjects,text}).focus,'clarify');
  }
  const ambiguous=validateProjectRoute({focus:'work',projectId:'growth-abroad'},{projects:sameNameProjects,text:'继续增长'});
  assert.equal(ambiguous.reason,'ambiguous_project');assert.match(ambiguous.question,/国内业务.*海外业务/);
  assert.equal(validateProjectRoute({focus:'work',projectId:'growth-abroad',goalQuote:'海外'},{projects:[...sameNameProjects,{id:'growth-another',name:'增长',goal:'海外发展'}],text:'海外'}).focus,'clarify');
});

test('a failed classifier stream is retried in isolation and keeps sanitized diagnostics',async()=>{
  const previous=[];
  const f=fixture(null,{chunks:attempt=>attempt===1?[
    {type:'text-delta',index:0,text:'{"focus":"work","projectId":"project-b"}'},
    {type:'finish',reason:{kind:'error',failure:{code:'network_error',message:'private-token',status:503,requestId:'req_route_1'}}},
  ]:[{type:'text-delta',index:0,text:'{"focus":"work","projectId":"project-a"}'},{type:'finish',reason:{kind:'stop'}}],
  intercept(options){for(const old of previous)assert.equal(routingAuthorization(old),undefined);previous.push(options);}});
  const result=await f.classify({record:{id:'request',input:'回到甲，刚才确定的页面主色是什么？'}});
  assert.equal(result.projectId,'project-a');assert.equal(f.count(),2);
  assert.notEqual(previous[0].messages,previous[1].messages);assert.equal(previous[0].signal,previous[1].signal);
  assert.equal(result.diagnostics.recovered,true);assert.equal(result.diagnostics.attempts,2);
  assert.deepEqual(result.diagnostics.failures[0].diagnostic,{type:'error',code:'network_error',stage:'routing',status:503,requestId:'req_route_1'});
  assert.ok(!JSON.stringify(result).includes('private'));assert.equal(routingAuthorization(f.seen()),undefined);
});

test('persistent classifier network failures explain connectivity without changing the project or retry bound',async()=>{
  for(const code of ['network_error','connection_error']){
    for(const thrown of [false,true]){
      const failure={code,message:'private-token',cause:{message:'private-proxy'}};
      const context={focus:'work',projectId:'project-a',resumableProjectId:'project-a'},before=structuredClone(context);
      const f=fixture(null,thrown?{intercept(){throw failure;}}:{chunks:[{type:'finish',reason:{kind:'error',failure}}]});
      const result=await f.classify({context});
      assert.equal(f.count(),2);assert.equal(result.focus,'clarify');assert.equal(result.projectId,null);
      assert.equal(result.reason,'route_unavailable');assert.match(result.question,/无法连接 ChatGPT/);
      assert.match(result.question,/检查网络或 OpenNova 的代理设置后重试/);assert.match(result.question,/当前项目保持不变/);
      assert.equal(result.question,diagnosticHint(result.failure));
      assert.deepEqual(context,before);assert.equal(result.diagnostics.attempts,2);assert.equal(result.diagnostics.recovered,false);
      assert.equal(result.diagnostics.failures.length,2);
      assert.ok(result.diagnostics.failures.every(failure=>failure.diagnostic.code===code));
      assert.deepEqual(result.failure,{type:'error',code,stage:'routing'});
      assert.ok(!JSON.stringify(result).includes('private'));assert.equal(routingAuthorization(f.seen()),undefined);
    }
  }
});

test('expired authorization asks for sign-in on both the refresh rejection and subsequent requests',async()=>{
  for(const code of ['invalid_grant','sign_in_required','chatgpt_authorization_required']){
    for(const thrown of [false,true]){
      const failure={code,message:'private-token',...(code==='invalid_grant'?{status:400}:{})};
      const context={focus:'work',projectId:'project-a',resumableProjectId:'project-a'},before=structuredClone(context);
      const f=fixture(null,thrown?{intercept(){throw failure;}}:{chunks:[{type:'finish',reason:{kind:'error',failure}}]});
      const result=await f.classify({context});
      assert.equal(result.reason,'route_authorization_required');assert.equal(result.focus,'clarify');assert.equal(result.projectId,null);
      assert.match(result.question,/重新.*ChatGPT 授权/);assert.match(result.question,/当前项目保持不变/);
      assert.doesNotMatch(result.question,/稍后重试/);assert.equal(f.count(),1);assert.deepEqual(context,before);
      assert.equal(result.diagnostics.failures[0].diagnostic.code,code);assert.equal(result.diagnostics.recovered,false);
      assert.equal(result.failure.code,code);assert.equal(result.failure.stage,'routing');
      assert.ok(!JSON.stringify(result).includes('private-token'));assert.equal(routingAuthorization(f.seen()),undefined);
    }
  }
});

test('incomplete output can recover only from a fresh complete classifier result',async()=>{
  const f=fixture(null,{chunks:attempt=>attempt===1?[
    {type:'text-delta',index:0,text:'{"focus":"work","projectId":"project-b"}'},
    {type:'finish',reason:{kind:'max-tokens'}},
  ]:[{type:'text-delta',index:0,text:'{"focus":"daily","projectId":null}'},{type:'finish',reason:{kind:'stop'}}]});
  const result=await f.classify();assert.equal(f.count(),2);assert.equal(result.focus,'daily');
  assert.equal(result.diagnostics.failures[0].reason,'route_incomplete');
  const missing=fixture(null,{chunks:[{type:'text-delta',index:0,text:'{"focus":"daily","projectId":null}'}]});
  const incomplete=await missing.classify();assert.equal(incomplete.reason,'route_incomplete');assert.equal(missing.count(),2);
  assert.equal(incomplete.failure.code,'incomplete_model_response');assert.equal(incomplete.failure.stage,'routing');
});

test('a valid clarification after a transient failure is successful even when its free-form reason names a failure',async()=>{
  const f=fixture(null,{chunks:attempt=>attempt===1?[{type:'finish',reason:{kind:'error',failure:{code:'network_error'}}}]:[
    {type:'text-delta',index:0,text:JSON.stringify({focus:'clarify',projectId:null,reason:'route_unavailable',question:'请选择要继续的项目。'})},
    {type:'finish',reason:{kind:'stop'}},
  ]});
  const result=await f.classify();assert.equal(f.count(),2);assert.equal(result.focus,'clarify');assert.equal(result.failure,null);
  assert.equal(result.diagnostics.recovered,true);assert.equal(result.diagnostics.failures.length,1);
});

test('the terminal provider failure takes precedence over an earlier retry failure',async()=>{
  const f=fixture(null,{chunks:attempt=>[{type:'finish',reason:{kind:'error',failure:attempt===1?
    {code:'network_error',status:503}:{code:'api_error',status:403,requestId:'req_route_final',message:'private-token'}}}]});
  const result=await f.classify();assert.equal(f.count(),2);
  assert.deepEqual(result.failure,{type:'error',code:'api_error',stage:'routing',status:403,requestId:'req_route_final'});
  assert.equal(result.diagnostics.failures.length,2);assert.ok(!JSON.stringify(result).includes('private-token'));
});

test('invalid routing protocol fails without granting a binding or retrying model output',async()=>{
  for(const chunks of [
    [{type:'text-delta',index:0,text:'not json'},{type:'finish',reason:{kind:'stop'}}],
    [{type:'text-delta',index:0,text:JSON.stringify({focus:'work',projectId:'missing'})},{type:'finish',reason:{kind:'stop'}}],
    [{type:'text-delta',index:0,text:JSON.stringify({focus:'clarify',projectId:null,failure:{code:'network_error'}})},{type:'finish',reason:{kind:'stop'}}],
    [{type:'text-delta',index:0,text:'x'.repeat(12001)}],
    [{type:'tool-call-delta',index:0,name:'bash',argumentsDelta:'{}'}],
  ]){
    const f=fixture(null,{chunks}),result=await f.classify();
    assert.equal(f.count(),1);assert.equal(result.projectId,null);assert.equal(result.failure.code,'invalid_route_response');
    assert.equal(result.failure.stage,'routing');assert.equal(result.diagnostics.recovered,false);
  }
});

test('permission errors, tool calls and invalid project selections are not retried',async()=>{
  for(const chunks of [
    [{type:'finish',reason:{kind:'error',failure:{code:'api_error',status:403}}}],
    [{type:'tool-call-delta',index:0,name:'bash',argumentsDelta:'{}'}],
    [{type:'text-delta',index:0,text:'{"focus":"work","projectId":"missing"}'},{type:'finish',reason:{kind:'stop'}}],
  ]){const f=fixture(null,{chunks});assert.equal((await f.classify()).focus,'clarify');assert.equal(f.count(),1);}
});

test('classification retries share one deadline and never swallow cancellation',async()=>{
  const expired=fixture(null,{timeoutMs:10,chunks:async function*(){await new Promise(resolve=>setTimeout(resolve,20));yield {type:'finish',reason:{kind:'error',failure:{code:'network_error'}}};}});
  const timeout=await expired.classify();assert.equal(timeout.reason,'route_timeout');assert.equal(timeout.failure.code,'routing_timeout');
  assert.equal(timeout.failure.stage,'routing');assert.equal(expired.count(),1);
  const controller=new AbortController();let count=0;
  const router=createProjectRouter({ctx:{llm:{async *stream(){count++;controller.abort(Error('user_cancelled'));yield {type:'finish',reason:{kind:'error',failure:{code:'network_error'}}};}}}});
  await assert.rejects(router.classify({record:{id:'request',input:'继续'},active:{id:'request',signal:controller.signal},projects}),/user_cancelled/);
  assert.equal(count,1);
  const aborted=fixture(null,{chunks:[{type:'finish',reason:{kind:'aborted'}}]});
  const interrupted=await aborted.classify();assert.equal(aborted.count(),1);assert.equal(interrupted.failure.code,'incomplete_model_response');
  assert.equal(interrupted.failure.stage,'routing');
});

test('an archived project is only admitted for a validated restore management intent',async()=>{
  const archived=[{...projects[0],status:'archived'}],restore={focus:'manage',projectId:'project-a',action:'restore'};
  assert.deepEqual(await fixture(restore).classify({projects:archived}),restore);
  for(const value of [{...restore,action:'execute'},{...restore,action:undefined},{focus:'work',projectId:'project-a',action:'restore'},{...restore,projectId:'missing'}])
    assert.equal((await fixture(value).classify({projects:archived})).focus,'clarify');
  assert.equal((await fixture(restore).classify()).focus,'clarify');
  assert.equal((await fixture({focus:'work',projectId:'project-a'}).classify({projects:archived})).focus,'clarify');
});

test('classifier authorization cannot be copied, substituted or reused after settlement',async()=>{
  let checked=false;
  const f=fixture({focus:'daily',projectId:null},{intercept(options,current){
    assert.equal(routingAuthorization(options).active,current);checked=true;
    for(const patch of [{messages:[...options.messages]},{tools:[{name:'bash'}]},{sessionId:'current'},{purpose:'compaction'},{signal:new AbortController().signal}])
      assert.throws(()=>f.hook()({...options,...patch},()=>[]),/request_required/);
  }});
  assert.equal((await f.classify()).focus,'daily');assert.equal(checked,true);
  assert.throws(()=>f.hook()(f.seen(),()=>[]),/request_required/);
});

test('model outage clarifies while cancellation never returns an actionable route',async()=>{
  const outage=createProjectRouter({ctx:{llm:{stream(){throw Error('remote service unavailable');}}}});
  const result=await outage.classify({record:{id:'request',input:'继续'},active:active(),projects});
  assert.equal(result.reason,'route_unavailable');assert.equal(result.question,diagnosticHint(result.failure));
  const controller=new AbortController(),request={id:'request',signal:controller.signal,cancelled:false};
  const router=createProjectRouter({ctx:{llm:{async *stream(){controller.abort();yield {type:'finish',reason:{kind:'stop'}};}}}});
  await assert.rejects(router.classify({record:{id:'request',input:'继续'},active:request,projects}),/abort/i);
});

test('a stale project session cannot borrow an active request even without an owner index',async()=>{
  const f=fixture({focus:'daily',projectId:null});
  for(const sessionId of ['old-project','identity','current',undefined])assert.throws(()=>f.hook()({provider:'opennova-chatgpt',model:'gpt-6.1-sol',sessionId,messages:[]},()=>[]),/bridge_request_required/);
  f.current().binding={focus:'work',projectId:'project-a',sessionId:'current'};
  assert.deepEqual(f.hook()({provider:'opennova-chatgpt',model:'gpt-6.1-sol',sessionId:'current',messages:[]},()=>[]),[]);
  assert.throws(()=>f.hook()({provider:'opennova-chatgpt',model:'gpt-6.1-sol',sessionId:'old-project',purpose:'compaction',messages:[]},()=>[]),/bridge_request_required/);
});
