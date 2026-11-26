import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Operations} from '../operations.mjs';
import {ProjectStore,DEFAULT_PROJECT_ID} from '../projects/store.mjs';
import {createHandoffTool,readHandoffSource,recentHandoffs} from '../projects/handoff.mjs';

function fixture(t){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'nova-handoff-'))),workspace=join(home,'code');
  let ops,store,handler,active;
  function open(){
    ops=new Operations({home,workspace});store=new ProjectStore({ops,home,workspace});
    handler=createHandoffTool({store,ops,state:()=>store.state(),detail:id=>store.detail(id)},()=>active)[3];
  }
  open();
  t.after(()=>{ops.close();rmSync(home,{force:true,recursive:true});});
  return {get ops(){return ops;},get store(){return store;},workspace,
    turn(input){
      const id=randomUUID(),binding=store.state();active={id,binding};
      ops.submit(id,input);ops.finish(id,{binding,projectId:binding.projectId});
      return args=>handler(args);
    },
    select(projectId){store.select({actionId:randomUUID(),revision:store.state().revision,projectId,focus:'work'});},
    restart(){ops.close();open();active=null;}
  };
}
const first={action:'prepare',title:'列表清理器',brief:'保留输入顺序并除去空白项，回传代码差异和测试。',criteria:['保留非空项','过滤空白项']};

test('two manual rounds keep immutable briefs, linked evidence, user decisions, and scoped recovery',t=>{
  const f=fixture(t),p=DEFAULT_PROJECT_ID,source=join(f.workspace,'list.mjs');
  writeFileSync(source,'export const clean = x=>x;');
  const ref=f.store.mutateReference({action:'add',actionId:randomUUID(),projectId:p,revision:1,kind:'file',path:source}).result;
  const prep=f.turn('交给 Codex 改进列表清理器'),args={...first,referenceIds:[ref.id]};
  const initial=prep(args),h=initial.handoffId;
  assert.equal(prep(args).source.sourceId,initial.source.sourceId);
  assert.throws(()=>prep({...args,brief:'另一个说明'}),/handoff_request_action_conflict/);
  assert.equal(initial.status,'待交接');
  assert.ok(initial.source.text.includes(ref.version.fingerprint));
  const forwarded=f.turn('我已经交给 Codex。')({action:'sent',handoffId:h,round:1,quote:'我已经交给 Codex'});
  assert.equal(forwarded.status,'用户已转交');
  const received=f.turn('回传 '+h+'@v1，提交 abc123\nok 1 - nonblank\nnot ok 2 - whitespace');
  const review=received({action:'review',handoffId:h,round:1,quote:'提交 abc123',results:[
    {criterionId:'C1',status:'passed',evidence:'ok 1 - nonblank'},{criterionId:'C2',status:'passed',evidence:'ok 2 - whitespace'}]});
  assert.deepEqual(review.checks.map(x=>x.status),['passed','failed']);
  assert.equal(review.checks[1].evidence,'not ok 2 - whitespace');
  assert.ok(review.source.text.includes('提交 abc123'));
  assert.ok(review.source.links.some(l=>l.sourceId===initial.source.sourceId));
  const next=f.turn('请返工，只补空白项。')({action:'rework',handoffId:h,round:1,quote:'请返工，只补空白项'});
  assert.equal(next.round,2);
  assert.equal(next.checks[0].sourceRequestId,review.source.requestId);
  assert.match(next.source.text,/本轮待补 C2/);
  assert.ok(next.source.links.some(l=>l.sourceId===review.source.sourceId));
  const wrong=f.turn('第一轮回执 ok 2 - whitespace');
  const update={action:'review',handoffId:h,round:2,quote:'ok 2 - whitespace',results:[{criterionId:'C2',status:'passed',evidence:'ok 2 - whitespace'}]};
  assert.throws(()=>wrong(update),/handoff_delivery_binding_mismatch/);
  assert.throws(()=>f.turn('ok 2 - whitespace')(update),/handoff_delivery_needs_round/);
  assert.throws(()=>f.turn(h+'@v1 ok 2 - whitespace')(update),/handoff_delivery_binding_mismatch/);
  const review2=f.turn('第二轮回传 ok 2 - whitespace')(update);
  assert.deepEqual(review2.checks.map(x=>x.status),['passed','passed']);
  assert.equal(review2.checks[0].sourceRequestId,review.source.requestId);
  assert.equal(review2.checks[1].sourceRequestId,review2.source.requestId);
  const adopted=f.turn('我采纳这个结果。')({action:'adopt',handoffId:h,round:2,quote:'我采纳'});
  assert.equal(adopted.status,'用户已采纳');
  const b=f.store.mutate({action:'create',actionId:randomUUID(),name:'项目乙'}).result;
  f.select(b.id);
  assert.deepEqual(f.turn('看看进度')({action:'list'}).handoffs,[]);
  assert.throws(()=>f.turn('读取甲')({action:'read',handoffId:h}),/handoff_not_found/);
  assert.throws(()=>readHandoffSource(f.ops,b.id,initial.source.sourceId),/handoff_source_not_found/);
  f.restart();f.select(p);
  assert.deepEqual(readHandoffSource(f.ops,p,initial.source.sourceId),initial.source);
  const read=f.turn('上次还差什么？')({action:'read',handoffId:h});
  assert.equal(read.source.sourceId,adopted.source.sourceId);assert.equal(read.editions.length,6);
  assert.equal(recentHandoffs(f.ops,p)[0].latestSourceId,adopted.source.sourceId);
  assert.equal(f.ops.list('tool')[0].sources.length,6);
});

