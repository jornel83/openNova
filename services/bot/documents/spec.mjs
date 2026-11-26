/** Data-only document specification shared by the fixed format executors. */
import {normalizeEvidenceClaims} from './claim-evidence.mjs';
export const MAX_SPEC_BYTES=512*1024;
export const GENERATOR_VERSION='opennova-documents-v1';
const object=x=>x&&Object.getPrototypeOf(x)===Object.prototype;
function fields(x,allowed){if(!object(x)||Object.keys(x).some(k=>!allowed.includes(k)))throw Error('invalid_document_spec');}
function text(x,max=32768,{empty=false}={}){
  if(typeof x!=='string'||x.length>max||!empty&&!x.trim()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(x)||!x.isWellFormed())throw Error('invalid_document_text');
  return x.replace(/\r\n?/g,'\n');
}
export function normalizeDocumentSpec(input){
  fields(input,['schemaVersion','title','subtitle','blocks','layout','sources','claims']);
  const claims=input.claims===undefined?undefined:normalizeEvidenceClaims(input.claims);
  const body=input.blocks===undefined&&claims?.length?[]:input.blocks;
  if(input.schemaVersion!==1||!Array.isArray(body)||!body.length&&!claims?.length||body.length>512)throw Error('invalid_document_spec');
  let rowCount=0,characterCount=0;
  const content=(x,max,options)=>{const value=text(x,max,options);characterCount+=value.length;if(characterCount>200000)throw Error('document_content_too_large');return value;};
  const title=content(input.title,500),subtitle=input.subtitle===undefined?undefined:content(input.subtitle,2000,{empty:true});
  const blocks=body.map((block,index)=>{
    if(!object(block))throw Error('invalid_document_spec');
    if(block.type==='heading'){fields(block,['type','level','text']);if(![1,2,3].includes(block.level))throw Error('invalid_document_heading');return {type:'heading',level:block.level,text:content(block.text,2000)};}
    if(block.type==='paragraph'){fields(block,['type','text']);return {type:'paragraph',text:content(block.text)};}
    if(block.type==='list'){
      fields(block,['type','ordered','items']);if(typeof block.ordered!=='boolean'||!Array.isArray(block.items)||!block.items.length||block.items.length>1000)throw Error('invalid_document_list');
      return {type:'list',ordered:block.ordered,items:block.items.map(x=>content(x))};
    }
    if(block.type==='table'){
      fields(block,['type','columns','rows','summary']);
      if(!Array.isArray(block.columns)||block.columns.length<1||block.columns.length>12||!Array.isArray(block.rows)||!block.rows.length)throw Error('invalid_document_table');
      rowCount+=block.rows.length;if(rowCount>2000)throw Error('document_table_too_large');
      if(block.summary!==undefined&&(!Array.isArray(block.summary)||block.summary.length!==block.columns.length))throw Object.assign(Error('document_summary_columns_mismatch'),{
        details:{field:`blocks[${index}].summary`,expectedColumns:block.columns.length,actualColumns:Array.isArray(block.summary)?block.summary.length:null}});
      const cells=row=>{if(!Array.isArray(row)||row.length!==block.columns.length)throw Error('invalid_document_table');return row.map(x=>content(x,32768,{empty:true}));};
      return {type:'table',columns:block.columns.map(x=>content(x,500)),rows:block.rows.map(cells),...(block.summary===undefined?{}:{summary:cells(block.summary)})};
    }
    throw Error('unsupported_document_block');
  });
  const layout=input.layout??{};fields(layout,['pageSize','fontPreset','header','footer']);
  if(layout.pageSize!==undefined&&!['A4','Letter'].includes(layout.pageSize)||layout.fontPreset!==undefined&&layout.fontPreset!=='cjk'||layout.footer!==undefined&&typeof layout.footer!=='boolean')throw Error('invalid_document_layout');
  const sources=input.sources??[];
  if(!Array.isArray(sources)||sources.length>100)throw Error('invalid_document_sources');
  const normalizedSources=sources.map(source=>{
    fields(source,['sourceId','sha256','observationId','locator']);
    const result={sourceId:text(source.sourceId,200)};
    if(source.sha256!==undefined){if(typeof source.sha256!=='string'||!/^[a-f0-9]{64}$/.test(source.sha256))throw Error('invalid_document_sources');result.sha256=source.sha256;}
    if(source.observationId!==undefined)result.observationId=text(source.observationId,200);
    if(source.locator!==undefined)result.locator=text(source.locator,1000);
    return result;
  });
  return {schemaVersion:1,title,...(subtitle===undefined?{}:{subtitle}),blocks,...(claims?{claims}:{}),
    layout:{pageSize:layout.pageSize??'A4',fontPreset:'cjk',header:layout.header===undefined?[...title].slice(0,80).join(''):text(layout.header,200,{empty:true}),footer:layout.footer??true},sources:normalizedSources};
}

export const DOCUMENT_SPEC_HELP='specPath 是用 write 写入的 UTF-8 JSON 数据文件。schemaVersion=1，title 为标题，subtitle 可选，blocks 为顺序数组：{type:"heading",level:1|2|3,text}、{type:"paragraph",text}、{type:"list",ordered:boolean,items:string[]}、{type:"table",columns:string[],rows:string[][],summary?:string[]}。所有单元格为字符串，每一数据行和summary的单元格数量必须与columns相同。summary是完整汇总行，不是摘要说明：四列表格可用summary:["合计","","","614"]，无汇总行就省略summary；需要表后说明时另加paragraph。不得只给内容路径或代码。layout 可选 {pageSize:"A4"|"Letter",fontPreset:"cjk",header:string,footer:boolean}，默认 A4、中文字体、标题页眉和页码。sources 可选 [{sourceId,sha256?,observationId?,locator?}]，只能引用实际已读证据，不知道时留空，不编造；核验来源身份不证明具体引文正确。上限512KiB、512块、200000字符、2000行、12列。';

export const DOCUMENT_CLAIMS_HELP=' 研究笔记的关键结论写入 spec.claims，每项 {claim,kind:"fact"|"inference"|"decision"|"open_question",citations:[]}。文件引用使用成功的 document_read 回执 id 作 readId；PDF 引用 {readId,page,quote}（原物理页），Word 用 {readId,locator:{paragraph},quote}，Excel 用 {readId,locator:{sheet,cell},quote}。网页引用用实际 observationId 与 quote。quote 必须是拟核对的逐字摘录。宿主核对指定版本、位置和原文，仅匹配才排印摘录；不等于结论本身已证实。有 claims 时可省略 blocks。';
