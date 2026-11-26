import test from 'node:test';
import assert from 'node:assert/strict';
import {createBridge} from '../http.mjs';
import {createEvents} from '../desktop/events.mjs';
test('bridge rejects browser origins and missing credentials and bounds request size',async t=>{
  let count=0;const server=createBridge({token:'test-only',handle:async()=>({count:++count})});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${server.address().port}/health`;
  for(const headers of [{},{Authorization:'Bearer wrong'},{Authorization:'Bearer test-only',Origin:'https://example.org'}])assert.equal((await fetch(url,{method:'POST',headers})).status,403);
  assert.equal(count,0);
  const good=await fetch(url,{method:'POST',headers:{Authorization:'Bearer test-only'},body:'{}'});
  assert.deepEqual(await good.json(),{count:1});
  const big=await fetch(url,{method:'POST',headers:{Authorization:'Bearer test-only'},body:'x'.repeat(100001)});
  assert.equal(big.status,400);assert.equal(count,1);
});
test('bearer event streams replay only after authentication and stale cursors require snapshots',async t=>{
  const events=createEvents({capacity:2}),cursor=events.snapshot(()=>null).cursor;
  const server=createBridge({token:'test-only',events,handle:async()=>({})});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{events.close();server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${server.address().port}/events`;
  const request=(headers,body)=>fetch(url,{method:'POST',headers,body:JSON.stringify(body)});
  for(const headers of [{},{Authorization:'Bearer wrong'},{Authorization:'Bearer test-only',Origin:'https://example.org'}])
    assert.equal((await request(headers,{cursor})).status,403);
  events.publish('reply.stream',{text:'第一句。'},'r');
  const response=await request({Authorization:'Bearer test-only'},{cursor});
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/event-stream/);
  const reader=response.body.getReader(),chunk=await reader.read();assert.match(new TextDecoder().decode(chunk.value),/第一句。/);await reader.cancel();
  events.publish('reply.stream',{text:'第二句。'},'r');events.publish('request.updated',{status:'completed'},'r');
  const expired=await request({Authorization:'Bearer test-only'},{cursor});assert.equal(expired.status,409);
  assert.equal((await expired.json()).error,'cursor_reset');
});
test('edition downloads and experiment evidence preserve exact binary bytes',async t=>{
  const bytes=Buffer.from([0,0xff,0x81,10]);
  const server=createBridge({token:'test-only',handle:async path=>({bytes,contentType:path==='/experiment-evidence'?'audio/wav':'application/pdf'})});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();});
  for(const [path,type] of [['project-edition-file','application/pdf'],['experiment-evidence','audio/wav']]){
    const url='http://127.0.0.1:'+server.address().port+'/'+path;
    assert.equal((await fetch(url,{method:'POST'})).status,403);
    const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer test-only'},body:'{}'});
    assert.equal(response.headers.get('content-type'),type);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  }
});