test('self-report, false evidence, ambiguous work, and quoted third-party approvals cannot change adoption',t=>{
  const f=fixture(t),h=f.turn('生成说明')(first).handoffId;
  const base={action:'review',handoffId:h,round:1,quote:'全部完成'};
  const user=f.turn('Codex 回报全部完成，all tests passed successfully');
  assert.throws(()=>user({...base,results:[{criterionId:'C1',status:'passed',evidence:'ok 1 - nonblank'}]}),/handoff_user_quote_required/);
  const report=user({...base,results:[{criterionId:'C1',status:'passed',evidence:'all tests passed successfully'}]});
  assert.deepEqual(report.checks.map(c=>c.status),['reported','missing']);
  for(const input of ['可以采纳吗？','我没有采纳','Codex 说：“我采纳”','如果没问题我就采纳']){
    assert.throws(()=>f.turn(input)({action:'adopt',handoffId:h,round:1,quote:'采纳'}),/handoff_explicit_user_decision_required/);
  }
  assert.throws(()=>f.turn('如果需要返工怎么办？')({action:'rework',handoffId:h,round:1,quote:'返工'}),/handoff_explicit_user_decision_required/);
  const other=f.turn('生成另一个说明')({...first,title:'图例清理器'}).handoffId;
  const stale=f.turn('已回传 ok 1 - test');
  assert.throws(()=>stale({...base,quote:'ok 1 - test',results:[{criterionId:'C1',status:'passed',evidence:'ok 1 - test'}]}),/handoff_delivery_needs_identification/);
  const again=f.turn(other+'@v1 ok 1 - test');
  assert.throws(()=>again({...base,quote:'ok 1 - test',results:[{criterionId:'C1',status:'passed',evidence:'ok 1 - test'}]}),/handoff_delivery_binding_mismatch/);
  const accepted=f.turn(h+'@v1，我采纳，有一个条件待核实。')({action:'adopt',handoffId:h,round:1,quote:'我采纳'});
  assert.equal(accepted.status,'用户已采纳');
  assert.deepEqual(accepted.checks.map(c=>c.status),['reported','missing']);
});

test('explicit scope changes preserve withdrawn conditions and isolate later rounds',t=>{
  const f=fixture(t),h=f.turn('准备任务')(first).handoffId;
  f.turn('完成了')({action:'review',handoffId:h,round:1,quote:'完成了',results:[{criterionId:'C1',status:'reported',evidence:'完成了'}]});
  const revise={action:'rework',handoffId:h,round:1,omitCriterionIds:['C2'],extraCriteria:['重复项按输入顺序返回']};
  assert.throws(()=>f.turn('请返工')({...revise,quote:'请返工'}),/handoff_scope_decision_required/);
  const result=f.turn('调整范围，移出空白项，增加重复项按输入顺序返回。')({...revise,quote:'调整范围，移出空白项，增加重复项按输入顺序返回'});
  assert.equal(result.round,2);assert.equal(result.checks[1].excluded,true);
  assert.equal(result.checks[2].id,'C3');assert.match(result.source.text,/本轮待补 C1、C3/);
  assert.ok(!f.turn('第一轮历史')({action:'read',handoffId:h,round:1}).checks.some(c=>c.excluded));
});

