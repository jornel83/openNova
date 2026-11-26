import {dirname} from 'node:path';
import {realpathSync} from 'node:fs';
import {captureEvidence,projectFile,sha256,sourceStatus} from './evidence.mjs';

const runKind = 'experiment_run';
const idPattern = /^experiment-[a-f0-9]{64}$/;
const checkedText = (value, limit) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw Error('invalid_experiment_description');
  return value.trim();
};
const roles = {data:'输入数据',config:'配置',log:'日志',sample:'样音',model:'模型',artifact:'产物'};
const stringValue = {type:'string'};
const schema = {
  experiment:{type:'string',description:'同一组可比较运行共用的实验名称。'}, title:{type:'string',description:'本轮名称。'},
  modelVersion:{type:'string',description:'实验实际使用的模型或公开模型资源版本。未知时留空；有明确配置值时宿主会读取。'},
  files:{type:'array',items:{type:'object',additionalProperties:false,properties:{role:{type:'string',enum:Object.keys(roles)},
    path:{type:'string',description:'项目内文件。清单内的相对路径从清单目录解析。'},
    mode:{type:'string',enum:['snapshot','reference'],description:'默认 snapshot 保存文件内容。大模型或大型数据用 reference，只登记实际位置、版本与流式校验值。'},
    sha256:{type:'string',description:'有原始校验值时传入，发生变化即停止。'}}}},
  findings:{type:'array',items:{type:'object',additionalProperties:false,properties:{text:stringValue,
    evidence:{type:'array',items:stringValue,description:'支持此结论的文件路径，须出现在同一组 files 中。'}}}},
};

function runForProject(ops, projectId, runId) {
  if (!idPattern.test(runId ?? '')) throw Error('unknown_experiment_run');
  const row = ops.db.prepare("SELECT body FROM records WHERE id=? AND kind=? AND json_extract(body,'$.projectId')=?").get(runId,runKind,projectId);
  if (!row) throw Error('unknown_experiment_run');
  return withModelEvidence(JSON.parse(row.body));
}

function withModelEvidence(run) {
  const modelEvidence = run.files.filter(file=>run.modelVersion && ['config','log','model'].includes(file.role) &&
    (Object.values(file.settings??{}).includes(run.modelVersion) || file.preview?.includes(run.modelVersion))).map(file=>file.path);
  return {...run,modelEvidence};
}

function runSummary({id,experiment,title,modelVersion,createdAt,files,findings,modelEvidence}) {
  return {id,experiment,title,modelVersion,createdAt,modelEvidence,
    files:files.map(({preview,settings,...file}) => file),findings};
}

function listRuns(ops,projectId,experiment,offset=0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw Error('invalid_experiment_offset');
  const rows = ops.db.prepare("SELECT body FROM records WHERE kind=? AND json_extract(body,'$.projectId')=? AND (? IS NULL OR json_extract(body,'$.experiment')=?) ORDER BY rowid DESC LIMIT 21 OFFSET ?")
    .all(runKind,projectId,experiment??null,experiment??null,offset);
  return {runs:rows.slice(0,20).map(row => runSummary(withModelEvidence(JSON.parse(row.body)))),nextOffset:rows.length>20?offset+20:null};
}

