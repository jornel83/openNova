import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkContext} from '../desktop/context.mjs';
import {createDocumentGenerator} from '../documents/generator.mjs';
import {readDocumentProposal} from '../documents/proposals.mjs';
import {Operations} from '../operations.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = 'The material count was recorded.';
const versionPatch = {edits:[
  {op:'setCell', index:2, row:60, column:3, expectedValue:'60', value:'75'},
  {op:'setSummaryCell', index:2, column:3, expectedValue:'1830', value:'1845'},
]};

function inventory() {
  const rows = Array.from({length:60}, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    return [number, '测试物资' + number, String(index + 1), '用于检查中文显示与跨页表格完整性'];
  });
  return {schemaVersion:1, title:'测试物资采购清单', blocks:[
    {type:'paragraph', text:'本清单包含60条合成测试数据，用于检查分页和表格完整性。'},
    {type:'table', columns:['编号','物资名称','数量','说明'], rows, summary:['合计','','1830','']},
    {type:'paragraph', text:'A2-PDF-验收结束。'},
  ]};
}

function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'nova-document-undo-')));
  const workspace = join(home, 'project');
  mkdirSync(workspace);
  const context = createWorkContext({});
  let current, sequence = 0;
  const f = {home, workspace, context};
  f.turn = (projectId = 'project-a') => {
    current = {id:`turn-${++sequence}`, projectId, binding:{focus:'work', projectId, cwd:workspace, context:context.capture()}};
  };
  f.restart = () => {
    f.ops?.close();
    f.ops = new Operations({home, workspace, events:{publish:(type, row) => f.onEvent?.(type, row)}});
    f.generator = createDocumentGenerator({home, ops:f.ops, context, getRequest:() => current});
  };
  f.turn();
  f.restart();
  t.after(() => { f.ops.close(); rmSync(home, {recursive:true, force:true}); });
  return f;
}

async function create(f, format = 'docx', spec = inventory()) {
  writeFileSync(join(f.workspace, 'spec.json'), JSON.stringify(spec));
  const result = await f.generator.generate({format, specPath:'spec.json', outputPath:'物资清单.' + format});
  assert.equal(result.status, 'completed', result.error);
  return result.artifact;
}

async function revise(f, artifact, patch) {
  f.turn();
  const proposed = await f.generator.generate({action:'revise', artifactId:artifact.id, patch});
  assert.equal(proposed.phase, 'proposed', proposed.error);
  return proposed.proposal;
}

async function apply(f, proposal) {
  f.turn();
  const applied = await f.generator.decide({id:proposal.id, action:'confirm'});
  assert.equal(applied.phase, 'committed', applied.error);
  return applied.artifact;
}

async function appliedInventory(f) {
  const v1 = await create(f);
  const proposal = await revise(f, v1, versionPatch);
  const v2 = await apply(f, proposal);
  f.turn();
  return {v1, proposal, v2};
}

function confirmUndo(f, proposal, options) {
  return f.generator.decide({id:proposal.id, action:'undo'}, options);
}

function documentText(artifact) {
  if (artifact.format === 'docx') {
    const script = `from xml.etree import ElementTree
from zipfile import ZipFile
import sys
with ZipFile(sys.argv[1]) as archive:
    document = ElementTree.fromstring(archive.read("word/document.xml"))
    texts = document.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t")
    print("".join(item.text or "" for item in texts))`;
    return execFileSync('python3', ['-I', '-c', script, artifact.path], {encoding:'utf8'});
  }
  return execFileSync('/usr/bin/swift', ['-e', 'import PDFKit; print(PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1]))!.string!)', artifact.path], {encoding:'utf8'});
}

function checkTable(text, lastQuantity, total) {
  // PDFKit may group a page by columns. The repeated explanation delimits
  // each quantity in that column, independently of the editable recipe.
  assert.match(text, /测试物资60/);
  const quantities = [...text.matchAll(/(\d{1,2})用于检查中文显示与跨页表格完整性/gu)].map(match => Number(match[1]));
  assert.equal(quantities.length, 60);
  assert.deepEqual(quantities.slice(-6), [55, 56, 57, 58, 59, lastQuantity]);
  assert.ok(text.includes('合计'));
  assert.ok(text.includes(String(total)));
}

