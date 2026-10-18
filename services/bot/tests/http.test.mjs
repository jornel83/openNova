import test from 'node:test';
import assert from 'node:assert/strict';
import {createBridge} from '../http.mjs';
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
