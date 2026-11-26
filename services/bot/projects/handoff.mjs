import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

const kind = 'project_handoff_edition';
const digest = value => createHash('sha256').update(value).digest('hex');
const labels = {passed:'据回传证据通过', failed:'回传证据显示失败', missing:'缺少证据', reported:'外部自报，待核实'};
const phase = {prepare:'待交接', sent:'用户已转交', review:'已核对回传', rework:'待交接', adopt:'用户已采纳'};
const forms = {prepare:'brief', rework:'brief', review:'review', adopt:'decision', sent:'decision'};
const commandHash = args => digest(JSON.stringify(args,(_,val)=>val&&typeof val==='object'&&!Array.isArray(val)
  ? Object.fromEntries(Object.entries(val).sort(([a],[b])=>a.localeCompare(b))) : val));

function value(text, limit, error) {
  if (typeof text !== 'string' || !text.trim() || text.length > limit || text.includes('\0')) throw Error(error);
  return text.trim();
}
function quoted(request, text) {
  const quote = value(text, 6000, 'handoff_user_quote_required');
  if (!request.input.includes(quote)) throw Error('handoff_user_quote_required');
  return quote;
}

function history(ops, projectId, handoffId) {
  return ops.db.prepare("SELECT body FROM records WHERE kind=? AND json_extract(body,'$.projectId')=? AND json_extract(body,'$.handoffId')=? ORDER BY rowid")
    .all(kind,projectId,handoffId).map(row=>JSON.parse(row.body));
}
function edition(row) {
  const {id:sourceId, projectId,handoffId,round,title,text,links,requestId} = row;
  return {sourceId,projectId,handoffId,round,kind:forms[row.action],title,text,links,requestId,sha256:digest(text)};
}
export function readHandoffSource(ops,projectId,sourceId) {
  const row = ops.db.prepare("SELECT body FROM records WHERE id=? AND kind=? AND json_extract(body,'$.projectId')=?").get(sourceId,kind,projectId);
  if (!row) throw Error('handoff_source_not_found');
  return edition(JSON.parse(row.body));
}
export function recentHandoffs(ops,projectId,limit=5) {
  if (!projectId) return [];
  return ops.db.prepare(`SELECT json_extract(body,'$.handoffId') handoffId,json_extract(body,'$.subject') title,
    json_extract(body,'$.round') round,json_extract(body,'$.status') status,id latestSourceId FROM records
    WHERE kind=? AND json_extract(body,'$.projectId')=? GROUP BY handoffId ORDER BY MAX(rowid) DESC LIMIT ?`)
    .all(kind,projectId,limit);
}

function excerptRows(ids, rows, summarize) {
  if (!Array.isArray(ids) || ids.length>16 || new Set(ids).size!==ids.length) throw Error('invalid_handoff_context_ids');
  return ids.map(id=>{
    const row = rows.find(r=>r.id===id && r.status==='active');
    if (!row) throw Error('invalid_handoff_context_ids');
    return summarize(row);
  });
}
function inputs(projects, projectId, args) {
  const {project,references,records} = projects.detail(projectId);
  return {
    name:project.name, goal:project.goal,
    references:excerptRows(args.referenceIds??[],references,ref=>({
      title:ref.title, location:ref.path??ref.url, version:ref.version, revision:ref.revision,
      availability:ref.availability, observedVersion:ref.observedVersion, readStatus:ref.readStatus, id:ref.id
    })),
    decisions:excerptRows(args.decisionIds??[],records.filter(r=>r.type==='decision'),r=>({text:r.text,id:r.id,revision:r.revision})),
  };
}
function initialChecks(items) {
  if (!Array.isArray(items)||!items.length||items.length>16) throw Error('invalid_handoff_criteria');
  const texts = items.map(s=>value(s,1000,'invalid_handoff_criteria'));
  if (new Set(texts).size!==texts.length) throw Error('invalid_handoff_criteria');
  return texts.map((text,i)=>({id:'C'+(i+1),text,status:'missing'}));
}