async function register(ops, request, args) {
  const {projectId,cwd} = request.binding, workspace = realpathSync(cwd);
  let spec = args, base = workspace;
  if (args.manifestPath !== undefined) {
    if (Object.keys(schema).some(key => args[key] !== undefined)) throw Error('ambiguous_experiment_input');
    const manifest = projectFile(workspace,base,args.manifestPath,64*1024);
    try {spec = JSON.parse(manifest.bytes);} catch {throw Error('invalid_experiment_manifest');}
    base = dirname(manifest.path);
  }
  if (!spec || Array.isArray(spec) || typeof spec !== 'object') throw Error('invalid_experiment_manifest');
  const experiment = checkedText(spec.experiment,200), title = checkedText(spec.title,200);
  const declaredModel = spec.modelVersion == null ? null : checkedText(spec.modelVersion,300);
  if (!Array.isArray(spec.files) || !spec.files.length || spec.files.length>16) throw Error('invalid_experiment_files');
  const frozen = [], paths = new Map();
  let total = 0;
  for (const entry of spec.files) {
    const file = await captureEvidence(workspace,base,entry,request.signal);
    if (entry.sha256 !== undefined && entry.sha256 !== file.descriptor.sha256) throw Error('experiment_file_changed');
    if (paths.has(entry.path) || [...paths.values()].some(f => f.path===file.descriptor.path)) throw Error('duplicate_experiment_file');
    total += file.bytes?.length??0;
    if (total > 16*1024*1024) throw Error('experiment_evidence_too_large');
    paths.set(entry.path,file.descriptor); frozen.push(file);
  }
  const inputFindings = spec.findings ?? [];
  if (!Array.isArray(inputFindings) || inputFindings.length > 12) throw Error('invalid_experiment_findings');
  const findings = inputFindings.map(f => {
    const text = checkedText(f?.text,1000);
    if (!Array.isArray(f.evidence) || !f.evidence.length || f.evidence.length > paths.size || f.evidence.some(path => !paths.has(path)))
      throw Error('experiment_finding_requires_evidence');
    return {kind:'reported',text,evidence:[...new Set(f.evidence.map(path=>paths.get(path).path))]};
  });
  const files = frozen.map(f=>f.descriptor);
  const configuredModels = new Set(files.filter(file=>file.role==='config').map(file=>file.settings?.modelVersion)
    .filter(value=>typeof value==='string' && value.trim()));
  const configuredModel = configuredModels.size===1 ? [...configuredModels][0] : null;
  if (declaredModel && configuredModel && declaredModel!==configuredModel) throw Error('experiment_model_version_conflict');
  const modelVersion = declaredModel ?? configuredModel;
  for (const file of files.filter(f=>f.audio)) {
    findings.push({kind:'measured',text:`WAV 时长 ${file.audio.durationSeconds} 秒，采样率 ${file.audio.sampleRate} Hz，${file.audio.channels} 声道。`,evidence:[file.path]});
  }
  const data = {projectId,experiment,title,modelVersion,files,findings};
  const id = 'experiment-' + sha256(JSON.stringify(data));
  const db = ops.db;
  db.exec('CREATE TABLE IF NOT EXISTS experiment_blob (sha256 TEXT PRIMARY KEY, bytes BLOB NOT NULL)');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (request.cancelled) throw Error('bridge_request_required');
    request.signal?.throwIfAborted();
    const old = db.prepare('SELECT 1 FROM records WHERE id=? AND kind=?').get(id,runKind);
    if (!old) {
      const insert = db.prepare('INSERT OR IGNORE INTO experiment_blob VALUES (?,?)');
      for (const {descriptor,bytes} of frozen) if (bytes) insert.run(descriptor.sha256,bytes);
      ops.put({id,kind:runKind,...data,workspace,requestId:request.id,createdAt:Date.now()});
    }
    db.exec('COMMIT');
  } catch (error) {db.exec('ROLLBACK');throw error;}
  return runSummary(runForProject(ops,projectId,id));
}

function compare(ops,projectId,ids) {
  if (!Array.isArray(ids) || ids.length!==2 || ids[0]===ids[1]) throw Error('two_experiment_runs_required');
  const runs = ids.map(id => runForProject(ops,projectId,id));
  if (runs[0].experiment !== runs[1].experiment) throw Error('experiment_group_mismatch');
  const [before,after] = runs;
  const inputHashes = runs.map(run=>run.files.filter(f=>f.role==='data').map(f=>f.sha256).sort());
  const sameInput = inputHashes.every(group=>group.length) ? JSON.stringify(inputHashes[0])===JSON.stringify(inputHashes[1]) : null;
  const samples = runs.map(run=>run.files.filter(f=>f.role==='sample'&&f.audio));
  const configs = runs.map(run=>run.files.filter(f=>f.role==='config'));
  const changes = [];
  if (configs.every(group=>group.length===1&&group[0].settings)) {
    const [a,b] = configs.map(([file])=>file.settings);
    for (const key of new Set([...Object.keys(a),...Object.keys(b)]))
      if (a[key]!==b[key]) changes.push({key,before:Object.hasOwn(a,key)?a[key]:undefined,after:Object.hasOwn(b,key)?b[key]:undefined});
  }
  let duration;
  if (samples.every(group=>group.length===1)) {
    const [a,b] = samples.map(([f])=>f.audio.durationSeconds);
    duration = {beforeSeconds:a,afterSeconds:b,deltaSeconds:Number((b-a).toFixed(3)),
      evidence:samples.map(([file],i)=>({runId:runs[i].id,path:file.path,sha256:file.sha256}))};
  }
  const configurationChanged = configs.every(files=>files.length) ?
    JSON.stringify(configs[0].map(x=>x.sha256).sort())!==JSON.stringify(configs[1].map(x=>x.sha256).sort()) : null;
  return {experiment:before.experiment,runs,sameInput,modelChanged:before.modelVersion&&after.modelVersion ? before.modelVersion!==after.modelVersion : null,
    configurationChanged,configurationSummary:configurationChanged&&!changes.length?'配置文件内容有变化，需展开两轮配置核对具体差异。':undefined,
    changes,duration};
}

export function readExperimentSource(ops,projectId,sourceId) {
  const run = runForProject(ops,projectId,sourceId);
  const evidence = run.files.map(file=>`${roles[file.role]} · ${file.mode==='reference'?'仅引用 · '+file.location:file.path}\nSHA-256 ${file.sha256}`).join('\n');
  const findings = run.findings.map(f=>`${f.kind==='measured'?'实测':'记录结论'} · ${f.text}\n依据 ${f.evidence.join('、')}`).join('\n');
  return {sourceId,projectId,runId:run.id,kind:'experiment',title:run.experiment+' · '+run.title,
    text:[run.experiment+' · '+run.title,'固定记录 '+run.id,'模型版本 '+(run.modelVersion??'待补充'),
      run.modelEvidence.length?'版本标识见 '+run.modelEvidence.join('、'):'配置与日志摘要中未找到版本标识',evidence,findings].filter(Boolean).join('\n\n')};
}

