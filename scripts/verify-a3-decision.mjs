/** Opt-in acceptance. A fresh, loopback-only Bot uses the existing model authorization and synthetic project files. */
import {spawn, execFileSync} from 'node:child_process';
import {createHash, randomInt, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {ROOT, requireBuiltHarness} from '../services/runtime/sources.mjs';
import {loadSettings} from '../services/agent/settings.mjs';
import {botSettings} from '../services/bot/settings.mjs';
import {runtimePatch} from '../services/bot/configuration.mjs';
import {runDocumentGenerator} from '../services/bot/documents/runner.mjs';
import {normalizeDocumentSpec} from '../services/bot/documents/spec.mjs';

// Observe front-end calls without changing the production tool list, results or prompts.
export const name = 'a3-acceptance-trace';
export const inject = ['tools'];
export function apply(ctx, config) {
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next();
    appendFileSync(config.trace, JSON.stringify({tool:exec.name, ok:!result.isError, id:exec.arguments?.id, action:exec.arguments?.action}) + '\n');
    return result;
  }, {prepend:true});
}

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const sha = data => createHash('sha256').update(data).digest('hex');
const compact = text => text.replaceAll(/[,，\s*]/g, '');
const recordsOf = (records, type) => records.filter(r => r.type === type && r.status === 'active');
const mentionsCost = text => /预算|成本|便宜|费用|价格|报价|总价|省钱|开支/.test(text);
const mentionsBudgetCap = text => /4000|四千/.test(compact(text)) && mentionsCost(text);
const namesPlan = (answer, name, other) => {
  const first = answer.split('\n').find(line => /Cedar|Maple/i.test(line))?.replaceAll('*','') ?? '';
  // A recommendation may name the other vendor in a following price comparison.
  const explicit = first.match(/(?:首选|推荐|优先选择|选择)\s*[:：为是]?\s*(?:方案\s*)?(Cedar|Maple)/i);
  return explicit ? explicit[1].toLowerCase() === name.toLowerCase()
    : new RegExp(name, 'i').test(first) && !new RegExp(other, 'i').test(first);
};

const pick = (row, keys) => Object.fromEntries(keys.filter(k=>row?.[k]!==undefined).map(k=>[k,row[k]]));
const errorFields = ['status','error','diagnostic','failurePhase','stopReason','exitCode','signal','startedAt','finishedAt','cleanupConfirmed'];
const replayFields = ['title','goal','constraints','acceptanceCriteria','workspaceMode','permission','documentResearch','maxSteps','tokenBudget','timeoutMs','maxReworks'];

function captureWorker(home, evidence, token, stage) {
  // Use the isolated Bot's persisted records, including when its HTTP host is unavailable.
  const db = new DatabaseSync(join(home,'bridge.sqlite'), {readOnly:true});
  try {
    const tasks=db.prepare('SELECT body FROM background_task').all().map(r=>JSON.parse(r.body));
    const safeRead = path => existsSync(path) ? readFileSync(path,'utf8') : '';
    const byId = (table,id)=>JSON.parse(db.prepare('SELECT body FROM '+table+' WHERE id=?').get(id)?.body??'{}');
    const workers = tasks.map(task=>{
      const runs=db.prepare("SELECT body FROM background_run WHERE json_extract(body,'$.taskId')=? ORDER BY rowid").all(task.id).map(row=>{
        const run=JSON.parse(row.body),job=byId('background_job',run.jobId),dir=join(home,'tasks',job.id);
        const stepsDir=join(dir,'steps');
        const steps = existsSync(stepsDir) ? readdirSync(stepsDir).filter(file=>file.endsWith('.json')).map(file=>JSON.parse(safeRead(join(stepsDir,file)))).sort((a,b)=>a.createdAt-b.createdAt) : [];
        const result=job.agentResult??JSON.parse(safeRead(join(dir,'agent-result.json'))||'{}');
        return {run:pick(run,['id','jobId','number',...errorFields]),job:pick(job,['id',...errorFields]),
          result:pick(result,['text','question','steps','toolCalls','totalTokens',...errorFields]),
          progress:JSON.parse(safeRead(join(dir,'progress.json'))||'{}'),
          steps:steps.map(step=>pick(step,['id','tool','arguments','output','createdAt',...errorFields])),
          log:safeRead(join(dir,'output.log')).slice(-100000)};
      });
      const receipts=db.prepare("SELECT body FROM records WHERE kind IN ('tool','document_artifact') AND json_extract(body,'$.taskId')=? ORDER BY rowid").all(task.id).map(({body})=>{
        const op=JSON.parse(body);
        return {...pick(op,['kind','id','runId','operation','format','content','path','specPath','outputPath','sha256','validation','generation','layoutValidation','contentValidation',...errorFields]),
          source:pick(op.source,['sourceId','name','path','sha256','pageRange']),artifact:pick(op.artifact,['id','name','path','sha256'])};
      });
      return {task:pick(task,['id','projectId','runId','requestId','title',...errorFields]),settings:pick(task,replayFields),runs,receipts};
    });
    const sanitized=JSON.stringify({stage,observedAt:new Date().toISOString(),workers},(key,value)=>{
      if (['authorization','cookie','apiKey','api_key','accessToken','refreshToken'].includes(key)) return '[redacted]';
      if (typeof value!=='string') return value;
      return value.replaceAll(token,'[redacted]').replace(/(Bearer\s+)[A-Za-z0-9._=-]+/gi,'$1[redacted]').replace(/\bsk-[A-Za-z0-9_-]{16,}/g,'[redacted]');
    },2);
    writeFileSync(join(evidence,'worker-evidence.json'),sanitized+'\n',{mode:0o600});
    return workers.length;
  } finally {db.close();}
}