const failedOutput = /\bnot ok\s+\d|(?:^|\n)\s*(?:[✗✖]|FAIL(?:ED)?\s+\S)|\b[1-9]\d*\s+(?:failed|failing)\b|\bexit(?:\s+code)?\s*[:=]\s*[1-9]\d*\b|^\s*\S+::\S+\s+FAILED\b/m;
function evidenceStatus(status, evidence, full) {
  if (!['passed','failed'].includes(status)) return status;
  const positive = /(?:^|\n)\s*(?:ok\s+\d|[✓✔]|PASS(?:ED)?\s+\S)|\b[1-9]\d*\s+(?:passed|passing)\b|\bexit(?:\s+code)?\s*[:=]\s*0\b|^\s*\S+::\S+\s+PASSED\b|\.{3}\s+ok\s*$/m;
  const observable = /^@@\s+-\d|^diff --git |^\s*(?:expected|actual|预期|实际)\s*[:：=]\s*\S/im;
  if (failedOutput.test(full)) return 'failed';
  if (positive.test(evidence)) return status==='passed'?'passed':'reported';
  return observable.test(evidence) ? status : 'reported';
}

function evidenceLines(body,excerpt) {
  // Before/after runs often print “not ok 1” followed by “ok 1”. Prefer the
  // complete quoted output line to an accidental substring in the earlier run.
  let start=body.indexOf(excerpt);
  for(let pos=start;pos>=0;pos=body.indexOf(excerpt,pos+excerpt.length)){
    const lineStart=body.lastIndexOf('\n',pos-1)+1;
    if (!body.slice(lineStart,pos).trim()) {start=pos;break;}
  }
  const lineStart=body.lastIndexOf('\n',start-1)+1;
  const lineEnd=body.indexOf('\n',start+excerpt.length);
  return body.slice(lineStart,lineEnd<0?undefined:lineEnd);
}

function evidenceSource(ops, request, update, handoff) {
  if (!update.readPath) return {body:request.input};
  const path=value(update.readPath,4096,'invalid_handoff_evidence_path');
  // Only accept bytes from a read actually made during this bound turn. The path on disk can change later.
  const records=ops.db.prepare("SELECT body FROM records WHERE kind='tool' AND json_extract(body,'$.requestId')=? AND json_extract(body,'$.projectId')=? AND json_extract(body,'$.operation')='read' ORDER BY rowid DESC")
    .all(request.id,request.projectId).map(r=>JSON.parse(r.body));
  const cwd=request.binding.cwd;
  const observed=records.find(r=>r.tool==='read'&&r.status==='completed'&&typeof r.output==='string'&&typeof r.path==='string'
    && (r.path===path||cwd&&resolve(r.cwd??cwd,r.path)===resolve(cwd,path)));
  if (!observed) throw Error('handoff_evidence_read_required');
  validateTags(observed.output,handoff);
  return {body:observed.output,read:{id:observed.id,path:observed.path,observedOutputSha256:digest(observed.output)}};
}

function results(previous, updates, request, ops, handoff) {
  if (!Array.isArray(updates)||!updates.length||updates.length>previous.length) throw Error('invalid_handoff_results');
  const seen = new Set();
  const checks = previous.map(c=>({...c}));
  for (const update of updates) {
    const check = checks.find(c=>c.id===update.criterionId);
    if (!check || check.excluded || seen.has(check.id) || !Object.hasOwn(labels, update.status)) throw Error('invalid_handoff_results');
    seen.add(check.id);
    const source=evidenceSource(ops,request,update,handoff);
    const evidence=update.evidence?value(update.evidence,6000,'handoff_evidence_required'):undefined;
    if (evidence&&!source.body.includes(evidence)) throw Error(source.read?'handoff_read_excerpt_not_found':'handoff_user_quote_required');
    if (update.status!=='missing' && !evidence) throw Error('handoff_evidence_required');
    // Include the rest of the quoted line: “ok 1” alone can be cut out of “not ok 1”.
    const full=evidence&&evidenceLines(source.body,evidence);
    const status=evidenceStatus(update.status,evidence,full);
    if (check.status==='passed' && ['reported','missing'].includes(status)) continue;
    Object.assign(check,{status,evidence:full,read:source.read,sourceRequestId:request.id});
  }
  return checks;
}

function updateScope(checks, args, quote) {
  if (!args.omitCriterionIds && !args.extraCriteria) return checks;
  if (!/范围|调整|增加|新增|移出|去掉|取消|只验|只需|改为|改成|scope|drop|add|remove/i.test(quote)) throw Error('handoff_scope_decision_required');
  const omitted=args.omitCriterionIds??[];
  if (!Array.isArray(omitted)||omitted.some(id=>!checks.some(c=>c.id===id&&!c.excluded))||new Set(omitted).size!==omitted.length)
    throw Error('invalid_handoff_criteria');
  const added=args.extraCriteria ? initialChecks(args.extraCriteria) : [];
  if (checks.length+added.length>32 || added.some(next=>checks.some(c=>!omitted.includes(c.id)&&!c.excluded&&c.text===next.text))) throw Error('invalid_handoff_criteria');
  return [...checks.map(c=>omitted.includes(c.id)?{...c,excluded:true}:c),...added.map((c,i)=>({...c,id:'C'+(checks.length+i+1)}))];
}

