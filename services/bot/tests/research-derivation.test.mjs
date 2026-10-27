import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
const mod=await import('../research/derivation.mjs').catch(()=>({}));
test('derived_output_preserves_input_observations; script_without_receipts_not_http_verified',t=>{
 assert.equal(typeof mod.createDerivations,'function');const root=mkdtempSync(join(tmpdir(),'derive-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const artifact=join(root,'answer.json');writeFileSync(artifact,'{"close":1}');const hash=createHash('sha256').update('{"close":1}').digest('hex');const rows=new Map();
 const ops={put:r=>(rows.set(r.id,r),r),list:k=>[...rows.values()].filter(r=>r.kind===k),get:id=>rows.get(id)};
 ops.put({id:'exec1',kind:'research_execution',requestId:'r1',status:'completed',outputDirectory:root});
 const source={observationId:'obs1',requestId:'r1',artifactPath:artifact,artifactHash:hash};
 const d=mod.createDerivations({ops,sources:{forRequest:()=>[source]}});
 const record=d.record({executionId:'exec1',observationIds:['obs1'],artifactPath:artifact,summary:'Selected date row'},{requestId:'r1',callId:'c1'});
 assert.equal(record.evidenceType,'script_output');assert.deepEqual(record.inputObservationIds,['obs1']);assert.equal(record.url,undefined);
 const unverified=d.record({executionId:'exec1',observationIds:[],artifactPath:artifact,summary:'stdout only'},{requestId:'r1'});assert.equal(unverified.hasObservedInputs,false);
 assert.throws(()=>d.record({executionId:'exec1',observationIds:['other'],artifactPath:artifact,summary:'x'},{requestId:'r1'}),/observation/);
 assert.throws(()=>d.record({executionId:'exec1',observationIds:[],artifactPath:artifact,summary:'x'},{requestId:'r2'}),/execution/);
 writeFileSync(artifact,'changed');assert.equal(d.forRequest('r1')[0].artifactChanged,true);assert.equal(d.forRequest('r1')[0].inputArtifactsChanged,true);
});