async function run(replayPath) {
  const sources = requireBuiltHarness();
  const prior = replayPath ? JSON.parse(readFileSync(replayPath,'utf8')) : null;
  if (prior && (!prior.dispatch || !prior.inputs?.Maple || !prior.steps?.some(step=>step.phase==='dispatch'))) throw Error('expected_a3_frontend_report');
  const evidence = join(ROOT, 'output/verification/a3-decision', randomUUID());
  mkdirSync(evidence, {recursive:true});
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'nova-a3-')));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const port = await freePort();
  let webPort = await freePort();
  while (webPort === port) webPort = await freePort();
  const bot = {...botSettings({OPENNOVA_BOT_HOME:home, OPENNOVA_BOT_PORT:String(port), OPENNOVA_BOT_WEB_PORT:String(webPort)}), workspace};
  const token = randomUUID();
  writeFileSync(bot.tokenPath, token, {mode:0o600});
  const trace = join(evidence, 'tool-calls.jsonl');
  writeFileSync(trace, '');
  const patch = runtimePatch({bot, agent:{harnessRoot:sources.harnessRoot}, desktop:false});
  const plugins = patch.find(row => row.insert).insert;
  plugins.splice(plugins.findIndex(p => p.id === 'opennova-bot'), 0, {id:name, name:import.meta.filename, config:{trace}});
  const patchPath = join(home, 'acceptance.patch.json');
  writeFileSync(patchPath, JSON.stringify(patch));
  const child = spawn(process.execPath, [join(sources.harnessRoot, 'apps/cli/lib/bin.js'), '--profile','web','--patch',patchPath,'--host','127.0.0.1','--port',String(webPort),'--no-open'], {
    cwd:workspace, stdio:'ignore', env:{
      PATH:dirname(process.execPath) + ':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME:process.env.HOME, USER:process.env.USER, LANG:'en_US.UTF-8',
      DSH_HOME:join(home,'harness'), OPENNOVA_BOT_HOME:home, OPENNOVA_BOT_PLUGIN:sources.botRoot, OPENNOVA_HARNESS_ROOT:sources.harnessRoot,
      OPENNOVA_SIWC_STORAGE:loadSettings().storageDir, NODE_OPTIONS:'--import=' + JSON.stringify(join(ROOT,'services/bot/resolve.mjs')),
    },
  });
  const report = {startedAt:new Date().toISOString(), inputs:{}, steps:[], checks:[],
    ...(prior?{replayOf:resolve(replayPath),replayEntry:'isolated worker; saved quote bytes, goal, constraints, acceptance criteria and project records; fresh IDs and relative output',originalWorkerSettingsKnown:!!prior.dispatch.settings}: {})};
  const save = () => writeFileSync(join(evidence,'report.json'), JSON.stringify(report,null,2) + '\n');
  const check = (label, result) => {report.checks.push({label, passed:!!result}); save();};
  save();
  console.log('Evidence:',evidence);
  const api = async (path, body={}) => {
    const response = await fetch(bot.url + path, {method:'POST', headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(12000)});
    if (!response.ok) throw Error('http_' + response.status + '_' + path);
    return response.json();
  };
  async function wait(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (child.exitCode !== null || child.signalCode) throw Error('isolated_host_exited');
      const result = await fn();
      if (result) return result;
      await delay(350);
    }
    throw Error('acceptance_deadline');
  }
  async function ask(phase, input, project) {
    const id = randomUUID(), before = readFileSync(trace,'utf8').length;
    const step = {phase, id, input, startedAt:new Date().toISOString()};
    report.steps.push(step); save();
    const state = (await api('/projects')).state;
    await api('/ask', {id, text:input, source:'text', expectedProject:{projectId:state.projectId,revision:state.revision}});
    const result = await wait(async () => {
      const value = await api('/result',{id});
      return ['completed','failed','cancelled','interrupted'].includes(value.status) && value;
    }, 360000);
    step.answer = result.text ?? '';
    step.status = result.status;
    step.project = result.projectId;
    step.tools = readFileSync(trace,'utf8').slice(before).trim().split('\n').filter(Boolean).map(s => JSON.parse(s));
    const operations = (await api('/operations')).filter(op => op.requestId === id);
    step.receipts = operations.map(({operation,status,error,source}) => ({operation,status,error,name:source?.name,sha:source?.sha256}));
    step.records = (await api('/project-detail',{id:project.id})).records.map(({id,type,status,text,source,sourceRequestId})=>({id,type,status,text,quote:source?.quote,sourceRequestId}));
    step.taskIds = (await api('/background-tasks',{allProjects:true})).tasks.map(task=>task.id);
    save();
    console.log(phase, result.status, step.tools.map(t=>t.tool).join(','));
    if (result.status !== 'completed' || result.projectId !== project.id) throw Error('model_or_binding_failed_' + phase);
    return step;
  }
  try {
    await wait(async()=>{try{return (await api('/health')).ready;}catch{return false;}}, 45000);
    async function project(name, key) {
      const directory = join(home,key); mkdirSync(directory);
      return (await api('/project-action',{action:'create',actionId:randomUUID(),name,directory})).result;
    }
    const a = await project('展台选型','alpha'), b = await project('装订校样','beta');
    await api('/project-action',{action:'select',actionId:randomUUID(),projectId:a.id,focus:'work',revision:(await api('/projects')).state.revision});
    let id;
    const mapleCost=prior?.inputs.Maple.cost??randomInt(3101,3900);
    if (prior) {
      for (const [name,sample] of Object.entries(prior.inputs)) {
        if (!['Maple','Cedar'].includes(name) || sample.file!==name+'.pdf') throw Error('unexpected_replay_quote');
        const bytes=readFileSync(join(dirname(replayPath),sample.file));
        if (sha(bytes)!==sample.sha) throw Error('replay_source_hash_mismatch');
        writeFileSync(join(a.workspace,sample.file),bytes);
        writeFileSync(join(evidence,sample.file),bytes);
        report.inputs[name]=sample;
      }
      for (const [type,textValue] of [...prior.dispatch.decisions.map(d=>['decision',d.text]),...prior.dispatch.nextSteps.map(text=>['next_step',text])]) {
        const revision=(await api('/project-detail',{id:a.id})).project.revision;
        await api('/project-record',{action:'add',actionId:randomUUID(),projectId:a.id,revision,type,text:textValue});
      }
      const {goal,constraints,acceptanceCriteria,settings}=prior.dispatch;
      id='worker-replay-'+randomUUID();
      const submitted=await api('/background-task-start',{...pick(settings,replayFields),kind:'agent',title:settings?.title??'采购样稿',id,goal,constraints,acceptanceCriteria,
        documentResearch:true,permission:'full',workspaceMode:'documents',inputFiles:['Maple.pdf'],documentOutputPath:'采购样稿.docx',managementEnabled:false});
      const task=submitted.task;
      report.dispatch={id,projectId:a.id,goal,constraints,acceptanceCriteria,settings:pick(task,replayFields),files:task.inputSnapshot.files.map(({path,sha256})=>({path,sha256}))};
      save();
      check('replay binds the same quote bytes',report.dispatch.files.some(f=>f.sha256===prior.inputs.Maple.sha));
    } else {
      const cedarCost = randomInt(7101,7900);
      for (const [name, days, cost] of [['Cedar',3,cedarCost],['Maple',8,mapleCost]]) {
        const file = name + '.pdf', specPath = join(home,name+'.json');
        const text = '交付周期 '+days+' 天，含税总价 '+cost+' 元。';
        writeFileSync(specPath, JSON.stringify(normalizeDocumentSpec({schemaVersion:1,title:name+' 展台采购报价',blocks:[{type:'paragraph',text}]})));
        const outputPath = join(a.workspace,file);
        await runDocumentGenerator({format:'pdf',specPath,outputPath,workdir:home});
        copyFileSync(outputPath,join(evidence,file));
        report.inputs[name]={file,days,cost,text,sha:sha(readFileSync(outputPath))}; save();
      }
      const first = await ask('speed','帮我比较项目里的 Cedar.pdf 和 Maple.pdf。展台得尽早交，预算目前够用，你推荐哪个？第一行写首选，再用两份报价里的工期、金额和出处说明取舍。',a);
      check('speed recommendation',namesPlan(first.answer,'Cedar','Maple'));
      check('both quotes are read from the expected file versions',Object.values(report.inputs).every(sample=>first.receipts.some(r=>r.operation==='document_read' && r.status==='completed' && r.sha===sample.sha)));
      check('comparison cites both PDFs, their prices and durations', Object.values(report.inputs).every(s=>first.answer.includes(s.file) && compact(first.answer).includes(String(s.cost))) && /[3三]\s*(?:个工作日|个自然日|天|日)/.test(first.answer) && /[8八]\s*(?:个工作日|个自然日|天|日)/.test(first.answer));
      const second = await ask('budget','交付窗口现在宽裕了，改成总价越低越好。用刚才的报价，第一行写首选，再说明取舍发生了什么变化。',a);
      check('new priority changes the recommendation with price evidence',namesPlan(second.answer,'Maple','Cedar') && mentionsCost(second.answer) && compact(second.answer).includes(String(mapleCost)));
      const leaning = await ask('leaning','我有点倾向 Maple，但还没拍板，先留作备选。',a);
      check('tentative choice stays an option', recordsOf(leaning.records,'option').some(r=>/Maple/i.test(r.text)) && !recordsOf(leaning.records,'decision').length);
      const chosen = await ask('chosen','就选 Maple 吧，这次预算上限是 4000 元，总价能压在上限内最重要。',a);
      const decisions = recordsOf(chosen.records,'decision');
      const choice = decisions.find(r => /Maple/i.test(r.text) && mentionsBudgetCap(r.text) && r.sourceRequestId===chosen.id && r.quote && chosen.input.includes(r.quote));
      check('confirmed choice and reason persisted with user provenance',decisions.length===1 && choice);
      const away = await ask('switch-away','切到装订校样项目，这个项目已经有选定的供货方案了吗？',b);
      check('other project has no borrowed decision',!recordsOf(away.records,'decision').length && !/Maple/i.test(away.answer));
      const back = await ask('return','回到展台选型，我们上次定的是哪一个，为什么？',a);
      check('same decision and budget ceiling recovered',!!choice && recordsOf(back.records,'decision').some(r=>r.id===choice.id) && /Maple/i.test(back.answer) && mentionsBudgetCap(back.answer));
      const noted = await ask('note-next','下一步记一下：基于选中方案的原始报价做一页采购样稿，写清选定理由、交付周期和含税总价。先记着。',a);
      check('only a next step exists before dispatch',recordsOf(noted.records,'next_step').some(r=>r.text.includes('样稿')) && report.steps.every(s=>!s.taskIds.length));
      const sent = await ask('dispatch','现在按刚记的下一步交给后台做吧，Word 存为项目目录下的 采购样稿.docx。这次样稿不用另派人验收。',a);
      check('exactly one background task submitted',sent.taskIds.length===1);
      if (sent.taskIds.length!==1) throw Error('no_unique_task_to_verify');
      [id] = sent.taskIds;
      const detail = await api('/background-task',{id});
      const {projectId,goal,constraints,acceptanceCriteria,inputSnapshot,projectContext,documentOutputPath,requestId} = detail.task;
      const fixedDecisions = projectContext?.summary?.decisions ?? [];
      report.dispatch = {id,projectId,requestId,goal,constraints,acceptanceCriteria,settings:pick(detail.task,replayFields),documentOutputPath,files:inputSnapshot?.files.map(({path,sha256})=>({path,sha256})),decisions:fixedDecisions.map(({id,text})=>({id,text})),nextSteps:projectContext?.summary?.nextSteps.map(d=>d.text)};
      save();
      check('original project, confirmed decision and next step reach worker',projectId===a.id && requestId===sent.id && choice && fixedDecisions.some(d=>d.id===choice.id) && report.dispatch.nextSteps?.some(s=>s.includes('样稿')));
      const handoff = [goal,constraints,acceptanceCriteria,...fixedDecisions.map(d=>d.text)].join('\n');
      check('worker received the chosen offer and budget ceiling',/Maple/i.test(handoff) && mentionsBudgetCap(handoff));
      check('worker received the selected quote version',report.dispatch.files?.some(f=>f.sha256===report.inputs.Maple.sha));
      const queried = await ask('query','刚才那份采购样稿后台做得怎么样了？',a);
      check('progress query observes original task only',queried.taskIds.length===1 && queried.taskIds[0]===id && queried.tools.some(t=>t.ok&&['background_task_status','background_task_list','background_task_log','project_context','team_overview'].includes(t.tool)) && !queried.tools.some(t=>/start$/.test(t.tool)));
    }
    captureWorker(home,evidence,token,'before_wait');
    let lastEvidence=0;
    const done = await wait(async()=>{
      if (Date.now()-lastEvidence>15000) {
        captureWorker(home,evidence,token,'running');
        lastEvidence=Date.now();
      }
      const row=await api('/background-task',{id});
      return ['failed','cancelled','waiting_input','paused','interrupted','completed'].includes(row.task.status) && row;
    },420000);
    report.workerStatus=done.task.status; save();
    check('worker completed',done.task.status==='completed');
    const artifact=join(a.workspace,'采购样稿.docx');
    if (existsSync(artifact)) {
      copyFileSync(artifact,join(evidence,'采购样稿.docx'));
      const body = execFileSync('python3',['-I','-c','import sys,zipfile,xml.etree.ElementTree as ET; print(" ".join(ET.fromstring(zipfile.ZipFile(sys.argv[1]).read("word/document.xml")).itertext()))',artifact],{encoding:'utf8'});
      report.deliveredText=body; save();
      check('Word contains selected offer, real price, duration and budget ceiling',/Maple/i.test(body) && compact(body).includes(String(mapleCost)) && /[8八]\s*(?:个工作日|个自然日|天|日)/.test(body) && mentionsBudgetCap(body));
    } else check('requested Word exists',false);
    check('source PDFs unchanged',Object.values(report.inputs).every(s=>sha(readFileSync(join(a.workspace,s.file)))===s.sha));
  } catch (error) {
    report.error=error.message;
  } finally {
    try {
      if (existsSync(join(home,'bridge.sqlite'))) report.capturedWorkers=captureWorker(home,evidence,token,report.error??report.workerStatus??'exit');
    } catch (error) {report.workerEvidenceError=error.message;report.error??='worker_evidence_unavailable';}
    if (child.exitCode===null && !child.signalCode) {
      const exited=once(child,'exit');
      child.kill('SIGTERM');
      const timer=setTimeout(()=>child.kill('SIGKILL'),6000);
      try{await exited;}finally{clearTimeout(timer);}
    }
    rmSync(home,{recursive:true,force:true});
    report.finishedAt=new Date().toISOString();
    report.passed=!report.error && report.checks.every(c=>c.passed);
    save(); console.log(JSON.stringify({passed:report.passed,error:report.error,failures:report.checks.filter(c=>!c.passed)}));
  }
  return report.passed;
}
if (resolve(process.argv[1]??'')===import.meta.filename) {
  const args=process.argv.slice(2);
  if (args.length && (args[0]!=='--replay-worker' || args.length!==2)) throw Error('usage: verify-a3-decision.mjs [--replay-worker report.json]');
  process.exitCode=await run(args[1])?0:1;
}