function render(row) {
  const lines = [row.title, '项目 '+row.context.name, '交接标识 '+row.handoffId+'@v'+row.round, '状态 '+row.status,'',row.brief];
  if (row.context.goal) lines.push('项目目标 '+row.context.goal);
  for (const item of row.context.decisions) lines.push('已确认决定 '+item.text+' ['+item.id+' r'+item.revision+']');
  for (const ref of row.context.references) lines.push('资料 '+ref.title+' '+ref.location+' ['+ref.id+' r'+ref.revision+' '+(ref.version?.fingerprint??'未记录文件指纹')+'，'+ref.availability+'，'+ref.readStatus+']');
  lines.push('','验收条件');
  for (const check of row.checks) {
    const status = row.action==='prepare' ? '' : ' · '+labels[check.status];
    lines.push(check.id+' '+check.text+status+(check.excluded?' · 已按用户决定移出范围':''));
    if (check.evidence) lines.push('回传原文（'+check.sourceRequestId+'） '+check.evidence);
    if (check.read) lines.push('读取凭据 '+check.read.path+' ['+check.read.id+'，读取输出 SHA-256 '+check.read.observedOutputSha256+']');
  }
  if (row.quote) lines.push('','本轮用户原文（'+row.requestId+'）',row.quote);
  if (row.delivery && row.delivery!==row.quote) lines.push('','用户带回的完整交付信息（'+row.requestId+'）',row.delivery);
  if (row.action==='rework') lines.push('','本轮待补 '+(row.checks.filter(c=>!c.excluded&&c.status!=='passed').map(c=>c.id).join('、')||'无'));
  if (forms[row.action]==='brief') lines.push('','请在回传时附上交接标识、代码差异或提交引用，以及各验收项的测试原文。');
  return lines.join('\n');
}

function verifyDecision(action, request, quote) {
  const patterns={
    sent:/(?:已(?:经)?|刚(?:刚)?|我把|我将).{0,20}(?:发给|交给|转交|发送|转发|给了|交付给)|(?:我|已经|已).{0,8}(?:发了|发出|交出)|\bI(?:'ve| have| already)? (?:sent|forwarded|handed)\b/i,
    rework:/(?:返工|再改|重做|重新做|退回|补齐|补上|补做|补测|补交|补证|继续(?:改|修|补)|再(?:补|修)|下一轮|调整.{0,6}范围|范围.{0,6}(?:改|调整)|rework|revise|redo|change the scope)/i,
    adopt:/(?:采纳|收下|接受.{0,8}(?:交付|结果|成果|第二轮|此版|这版)|验收(?:已)?通过|同意.{0,6}(?:归档|结案|合入)|以这版为准|可以.{0,4}(?:结案|归档)|\b(?:I accept|accept this|sign off|approved)\b)/i
  };
  const ordinary=request.input.replace(/```[\s\S]*?(?:```|$)/g,'').split('\n').filter(line=>!/^\s*>/.test(line)).join('\n');
  const clauses = ordinary.match(/[^。！？!?；;\n]+[。！？!?；;]?/g)??[];
  const decision = clauses.find(clause=>{
    if (!quote.includes(clause.trim().replace(/[。！？!?；;]$/,'')) && !clause.includes(quote)) return false;
    if (/[?？“”「」]|是否|能否|可否|要不要|如果|假如|等到|再决定|尚未|还没|没有|未曾|不(?:会|要|用|必|能|同意|采纳|接受|建议|打算|返工)|暂不|先别|别(?:采纳|返工|转交)|(?:[说写]|要求)[：:]|(?:Codex|对方|工具|模型|日志|报告)(?:\s*说|建议|要求)|\b(?:not|never|if|whether)\b/i.test(clause)) return false;
    return patterns[action].test(clause)&&patterns[action].test(quote);
  });
  if (!decision) throw Error('handoff_explicit_user_decision_required');
  return decision;
}