for (const format of ['docx', 'pdf']) {
  test(`${format}: restore the TC02 table, editable recipe and verified citations to v3; concurrent and restarted retries preserve one result`, {
    skip:format === 'pdf' && process.platform !== 'darwin', timeout:120000,
  }, async t => {
    const f = fixture(t);
    f.ops.put({id:'inventory-note', kind:'research_observation', projectId:'project-a', status:'completed', sourceId:'inventory-record',
      finalUrl:'https://example.test/inventory', excerpt:quote, artifactHash:digest(quote), evidenceType:'page_body'});
    const spec = {...inventory(), sources:[{sourceId:'inventory-record', observationId:'inventory-note', sha256:digest(quote)}],
      claims:[{claim:'物资已盘点。', kind:'fact', citations:[{observationId:'inventory-note', quote}]}]};
    const v1 = await create(f, format, spec);
    const proposal = await revise(f, v1, {...versionPatch, claimEdits:[{op:'replace', index:1, claim:{claim:'等待复核。', kind:'open_question', citations:[]}}]});
    const v2 = await apply(f, proposal);
    assert.equal(v1.claims[0].citations[0].verified, true);
    assert.equal(v2.claims[0].citations.length, 0);
    const v2Text = documentText(v2).replace(/\s+/gu, '');
    checkTable(v2Text, 75, 1845);
    f.turn();
    const [first, duplicate] = await Promise.all(['undo-click','undo-chat'].map(id => confirmUndo(f, proposal, {id})));
    assert.equal(first.phase, 'undone', first.error);
    const v3 = first.artifact;
    assert.equal(duplicate.artifact.id, v3.id);
    assert.equal(v3.revision, 3);
    assert.equal(v3.path, join(f.workspace, `物资清单.v3.${format}`));
    assert.equal(v3.rootArtifactId, v1.id);
    assert.equal(v3.parentArtifactId, v2.id);
    assert.equal(v3.restoredFromArtifactId, v1.id);
    assert.equal(v3.restoredFromSha256, v1.sha256);
    assert.equal(v3.undoneProposalId, proposal.id);
    assert.deepEqual(v3.claims, v1.claims);
    assert.deepEqual(v3.sources, v1.sources);
    assert.deepEqual(readFileSync(v3.path), readFileSync(v1.path));
    assert.equal(digest(readFileSync(v2.path)), v2.sha256);
    for (const snapshot of ['editableSpecSnapshotPath','specSnapshotPath','snapshotPath']) {
      assert.deepEqual(readFileSync(v3[snapshot]), readFileSync(v1[snapshot]));
    }
    const v3Text = documentText(v3).replace(/\s+/gu, '');
    checkTable(v3Text, 60, 1830);
    assert.ok(v3Text.includes(quote.replaceAll(' ', '')));
    f.restart();
    const stored = readDocumentProposal({ops:f.ops, projectId:'project-a', id:proposal.id});
    assert.equal(stored.status, 'undone');
    assert.equal(stored.artifact.id, v2.id);
    assert.equal(stored.undoArtifact.id, v3.id);
    for (const id of ['undo-click','after-restart']) assert.equal((await confirmUndo(f, proposal, {id})).artifact.id, v3.id);
    assert.equal(f.ops.list('document_artifact').length, 3);
    const next = await revise(f, v3, versionPatch);
    assert.equal(next.baseArtifactId, v3.id);
    assert.deepEqual(next.changes.map(change => [change.before, change.after]), [['60','75'],['1830','1845']]);
  });
}

test('undo after re-comparison restores the exact manually saved Word and its editable base', async t => {
  const f = fixture(t);
  const v1 = await create(f);
  const proposal = await revise(f, v1, versionPatch);
  const edit = `from io import BytesIO
from pathlib import Path
from zipfile import ZipFile
import sys
path = Path(sys.argv[1])
with ZipFile(BytesIO(path.read_bytes())) as original, ZipFile(path, "w") as updated:
    for item in original.infolist():
        data = original.read(item)
        if item.filename == "word/document.xml":
            text = data.decode().replace("A2-PDF-验收结束。", "人工备注。")
            start = text.index("测试物资60</w:t>")
            tail = text[start:].replace(">60</w:t>", ">68</w:t>", 1).replace(">1830</w:t>", ">1838</w:t>", 1)
            data = (text[:start] + tail).encode()
        updated.writestr(item, data)`;
  execFileSync('python3', ['-I','-c',edit,v1.path]);
  const manual = readFileSync(v1.path);
  f.turn();
  const conflict = await f.generator.decide({id:proposal.id, action:'confirm'});
  assert.equal(conflict.phase, 'conflict', conflict.error);
  assert.ok(conflict.replacementProposal, JSON.stringify(conflict.proposal?.conflict));
  const replacement = conflict.replacementProposal;
  const v2 = await apply(f, replacement);
  assert.equal(v2.parentSha256, digest(manual));
  f.restart();
  f.turn();
  const undone = await confirmUndo(f, replacement);
  assert.equal(undone.phase, 'undone', undone.error);
  const v3 = undone.artifact;
  assert.equal(v3.restoredFromSha256, digest(manual));
  assert.deepEqual(readFileSync(v3.path), manual);
  assert.deepEqual(readFileSync(v1.path), manual);
  assert.equal(digest(readFileSync(v2.path)), v2.sha256);
  const editable = JSON.parse(readFileSync(v3.editableSpecSnapshotPath));
  assert.equal(editable.blocks[1].rows[59][2], '68');
  assert.equal(editable.blocks[1].summary[2], '1838');
  assert.equal(editable.blocks[2].text, '人工备注。');
});