const playbackGuide = '在本条对话的实验记录或项目概览 → 实验成果中展开已保存的样音播放。仅引用项显示原件位置和版本状态。文件字段是实验来源，不能作为网页下载或播放链接。';

function addReceipt(ops,request,action,result,runs) {
  const {projectId}=request.binding, sourceIds=runs.map(run=>run.id);
  const id='experiment-receipt-'+sha256(JSON.stringify([request.id,action,sourceIds]));
  if (!ops.db.prepare('SELECT 1 FROM records WHERE id=?').get(id)) {
    const now=Date.now();
    ops.put({id,kind:'tool',operation:'project_experiment',tool:'project_experiment',status:'completed',
      action,projectId,requestId:request.id,createdAt:now,finishedAt:now,
      description:action==='compare'?'比较实验固定版本':'登记实验固定版本',sourceIds,
      sources:runs.map(run=>({sourceId:run.id,projectId,title:run.experiment+' · '+run.title,kind:'experiment'}))});
  }
  return {...result,playbackGuide};
}

export function createExperimentTool({ops,getRequest}) {
  return ['project_experiment','登记、查看、比较当前项目的实验运行。record 可指定现有 JSON 清单 manifestPath，或按对话直接传实验、轮次、模型版本与证据文件。list 在重启后找回固定 id；inspect 传单个 runIds 查看原件变更/缺失状态；compare 按先后传同组两个 runIds。'+playbackGuide, {
    action:{type:'string',required:true,enum:['record','list','inspect','compare']},
    manifestPath:{type:'string',description:'项目内实验清单 JSON，与直接传实验字段二选一。'},
    ...schema,runIds:{type:'array',items:stringValue},offset:{type:'integer'},
  }, args=>{
    const request = getRequest();
    if (!request?.id || request.cancelled || request.binding?.focus!=='work' || !request.binding.projectId)
      throw Error('project_work_request_required');
    const {projectId}=request.binding;
    if (args.action==='inspect') {
      if (!Array.isArray(args.runIds) || args.runIds.length!==1) throw Error('one_experiment_run_required');
      const run=runForProject(ops,projectId,args.runIds[0]);
      return inspectSources(run,request.binding.cwd,request.signal);
    }
    if (args.action==='list') return listRuns(ops,projectId,args.experiment,args.offset);
    if (args.action==='compare') {
      const result=compare(ops,projectId,args.runIds);
      return addReceipt(ops,request,'compare',result,result.runs);
    }
    if (args.action==='record') {
      return register(ops,request,args).then(run=>addReceipt(ops,request,'record',run,[run]));
    }
    throw Error('invalid_experiment_action');
  }];
}

async function inspectSources(run,cwd,signal) {
  const files=[];
  for (const file of run.files) files.push({...file,sourceStatus:await sourceStatus(cwd,run.workspace,file,signal)});
  return {...run,files};
}

export function experimentControl(path,{ops,projects},body) {
  if (!body?.expectedProject) throw Error('project_state_changed');
  const state = projects.validateExpected(body.expectedProject);
  if (!state.projectId || state.focus!=='work') throw Error('project_work_request_required');
  if (path==='/project-experiments' && body.checkSource) {
    const run=runForProject(ops,state.projectId,body.runId);
    const file=run.files.find(f=>f.path===body.path&&f.sha256===body.sha256);
    if (!file) throw Error('unknown_experiment_evidence');
    return sourceStatus(projects.project().workspace,run.workspace,file).then(result=>{
      projects.validateExpected(body.expectedProject);
      return result;
    });
  }
  if (path==='/project-experiments' && Array.isArray(body.runIds) && body.runIds.length===1)
    return {runs:[runForProject(ops,state.projectId,body.runIds[0])]};
  if (path==='/project-experiments')
    return body.runIds!==undefined ? compare(ops,state.projectId,body.runIds) : listRuns(ops,state.projectId,body.experiment,body.offset);
  if (path!=='/experiment-evidence') throw Error('unknown_experiment_route');
  const run = runForProject(ops,state.projectId,body.runId);
  const file = run.files.find(entry=>entry.path===body.path && entry.sha256===body.sha256);
  if (!file) throw Error('unknown_experiment_evidence');
  if (file.mode==='reference') throw Error('experiment_reference_has_no_snapshot');
  const row = ops.db.prepare('SELECT bytes FROM experiment_blob WHERE sha256=?').get(file.sha256);
  if (!row || row.bytes.length!==file.size || sha256(row.bytes)!==file.sha256) throw Error('experiment_evidence_damaged');
  return {bytes:Buffer.from(row.bytes),contentType:file.contentType};
}
