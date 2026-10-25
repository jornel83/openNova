import {createHash,randomUUID} from 'node:crypto';
import {openSync,readFileSync,closeSync,fstatSync,realpathSync} from 'node:fs';
import {relative,isAbsolute} from 'node:path';
function fingerprint(path){
 const fd=openSync(path,'r');try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>2000000)throw Error('invalid_research_artifact');return createHash('sha256').update(readFileSync(fd)).digest('hex');}finally{closeSync(fd);}
}
const changed=(path,hash)=>{try{return fingerprint(path)!==hash;}catch{return true;}};
export function createDerivations({ops,sources}){
 const forRequest=id=>ops.list('research_derivation').filter(r=>r.requestId===id).map(r=>({...r,artifactChanged:changed(r.artifactPath,r.artifactHash),inputArtifactsChanged:r.inputs.some(i=>changed(i.artifactPath,i.artifactHash))}));
 return {forRequest,record(args,{requestId,callId}){
  const execution=ops.list('research_execution').find(r=>r.id===args.executionId&&r.requestId===requestId);
  if(!execution||execution.status!=='completed')throw Error('invalid_research_execution');
  if(!Array.isArray(args.observationIds)||args.observationIds.length>10||args.observationIds.some(id=>typeof id!=='string'))throw Error('invalid_observation');
  if(typeof args.summary!=='string'||!args.summary.trim()||args.summary.length>4000||typeof args.artifactPath!=='string')throw Error('invalid_derivation');
  const known=sources.forRequest(requestId),inputs=args.observationIds.map(id=>{
   const row=known.find(r=>r.observationId===id&&r.requestId===requestId&&r.artifactPath&&r.artifactHash);if(!row)throw Error('invalid_observation');
   if(changed(row.artifactPath,row.artifactHash))throw Error('input_artifact_changed');
   return {observationId:id,artifactPath:row.artifactPath,artifactHash:row.artifactHash};
  });
  const path=realpathSync(args.artifactPath),rel=relative(realpathSync(execution.outputDirectory),path);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('invalid_research_artifact');
  const record={id:randomUUID(),kind:'research_derivation',evidenceType:'script_output',requestId,callId,executionId:execution.id,inputObservationIds:inputs.map(i=>i.observationId),inputs,
   artifactPath:path,artifactHash:fingerprint(path),summary:args.summary,hasObservedInputs:inputs.length>0,createdAt:Date.now()};ops.put(record);return record;
 }};
}
export const derivationTool=['research_derive','登记本轮已成功结束的研究脚本结果。artifactPath 必须在该执行的 OPENNOVA_RESEARCH_OUTPUT_DIR 内；observationIds 引用本轮实际 HTTP 观察。记录关联关系，不代表自动核验计算方法。',
 {executionId:{type:'string',required:true},observationIds:{type:'array',items:{type:'string'},required:true},artifactPath:{type:'string',required:true},summary:{type:'string',required:true}},()=>{throw Error('research_middleware_required');}];
