/** Explicit manual network evaluation. Never imported by the default test suite. */
import {writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createClient} from '../services/agent/chatgpt.mjs';
import {responseToolChunks} from '../services/agent/responses-protocol.mjs';
import {createProjectRouter} from '../services/bot/projects/routing.mjs';
import {PROJECTS,ROUTING_CASES} from '../services/bot/tests/fixtures/projects-routing-cases.mjs';

export async function verifyProjectRouting({timeoutMs=30000,output,cases}={}) {
  const client=await createClient({capabilities:'text'}),session=await client.getSession();
  if(session.status!=='connected'||!session.sharing)throw Error('existing_authorization_required');
  const ctx={llm:{stream:options=>responseToolChunks(client,options,[])}};
  const router=createProjectRouter({ctx,timeoutMs});
  const selected=cases?ROUTING_CASES.filter(item=>cases.includes(item.id)):ROUTING_CASES;
  if(!selected.length||cases&&selected.length!==cases.length)throw Error('invalid_evaluation_cases');
  const results=new Array(selected.length);let next=0;
  async function worker(){
    for(;;){
      const index=next++;if(index>=selected.length)return;
      const item=selected[index],started=Date.now(),controller=new AbortController();
      let actual;
      try{actual=await router.classify({record:{id:item.id,input:item.text},active:{id:item.id,signal:controller.signal,cancelled:false},projects:item.projects??PROJECTS,context:item.context,recent:item.recent});}
      catch{actual={focus:'error',projectId:null,reason:'evaluation_call_failed'};}
      const passed=actual.focus===item.expected.focus&&actual.projectId===item.expected.projectId&&actual.action===item.expected.action;
      const result={id:item.id,latencyMs:Date.now()-started,expected:item.expected,actual:{focus:actual.focus,projectId:actual.projectId,...(actual.action?{action:actual.action}:{}),...(actual.goalQuote?{goalQuote:actual.goalQuote}:{}),...(actual.reason?{reason:actual.reason}:{}),...(actual.diagnostics?{diagnostics:actual.diagnostics}:{})},passed};
      results[index]=result;console.log(JSON.stringify(result));
    }
  }
  await Promise.all([worker(),worker()]);
  const ordered=results.map(result=>result.latencyMs).sort((a,b)=>a-b);
  const report={evaluatedAt:new Date().toISOString(),model:'gpt-6.1-sol',synthetic:true,count:results.length,concurrency:2,timeoutMs,passed:results.filter(result=>result.passed).length,
    latencyMs:{min:ordered[0],median:ordered[Math.floor(ordered.length/2)],p95:ordered[Math.ceil(ordered.length*.95)-1],max:ordered.at(-1)},
    failedCases:results.filter(result=>!result.passed),results};
  if(output){const path=resolve(output);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(report,null,2)+'\n');}
  console.log(JSON.stringify({summary:{...report,results:undefined}}));return report;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);let output,cases,timeoutMs=30000;
  for(let index=0;index<args.length;index++){
    if(args[index]==='--output')output=args[++index];
    else if(args[index]==='--timeout-ms')timeoutMs=Number(args[++index]);
    else if(args[index]==='--cases')cases=args[++index]?.split(',');
    else throw Error('usage: verify-project-routing.mjs [--output path] [--timeout-ms 30000] [--cases id,id]');
  }
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000)throw Error('invalid_evaluation_timeout');
  try{const report=await verifyProjectRouting({timeoutMs,output,cases});process.exitCode=report.passed===report.count?0:1;}
  catch(error){console.error(JSON.stringify({error:error.message==='existing_authorization_required'?error.message:'routing_evaluation_unavailable'}));process.exitCode=1;}
}
