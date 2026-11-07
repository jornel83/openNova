import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {browserHandler} from '../web-http.mjs';
import {createEvents} from '../desktop/events.mjs';
import {WebApi} from '../web/api.mjs';

async function fixture(t){
  const calls=[],requests=[];let browser,events,cookie='';
  const restart=()=>{
    events?.close();events=createEvents();
    browser=browserHandler({assets:tmpdir(),events},async(path,body)=>{calls.push({path,body});return {ok:true};});
  };
  restart();
  const server=createServer((req,res)=>{void browser(req,res);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`,nativeFetch=globalThis.fetch;
  // Browser tabs share HttpOnly cookies, but each WebApi retains its own CSRF.
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const response=await nativeFetch(url,{...options,headers:{...options.headers,Origin:origin,...(cookie?{Cookie:cookie}:{})}});
    const update=response.headers.get('set-cookie');if(update)cookie=update.split(';')[0];
    requests.push({path:new URL(url).pathname,status:response.status});return response;
  });
  t.after(()=>{events.close();server.closeAllConnections();server.close();});
  return {tab:()=>new WebApi(origin),restart,calls,requests,events:()=>events};
}

test('another tab refreshing the shared cookie after restart recovers stale CSRF without repeating the mutation',async t=>{
  const f=await fixture(t),oldTab=f.tab(),newTab=f.tab();
  await oldTab.session();const oldCsrf=oldTab.csrf;
  f.restart();await newTab.session();assert.notEqual(newTab.csrf,oldCsrf);
  f.requests.length=0;
  const body={id:'task',runId:'run-2',reportId:'report-2',actionId:'answer-once',action:'answer',instruction:'冬季读书会'};
  assert.deepEqual(await oldTab.call('tasks/review',body),{ok:true});
  assert.deepEqual(f.requests,[{path:'/web/api/tasks/review',status:403},{path:'/web/session',status:200},{path:'/web/api/tasks/review',status:200}]);
  assert.deepEqual(f.calls,[{path:'/tasks/review',body}]);assert.equal(oldTab.csrf,newTab.csrf);
  f.restart();f.requests.length=0;
  await oldTab.call('snapshot');
  assert.deepEqual(f.requests.map(r=>r.status),[401,200,200]);
});

test('event connection also recovers a stale tab CSRF after another tab refreshes the cookie',async t=>{
  const f=await fixture(t),oldTab=f.tab();await oldTab.session();
  f.restart();await f.tab().session();f.requests.length=0;
  const cursor=f.events().snapshot(()=>null).cursor,seen=[],controller=new AbortController();
  f.events().publish('request.updated',{status:'completed'},'report-once');
  await assert.rejects(oldTab.events(cursor,event=>{seen.push(event);controller.abort();},{signal:controller.signal}),{name:'AbortError'});
  assert.deepEqual(f.requests,[{path:'/web/events',status:403},{path:'/web/session',status:200},{path:'/web/events',status:200}]);
  assert.equal(seen.length,1);assert.equal(seen[0].requestId,'report-once');assert.equal(f.calls.length,0);
});

test('API and event authentication retries are bounded and do not retry operation permission errors',async t=>{
  for(const method of ['call','events'])for(const [status,error,attempts,refreshes] of [
    [403,'actor_denied',1,0],[403,'task_tool_denied',1,0],[403,'unauthorized',2,1],[401,'web_session_expired',2,1],
  ])await t.test(`${method}: ${status} ${error}`,async t=>{
    let operations=0,sessions=0;
    t.mock.method(globalThis,'fetch',async url=>{
      if(url.endsWith('/web/session')){sessions++;return Response.json({csrf:'fresh'});}
      operations++;return Response.json({error},{status});
    });
    const api=new WebApi('http://127.0.0.1:1');api.csrf='old';
    const request=method==='call'?api.call('approve',{id:'once'}):api.events({hostEpoch:'old',seq:0},()=>{});
    await assert.rejects(request,{message:error});assert.equal(operations,attempts);assert.equal(sessions,refreshes);
  });
});