// The returned statement can also cite an older brief or describe what to do next.
// Its source round and those references are different pieces of information.
function bindingClauses(text) {
  return text.split(/[。；;，,\n]/).filter(clause=>!/(?:沿用|引用|保留.{0,32}(?:证据|依据|检查结果)|参考|参见|(?:依据|证据|摘录|结论)(?:来自|源自)|回顾|历史|上(?:一)?轮(?:的)?(?:记录|证据|说明|标识)|留待|留到|延至|延到|计划在|拟在|previous (?:evidence|round)|carried (?:over|forward)|deferred to)/i.test(clause)
    && !/(?:第\s*[\d一二三四五六七八九十两]+\s*轮|@v\d+)\s*(?:只需|只补|再补|将|计划|拟|的已通过项)/i.test(clause));
}
function validateTags(text,prev) {
  const tags=bindingClauses(text).flatMap(clause=>[...clause.matchAll(/(handoff-[a-f0-9]{16})@v(\d+)\b/gi)]);
  if (tags.some(m=>m[1]!==prev.handoffId||Number(m[2])!==prev.round)) throw Error('handoff_delivery_binding_mismatch');
  return tags.length>0;
}
function verifyDeliveryRound(projects, request, prev, decision) {
  if (validateTags(request.input,prev)) return;
  const multiple=recentHandoffs(projects.ops,request.projectId,2).length>1;
  if (multiple&&!request.input.includes(prev.subject)) throw Error('handoff_delivery_needs_identification');
  const clauses=bindingClauses(decision??request.input);
  const rounds=clauses.flatMap(clause=>[...clause.matchAll(/(?:(?:^|交接|说明|回执|回传|任务)\s*v\s*(\d+)\b|第\s*([\d一二三四五六七八九十两]+)\s*轮|\bround\s+(\d+)\b)/gi)])
    .map(m=>{
      const n=(m[1]??m[2]??m[3]).replace('两','二'),digits='零一二三四五六七八九';
      if (/^\d+$/.test(n)) return Number(n);
      const [tens,ones]=n.split('十');
      return ones===undefined?digits.indexOf(tens):(tens?digits.indexOf(tens):1)*10+(ones?digits.indexOf(ones):0);
    });
  if (rounds.some(n=>n!==prev.round)) throw Error('handoff_delivery_binding_mismatch');
  if (!decision && prev.round>1 && !rounds.includes(prev.round)) throw Error('handoff_delivery_needs_round');
}

function recordHandoff(projects, request, args) {
  const {ops} = projects, {projectId} = request, action = args.action;
  const handoffId = action==='prepare'?'handoff-'+digest(projectId+'\n'+request.id).slice(0,16):value(args.handoffId,100,'handoff_id_required');
  const id='handoff-source-'+digest([projectId,request.id,handoffId,action].join('\n')).slice(0,32);
  const rows=history(ops,projectId,handoffId);
  const replay=rows.find(r=>r.id===id);
  if (replay) {
    if (replay.commandHash!==commandHash(args)) throw Error('handoff_request_action_conflict');
    return replay;
  }
  const prev=rows.at(-1);
  let row;
  if (action==='prepare') {
    row={subject:value(args.title,160,'handoff_title_required'),brief:value(args.brief,4000,'handoff_brief_required'),checks:initialChecks(args.criteria),
      context:inputs(projects,projectId,args),round:1};
  } else {
    if (!prev) throw Error('handoff_not_found');
    if (args.round!==prev.round) throw Error('handoff_round_changed');
    if (prev.action==='adopt') throw Error('handoff_closed');
    if (action==='sent' && !['prepare','rework'].includes(prev.action)) throw Error('handoff_already_transmitted');
    if (['rework','adopt'].includes(action) && prev.action!=='review') throw Error('handoff_review_required');
    const quote=quoted(request,args.quote);
    const decision=action==='review'?undefined:verifyDecision(action,request,quote);
    verifyDeliveryRound(projects,request,prev,decision);
    row={subject:prev.subject,brief:prev.brief,checks:prev.checks,context:prev.context,round:prev.round,quote};
    if (action==='review') {
      row.checks=results(row.checks,args.results,request,ops,prev);
      row.delivery=request.input;
    }
    if (action==='rework') {
      row.checks=updateScope(row.checks,args,quote);
      if (!row.checks.some(c=>!c.excluded&&c.status!=='passed')&&!args.omitCriterionIds) throw Error('handoff_no_pending_checks');
      row.round+=1;
    }
  }
  const brief=rows.findLast(r=>r.round===prev?.round && forms[r.action]==='brief');
  const parents=[prev,brief].filter((r,i,all)=>r&&all.indexOf(r)===i);
  const label={prepare:'交接说明',rework:'返工说明',review:'验收记录',adopt:'采纳记录',sent:'转交记录'}[action];
  Object.assign(row,{id,kind,projectId,handoffId,requestId:request.id,commandHash:commandHash(args),action,createdAt:Date.now(),status:phase[action],
    title:row.subject+' · 第 '+row.round+' 轮'+label,links:parents.map(r=>({sourceId:r.id,title:r.title}))});
  row.text=render(row);
  return ops.put(row);
}

