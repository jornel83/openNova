import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,unlinkSync,writeFileSync,existsSync,symlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Operations} from '../operations.mjs';
import {createWorkContext} from '../desktop/context.mjs';
import {createResearchNotes,renderResearchNote,createResearchNoteTool} from '../documents/research-note.mjs';

const proposals=[{kind:'inference',claim:'读者增长，但原因仍需验证。',citations:[
  {readId:'old-read',page:2,quote:'原始人次为 18。'},{readId:'other',page:3,quote:'伪造的原话'}]}];
const sha='a'.repeat(64);
const resolved=[{...proposals[0],citations:[
  {readId:'old-read',sourceId:'old',fileName:'访谈.pdf',sha256:sha,page:2,quote:'原始人次为 18。',verified:true,readStatus:'partial'},
  {readId:'other',sourceId:'other',fileName:'第二份.pdf',sha256:'b'.repeat(64),page:3,verified:false,reason:'pdf_quote_not_found'},
]}];
const input={action:'save',title:'研究笔记',path:'notes/结论.md',claims:proposals};
function fixture(t,{resolveClaims=async()=>structuredClone(resolved)}={}){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'opennova-research-note-'))),cwd=join(home,'project'),context=createWorkContext();
  const ops=new Operations({home,workspace:cwd}),controller=new AbortController();
  let request={id:'ask-1',projectId:'A',binding:{focus:'work',projectId:'A',cwd,context:context.capture()},signal:controller.signal};
  const create=()=>createResearchNotes({home,ops,context,getRequest:()=>request,resolveClaims,writeText:async(path,content)=>writeFileSync(path,content,{flag:'wx'})});
  const notes=create();t.after(()=>{ops.close();rmSync(home,{recursive:true,force:true});});
  return {notes,home,cwd,context,ops,controller,create,otherProject:()=>{request={id:'ask-2',projectId:'B',binding:{focus:'work',projectId:'B',cwd,context:context.capture()}};}};
}

test('Markdown maps every assessed quote to its own historical version and separates inference from unverified evidence',async t=>{
  const f=fixture(t),saved=await f.notes.call(input,{callId:'a'}),text=readFileSync(saved.path,'utf8');
  assert.equal(saved.status,'completed');assert.equal(saved.sha256,createHash('sha256').update(text).digest('hex'));
  assert.match(text,/分析推断/);assert.match(text,/原始人次为 18。/);assert.match(text,/物理页：第 2 页/);assert.match(text,/原读取仅部分可确认/);
  assert.match(text,/出处待核实/);assert.match(text,new RegExp(sha));assert.doesNotMatch(text,/伪造的原话/);
  assert.equal(f.context.capture().file.path,saved.path);
  const replay=await f.notes.call(input,{callId:'a'});assert.equal(replay.noteId,saved.noteId);
  assert.throws(()=>f.notes.call({...input,title:'其他标题'},{callId:'a'}),/command_id_conflict/);
  assert.equal((await f.notes.call(input,{callId:'b'})).error,'note_target_exists');
  writeFileSync(saved.path,'外部更新');const restarted=f.create(),historical=restarted.call({action:'lookup',path:input.path});
  assert.equal(historical.diskStatus,'changed');assert.equal(historical.edition,'saved_snapshot');assert.deepEqual(historical.claims,resolved);
  unlinkSync(saved.path);assert.equal(restarted.call({action:'lookup',noteId:saved.noteId}).diskStatus,'missing');
  f.otherProject();assert.throws(()=>restarted.call({action:'lookup',noteId:saved.noteId}),/research_note_not_found/);
});

test('Office and web evidence show their own locations rather than an invented PDF page',()=>{
  const text=renderResearchNote({title:'笔记',noteId:'n',claims:[{kind:'fact',claim:'费用增加。',citations:[
    {fileName:'原计划.docx',sha256:sha,locator:{paragraph:4},verified:true,quote:'计划支出为十元。'},
    {fileName:'费用.xlsx',sha256:sha,locator:{sheet:'采购计划',cell:'B3'},verified:true,quote:'20'},
    {fileName:'公开说明',url:'https://example.org/fees',observationId:'obs7',sha256:sha,verified:true,quote:'更新了价格。'},
    {fileName:'搜索结果',url:'https://example.org/other',observationId:'other',sha256:sha,verified:false,reason:'search_summary_only',quote:'不应引用'},
  ]}]});
  assert.match(text,/Word 正文第 4 段/);assert.match(text,/工作表「采购计划」· 单元格 B3/);
  assert.match(text,/网页观察记录：obs7/);assert.match(text,/https:\/\/example.org\/fees/);assert.match(text,/观察文本 SHA-256/);assert.match(text,/待核实/);
  assert.doesNotMatch(text,/物理页|undefined|不应引用/);
  const schema=createResearchNoteTool({})[2].claims.items.properties.citations.items.properties;
  assert.equal(schema.quote.required,true);assert.ok(!schema.page.required&&!schema.readId.required);
  assert.deepEqual(Object.keys(schema.locator.properties),['paragraph','sheet','cell']);assert.equal(schema.observationId.type,'string');
});

test('cancel or redirect during verification cannot publish a note or replace a newer file selection',async t=>{
  const checking=Promise.withResolvers(),release=Promise.withResolvers(),f=fixture(t,{resolveClaims:async()=>{checking.resolve();await release.promise;return resolved;}});
  const read=f.notes.call(input,{callId:'cancel'});await checking.promise;
  f.context.selectFile({id:'current',path:'/selected'});f.controller.abort();release.resolve();
  const r=await read;assert.equal(r.status,'cancelled');assert.equal(existsSync(join(f.cwd,input.path)),false);
  assert.equal(f.context.capture().file.path,'/selected');assert.ok(!r.claims);
});

test('tracked Word/PDF artifacts have a project-scoped historical lookup and arbitrary paths expose nothing',async t=>{
  const f=fixture(t),path=join(f.cwd,'文件.pdf');writeFileSync(path,'example');
  f.ops.put({kind:'document_artifact',id:'artifact-id',projectId:'A',path,size:7,sha256:createHash('sha256').update('example').digest('hex'),claims:resolved,createdAt:Date.now()});
  const r=f.notes.call({action:'lookup',path});assert.equal(r.noteId,'artifact-id');assert.equal(r.diskStatus,'unchanged');assert.deepEqual(r.claims,resolved);
  assert.equal(f.notes.call({action:'lookup'}).notes[0].noteId,r.noteId);
  assert.throws(()=>f.notes.call({action:'lookup',path:'secret.pdf'}),/research_note_not_found/);
  f.otherProject();assert.throws(()=>f.notes.call({action:'lookup',path}),/research_note_not_found/);
});

test('note creation stays inside the project and does not follow a symlink into another directory',async t=>{
  const f=fixture(t);symlinkSync(f.home,join(f.cwd,'outside'));
  for(const [i,path] of ['../backdoor.md','outside/backdoor.md','fake.txt'].entries()){
    const r=await f.notes.call({...input,path},{callId:'path'+i});assert.equal(r.error,'invalid_note_path');
  }
  assert.equal(existsSync(join(f.home,'backdoor.md')),false);
});