test('a returned log is cited from the scoped read receipt and keeps its excerpt if the file changes',t=>{
  const f=fixture(t),p=DEFAULT_PROJECT_ID,h=f.turn('准备说明')(first).handoffId;
  const path=join(f.workspace,'codex.log'),input='核对第一轮的 codex.log',review=f.turn(input);
  const requestId=f.ops.list('request').find(r=>r.input===input).id;
  const args={action:'review',handoffId:h,round:1,quote:'codex.log',results:[
    {criterionId:'C1',status:'passed',evidence:'ok 1 - basic',readPath:path}
  ]};
  const record={id:'file-log',kind:'tool',tool:'read',operation:'read',projectId:p,requestId,status:'completed',path,cwd:f.workspace,output:h+'@v1\n3 | ok 1 - basic'};
  assert.throws(()=>review(args),/handoff_evidence_read_required/);
  f.ops.put({...record,id:'other-project-read',projectId:'other'});
  assert.throws(()=>review(args),/handoff_evidence_read_required/);
  f.ops.put({...record,output:h+'@v2\n3 | ok 1 - basic'});
  assert.throws(()=>review(args),/handoff_delivery_binding_mismatch/);
  f.ops.put(record);
  assert.throws(()=>review({...args,results:[{...args.results[0],evidence:'ok 1 - other'}]}),/handoff_read_excerpt_not_found/);
  const result=review(args),check=result.checks[0];
  assert.equal(check.status,'passed');assert.equal(check.read.id,record.id);assert.match(check.read.observedOutputSha256,/^[a-f0-9]{64}$/);
  writeFileSync(path,'not ok 1 - basic');
  assert.ok(readHandoffSource(f.ops,p,result.source.sourceId).text.includes('3 | ok 1 - basic'));
  assert.throws(()=>f.turn('再看 codex.log')(args),/handoff_evidence_read_required/);
});

test('round binding separates the delivery and user decision from next-round instructions and historical evidence',t=>{
  const f=fixture(t),h=f.turn('准备说明')({...first,title:'清单计数器'}).handoffId;
  const r1='清单计数器项目，以下是我带回的第一轮交付。请核对两条验收并保存本轮记录。\n修复前\nnot ok 1 - empty input returns zero\n修复后\nok 1 - empty input returns zero\n**C2：留待第 2 轮，未修复、未执行测试。**';
  f.turn(r1)({action:'review',handoffId:h,round:1,quote:'以下是我带回的第一轮交付',results:[{criterionId:'C1',status:'passed',evidence:'ok 1 - empty input returns zero'}]});
  const decision='清单计数器第一轮我决定返工。C1 保留已通过的证据，第二轮只需补 C2 的修复和测试。请保存第二版说明。';
  const next=f.turn(decision)({action:'rework',handoffId:h,round:1,quote:decision});
  assert.equal(next.round,2);assert.equal(next.checks[0].status,'passed');
  const args={action:'review',handoffId:h,round:2,quote:'核对交付',results:[{criterionId:'C2',status:'passed',evidence:'ok 2 - whitespace'}]};
  assert.throws(()=>f.turn('核对交付，第一轮回传\nok 2 - whitespace')(args),/handoff_delivery_binding_mismatch/);
  assert.throws(()=>f.turn('核对交付，交接标识 '+h+'@v1。沿用第二轮的讨论。\nok 2 - whitespace')(args),/handoff_delivery_binding_mismatch/);
  assert.throws(()=>f.turn('核对交付，来自 Codex 的交接标识 '+h+'@v1。\nok 2 - whitespace')(args),/handoff_delivery_binding_mismatch/);
  const readPath=join(f.workspace,'second.log'),input='第二轮核对交付，保留第一轮的证据。请看 second.log。',review=f.turn(input);
  const requestId=f.ops.list('request').find(r=>r.input===input).id;
  f.ops.put({kind:'tool',operation:'read',tool:'read',id:'r2-log',requestId,projectId:DEFAULT_PROJECT_ID,path:readPath,status:'completed',
    output:'交接标识 '+h+'@v2\n证据沿用 '+h+'@v1\nok 2 - whitespace'});
  const checked=review({...args,results:[{...args.results[0],readPath}]});
  assert.deepEqual(checked.checks.map(c=>c.status),['passed','passed']);
  const adopt='我采纳第二轮交付。回顾第一轮时 C2 尚缺证。';
  assert.equal(f.turn(adopt)({action:'adopt',handoffId:h,round:2,quote:adopt}).status,'用户已采纳');
});