export const HANDOFF_INSTRUCTIONS = '其他工程需要用户交给 Codex 等外部编码工具时，先读 project_context 并用 project_handoff 持久化交接说明；把相关已确认决定和项目资料 ID 传入。向用户给出可以复制的说明、轮次和交接标识。用户带回结果、要求返工或询问进度时，用本项目 project_handoff list/read 核对既有说明，review 逐项核对证据后记录，未知项保持缺证。原话表示已经转交、要求返工或最终采纳才分别用 sent/rework/adopt。旧轮次或其他项目的结果先询问归属。重启也从持久化记录继续。外部手动交接只说明用户可转交，勿自行修改源码或创建内部后台任务。';
export function createHandoffTool(projects,getRequest) {
  return ['project_handoff','保存和查阅外部代码项目的人工交接轮次。prepare 生成可复制说明，review 核对差异/测试，rework 保留已通过证据并创建下一轮，adopt 记录采纳。list/read 返回已有交接。',{
    action:{type:'string',required:true,enum:['list','read','prepare','sent','review','rework','adopt']},
    handoffId:{type:'string',description:'除 prepare/list 外填写 list 返回的本项目交接 ID。'},
    round:{type:'number',description:'修改交接时填当前轮次数字；read 时可指定历史轮次。'},
    title:{type:'string'},brief:{type:'string',description:'prepare 交接目的、范围、步骤、约束和交付要求。'},
    criteria:{type:'array',items:{type:'string'},description:'prepare 的可逐项验收条件。'},
    omitCriterionIds:{type:'array',items:{type:'string'},description:'rework 时仅按本轮用户明确调整的范围移出指定条件，保留其历史。'},
    extraCriteria:{type:'array',items:{type:'string'},description:'rework 时仅按本轮用户明确调整的范围增加的可验收条件。'},
    referenceIds:{type:'array',items:{type:'string'}},decisionIds:{type:'array',items:{type:'string'}},
    quote:{type:'string',description:'除 prepare 外写入均须摘取本轮用户转交、回传内容、返工或采纳的连续原话。'},
    results:{type:'array',description:'review 的逐项核对，只更新有新情况的项。evidence 是用户回传的逐字原文；若用户提供日志或差异文件，先 read，再填写 readPath 和该次读取的逐字摘录。缺证保留 missing，仅声称完成用 reported。',items:{type:'object',additionalProperties:false,properties:{
      criterionId:{type:'string',required:true},status:{type:'string',required:true,enum:Object.keys(labels)},evidence:{type:'string'},readPath:{type:'string'}
    }}}
  },args=>{
    const active=getRequest(), state=projects.state(), binding=active?.binding;
    if (!active?.id||active.cancelled||active.projectChanged||binding?.focus!=='work'||state.focus!=='work'||binding.projectId!==state.projectId||binding.revision!==state.revision) throw Error('project_work_request_required');
    const request=projects.ops.request(active.id);
    if (request.projectId!==binding.projectId) throw Error('project_request_mismatch');
    const {ops}=projects,{projectId}=request;
    return projects.store.transaction(()=>{
      if (args.action==='list') return {handoffs:recentHandoffs(ops,projectId,32)};
      let selected;
      if (args.action==='read') {
        const rows=history(ops,projectId,value(args.handoffId,100,'handoff_id_required'));
        if (!rows.length) throw Error('handoff_not_found');
        selected=rows.filter(r=>args.round===undefined||r.round===args.round);
        if (!selected.length) throw Error('handoff_round_not_found');
      } else {
        if (!Object.hasOwn(phase,args.action)) throw Error('invalid_handoff_action');
        selected=[recordHandoff(projects,request,args)];
      }
      const latest=selected.at(-1),sourceIds=selected.map(r=>r.id),clock=Date.now();
      ops.put({id:'handoff-op-'+digest([request.id,args.action,...sourceIds].join('\n')).slice(0,32),kind:'tool',operation:'project_handoff',status:'completed',
        projectId,requestId:request.id,handoffId:latest.handoffId,round:latest.round,sourceIds,sources:selected.map(r=>({sourceId:r.id,title:r.title})),createdAt:clock,finishedAt:clock});
      return {handoffId:latest.handoffId,round:latest.round,status:latest.status,checks:latest.checks,
        editions:selected.map(r=>({sourceId:r.id,round:r.round,kind:forms[r.action],title:r.title,links:r.links})),source:edition(latest)};
    });
  }];
}
