/** Only frozen research tasks are eligible. There is no replay of arbitrary Agent tools. */
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {readJson,saveJson,readSteps} from './agent-files.mjs';
import {isFrozenDocumentResearch} from './frozen-documents.mjs';

const safe=new Set(['read','write','web_search','web_fetch','research_sources','document_read','document_generate','task_question']);
const memoized=new Set(['read','write','web_search','web_fetch']);
const digest=value=>createHash('sha256').update(value).digest('hex');
const sorted=x=>Array.isArray(x)?x.map(sorted):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sorted(x[k])])):x;
export function researchStepKey(name,args){return digest(JSON.stringify([name,sorted(args)]));}
const directory=config=>join(config.agentHome,'research-checkpoints',digest(config.researchResume?.originRunId??config.runId));
// Session observers see normalized tool/result events. Identify replay from the
// locally committed call identity, never from a network provider's result metadata.
export function checkpointWebOrigin(config,{tool,callId},args){
  if(!isFrozenDocumentResearch(config)||!['web_fetch','web_search'].includes(tool))return;
  const key=researchStepKey(tool,args),receipt=readJson(join(directory(config),key+'.json'));
  if(!receipt||receipt.key!==key||receipt.taskId!==config.taskId||receipt.projectId!==config.projectId||
      receipt.runId===config.runId&&receipt.callId===callId)return;
  return {requestId:receipt.runId,callId:receipt.callId};
}

// Document reads/generations use the host's separate hash-validated durable receipts.
// The result returned here is the original Harness tool result, not a fake success.
export function researchCheckpoints(config){
  const inflight=new Map();
  return async function execute(exec,next,onReuse){
    if(!isFrozenDocumentResearch(config)||!memoized.has(exec.name))return next();
    const key=researchStepKey(exec.name,exec.arguments),file=join(directory(config),key+'.json');
    const earlier=readJson(file);
    if(earlier){
      if(earlier.key!==key||earlier.taskId!==config.taskId||earlier.projectId!==config.projectId||!earlier.result)throw Error('research_checkpoint_unavailable');
      if(exec.name==='write'){
        const path=resolve(config.workspace,exec.arguments.file_path),expected=Buffer.from(exec.arguments.content,'utf8');
        try{if(realpathSync(path)!==path||lstatSync(path).size!==expected.length||!readFileSync(path).equals(expected))throw Error();}
        catch{throw Error('task_document_delivery_changed');}
      }
      onReuse?.(earlier.runId);return earlier.result;
    }
    if(inflight.has(key)){onReuse?.(config.runId);return inflight.get(key);}
    const work=Promise.resolve().then(next).then(result=>{
      const httpCode=result.meta?.statusCode??result.value?.statusCode;
      if(!result.isError&&!(exec.name==='web_fetch'&&httpCode!==undefined&&(httpCode<200||httpCode>=300))){
        const receipt={key,runId:config.runId,callId:exec.callId,taskId:config.taskId,projectId:config.projectId,result};
        // Never truncate a completed response then pretend it is the complete result.
        if(Buffer.byteLength(JSON.stringify(receipt))>2*1024*1024)throw Error('research_checkpoint_too_large');
        saveJson(file,receipt);
      }return result;
    }).finally(()=>inflight.delete(key));
    inflight.set(key,work);return work;
  };
}

export function recoveryPlan(manager,task,run,job){
  if(!isFrozenDocumentResearch(task)||task.media||task.managementReview||run.summaryRecovery||run.trigger||
    task.assignmentVersion!==run.assignmentVersion||task.projectId!==run.projectId||task.stopIntent||task.automationPaused||
    task.management?.paused||task.handoff||task.closure||manager.closureAncestor(task)||job.status!=='interrupted'||
    !job.cleanupConfirmed||manager.workers.has(job.id)||manager.receipt(job)?.cleanupConfirmed!==true)return null;
  const records=readSteps(manager.directory(job)),progress=readJson(join(manager.directory(job),'progress.json'),{});
  const originRunId=run.researchResume?.originRunId??run.id;
  if(progress.waiting||progress.awaiting||records.some(s=>s.tool==='task_question'))return {block:'research_waiting_for_input'};
  const evidence=[];
  for(const step of records){
    if(!safe.has(step.tool))return {block:'research_step_requires_review'};
    if(step.tool==='write'&&step.status!=='completed'){
      const key=researchStepKey(step.tool,step.arguments);
      const receipt=readJson(join(directory({agentHome:manager.agentHome(task),runId:originRunId}),key+'.json'));
      if(!receipt?.result||receipt.taskId!==task.id||receipt.key!==key)return {block:'research_write_outcome_unknown'};
    }
    if(step.status==='completed')evidence.push({tool:step.tool,stepId:step.id,output:step.output?.slice(0,900)});
  }
  // A host commit can precede delivery of its HTTP acknowledgement. Include
  // host-owned facts even when the worker's tool step never reached "done".
  const rows=manager.db.prepare("SELECT id,json_extract(body,'$.operation') tool,json_extract(body,'$.status') status,json_extract(body,'$.artifact.path') path,json_extract(body,'$.artifact.sha256') sha256,substr(json_extract(body,'$.content'),1,900) excerpt FROM records WHERE kind='tool' AND json_extract(body,'$.taskId')=? AND json_extract(body,'$.runId')=? AND json_extract(body,'$.projectId')=? AND json_extract(body,'$.assignmentVersion') IS ? AND json_extract(body,'$.operation') IN ('document_read','document_generate')").all(task.id,run.id,task.projectId,task.assignmentVersion??null);
  if(rows.some(r=>r.tool==='document_generate'&&['running','committing','interrupted'].includes(r.status)))return {block:'research_document_outcome_unknown'};
  evidence.push(...rows.filter(r=>r.status==='completed').map(({id,tool,path,sha256,excerpt})=>({id,tool,path,sha256,excerpt})));
  const web=readJson(join(manager.directory(job),'research.json'));
  if(web?.runId===run.id&&web.taskId===task.id)for(const s of (web.sources??[]).slice(-12)){
    evidence.push({tool:'research_sources',requestId:s.requestId,observationId:s.observationId,sourceId:s.sourceId,url:s.url,retrievedAt:s.retrievedAt});
  }
  const prior=run.researchResume?.evidence??[];
  const spent=(cap,used)=>cap>0?cap-used:0;
  const tokenBudget=spent(run.executionBudget?.tokenBudget??task.tokenBudget,progress.totalTokens??0);
  const timeoutMs=spent(run.executionBudget?.timeoutMs??task.timeoutMs,Math.max(0,job.finishedAt-run.startedAt));
  const remainingSteps=spent(run.researchResume?.remainingSteps??task.maxSteps,progress.steps??0);
  if((run.executionBudget?.tokenBudget??task.tokenBudget)>0&&tokenBudget<1||(run.executionBudget?.timeoutMs??task.timeoutMs)>0&&timeoutMs<1||
     (run.researchResume?.remainingSteps??task.maxSteps)>0&&remainingSteps<1)return {block:'research_recovery_budget_exhausted'};
  return {executionBudget:{tokenBudget,timeoutMs},researchResume:{originRunId,previousRunId:run.id,remainingSteps,
    evidence:[...prior,...evidence].slice(-24)}};
}