test('undo refuses another project, a stale applied revision and an unapplied proposal', async t => {
  const f = fixture(t);
  const {proposal, v2} = await appliedInventory(f);
  f.turn('project-b');
  await assert.rejects(confirmUndo(f, proposal), /document_proposal_not_found/);
  f.turn();
  const newer = await revise(f, v2, {title:'新标题'});
  f.turn();
  assert.equal((await confirmUndo(f, newer)).status, 'failed');
  const v3 = await apply(f, newer);
  f.turn();
  assert.equal((await confirmUndo(f, proposal)).error, 'document_revision_not_latest');
  assert.equal(digest(readFileSync(v3.path)), v3.sha256);
  assert.equal(f.ops.list('document_artifact').length, 3);
});

for (const situation of ['edited','missing','destination collision','damaged snapshot','cancelled']) {
  test(`undo protects the project when the publication is ${situation}`, async t => {
    const f = fixture(t);
    const {v1, proposal, v2} = await appliedInventory(f);
    const target = join(f.workspace, '物资清单.v3.docx');
    const controller = new AbortController();
    if (situation === 'missing') rmSync(v2.path);
    if (situation === 'damaged snapshot') writeFileSync(v1.snapshotPath, 'irrecoverable snapshot');
    if (situation === 'destination collision') writeFileSync(target, '用户已有文件');
    if (situation === 'edited' || situation === 'cancelled') f.onEvent = (type, row) => {
      if (type !== 'operation.updated' || row.id !== 'undo-test' || row.phase !== 'committing') return;
      if (situation === 'edited') writeFileSync(v2.path, '用户的最新版本');
      else controller.abort();
    };
    const result = await confirmUndo(f, proposal, {id:'undo-test', signal:controller.signal});
    const errors = {edited:'document_revision_source_changed', missing:'document_revision_source_missing',
      'destination collision':'document_target_exists', 'damaged snapshot':'document_undo_snapshot_unavailable', cancelled:'cancelled'};
    assert.equal(result.error, errors[situation]);
    if (situation === 'destination collision') assert.equal(readFileSync(target, 'utf8'), '用户已有文件');
    else assert.equal(existsSync(target), false);
    if (situation === 'edited') assert.equal(readFileSync(v2.path, 'utf8'), '用户的最新版本');
    if (situation !== 'edited' && situation !== 'missing') assert.equal(digest(readFileSync(v2.path)), v2.sha256);
    assert.equal(digest(readFileSync(v1.path)), v1.sha256);
    assert.equal(f.ops.list('document_artifact').length, 2);
    assert.equal(f.ops.get(proposal.id).status, 'applied');
  });
}

test('restart reconciles an already published undo if updating the review card failed', async t => {
  const f = fixture(t);
  const {proposal, v1} = await appliedInventory(f);
  const save = f.ops.put.bind(f.ops);
  f.ops.put = row => {
    if (row.kind === 'document_proposal' && row.status === 'undone') throw Error('simulated_undo_journal_failure');
    return save(row);
  };
  const first = await confirmUndo(f, proposal, {id:'interrupted-undo'});
  assert.deepEqual(readFileSync(first.artifact.path), readFileSync(v1.path));
  f.restart();
  const recovered = f.ops.get('interrupted-undo');
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.phase, 'undone');
  assert.equal(recovered.artifact.id, first.artifact.id);
  assert.equal(f.ops.get(proposal.id).status, 'undone');
  assert.equal((await confirmUndo(f, proposal, {id:'again'})).artifact.id, first.artifact.id);
  assert.equal(f.ops.list('document_artifact').length, 3);
});
