import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {verifyOfficeQuotes} from '../desktop/office-evidence.mjs';
import {nativeFileMime} from '../desktop/file-types.mjs';

const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main',X='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rel=(id,type,target,extra='')=>'<Relationship Id="'+id+'" Type="'+R+'/'+type+'" Target="'+target+'" '+extra+'/>';
const rels=body=>'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+body+'</Relationships>';
function pack(kind,parts){
  const word=kind==='docx',target=word?'word/document.xml':'xl/workbook.xml';
  const type='application/vnd.openxmlformats-officedocument.'+(word?'wordprocessingml.document.main+xml':'spreadsheetml.sheet.main+xml');
  const entries={'[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/'+target+'" ContentType="'+type+'"/></Types>',
    '_rels/.rels':rels(rel('rId1','officeDocument',target)),...parts};
  const code="import io,sys,json,zipfile\nbuf=io.BytesIO()\nwith zipfile.ZipFile(buf,'w',zipfile.ZIP_DEFLATED) as z:\n for k,v in json.load(sys.stdin).items(): z.writestr(k,v)\nsys.stdout.buffer.write(buf.getvalue())";
  return execFileSync('/usr/bin/python3',['-I','-c',code],{input:JSON.stringify(entries)});
}
const para=t=>'<w:p><w:r><w:t>'+t+'</w:t></w:r></w:p>';
const document=body=>'<w:document xmlns:w="'+W+'"><w:body>'+body+'</w:body></w:document>';
const check=(kind,bytes,items,other={})=>verifyOfficeQuotes({bytes,mime:nativeFileMime('sample.'+kind),items,...other});
const at=(paragraph,quote)=>({locator:{paragraph},quote}),cell=(sheet,cell,quote)=>({locator:{sheet,cell},quote});
const yes=quote=>({verified:true,quote}),no=reason=>({verified:false,reason});

test('DOCX resolves body paragraph order and literal source across runs, never table/field results or proposed text',async()=>{
  const doc=document(para('')+para('第一段')+'<w:tbl><w:tr><w:tc>'+para('表格不算正文第2段')+'</w:tc></w:tr></w:tbl>'+
    '<w:p><w:r><w:t>第二段</w:t><w:tab/></w:r><w:r><w:t>共有42个样本。</w:t></w:r></w:p>'+
    '<w:p><w:fldSimple w:instr="DATE"><w:r><w:t>日期</w:t></w:r></w:fldSimple></w:p>'+para('ambiguous ordinal'));
  const result=await check('docx',pack('docx',{'word/document.xml':doc}),[at(1,'第一段'),at(2,'第二段 共有42个样本。'),at(2,'表格不算正文第2段'),
    at(3,'日期'),at(4,'ambiguous ordinal'),at(1,'第一段改写'),{locator:{page:1},quote:'第一段'}]);
  assert.deepEqual(result,[yes('第一段'),yes('第二段\t共有42个样本。'),no('office_quote_not_found'),no('office_unsupported_content'),
    no('office_unsupported_content'),no('office_quote_not_found'),no('office_invalid_locator')]);
});
function xparts(){
  return {'xl/workbook.xml':'<workbook xmlns="'+X+'" xmlns:r="'+R+'"><sheets><sheet name="汇总" sheetId="1" r:id="x7"/><sheet name="历史" sheetId="2" r:id="x9"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':rels(rel('x7','worksheet','worksheets/sheet8.xml')+rel('x9','worksheet','worksheets/sheet1.xml')+rel('ss','sharedStrings','sharedStrings.xml')),
    'xl/sharedStrings.xml':'<sst xmlns="'+X+'"><si><r><t>现有</t></r><r><t>样本</t></r><rPh sb="0" eb="2"><t>not evidence</t></rPh></si></sst>',
    'xl/worksheets/sheet8.xml':'<worksheet xmlns="'+X+'"><sheetData><row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2"><v>42</v></c>'+
      '<c r="C2"><f t="array" ref="C2:D2">A2</f><v>99</v></c><c r="D2"><v>99</v></c><c r="E2" s="1"><v>0.7</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet1.xml':'<worksheet xmlns="'+X+'"><sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>24</t></is></c></row></sheetData></worksheet>'};
}
test('XLSX follows workbook relationships, verifies static cells, rejects formula caches and out-of-bounds locations',async()=>{
  const queries=[cell('汇总','A2','现有样本'),cell('汇总','A2','not evidence'),cell('汇总','B2','42'),cell('汇总','B2','2'),cell('历史','B2','24'),
    cell('历史','B2','42'),cell('汇总','C2','99'),cell('汇总','D2','99'),cell('汇总','E2','0.7'),cell('汇总','QQQ2','42'),
    cell('未找到','B2','42'),cell('汇总','XFE1','42')];
  assert.deepEqual(await check('xlsx',pack('xlsx',xparts()),queries),[yes('现有样本'),no('office_quote_not_found'),yes('42'),no('office_quote_not_found'),
    yes('24'),no('office_quote_not_found'),no('office_formula_not_supported'),no('office_formula_not_supported'),no('office_unsupported_content'),
    no('office_location_not_found'),no('office_location_not_found'),no('office_invalid_locator')]);
});
test('bounded worker rejects external source relationships, DTDs and oversized compressed XML',async()=>{
  const kind='docx',item=at(1,'42'),doc=document(para('42'));
  const results=await Promise.all([
    check(kind,pack(kind,{'word/document.xml':doc,'_rels/.rels':rels(rel('rId1','officeDocument','word/document.xml','TargetMode="External"'))}),[item]),
    check(kind,pack(kind,{'word/document.xml':'<!DOCTYPE document [<!ENTITY n "42">]>'+document(para('&n;'))}),[item]),
    check(kind,pack(kind,{'word/document.xml':document(para('A'.repeat(4*1024**2)))}),[item])]);
  assert.deepEqual(results,[[no('office_unsupported_content')],[no('office_package_unreadable')],[no('office_resource_limit')]]);
  const bytes=pack(kind,{'word/document.xml':doc});
  const controller=new AbortController(),pending=check(kind,bytes,[item],{signal:controller.signal});controller.abort();
  await assert.rejects(pending,/cancelled/);
  assert.deepEqual(await check(kind,bytes,[item],{timeoutMs:1}),[no('office_evidence_timeout')]);
});
