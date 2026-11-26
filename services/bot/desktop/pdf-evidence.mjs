/** Confirm literal quotations against one immutable PDF, never a live path or model reply. */
import {spawn} from 'node:child_process';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MAX_NATIVE_FILE_BYTES,MAX_RANGED_PDF_SOURCE_BYTES} from './file-types.mjs';

const script=fileURLToPath(new URL('../../../tools/documents/pdf_evidence.swift',import.meta.url));
const maxItems=32,maxQuote=1200;
const reasons=new Set(['pdf_unreadable','pdf_encrypted','pdf_page_range_out_of_bounds','pdf_no_text_layer',
  'pdf_text_limit','pdf_quote_not_found','pdf_quote_too_long']);
const negative=(item,reason)=>({verified:false,page:Number.isSafeInteger(item?.page)?item.page:null,reason});
const valid=item=>Number.isSafeInteger(item?.page)&&item.page>0&&typeof item.quote==='string'&&item.quote.length<=maxQuote&&
  !!item.quote.trim()&&!/[\x00-\x08\x0b\x0e-\x1f\x7f]/u.test(item.quote);

function scratch(){
  for(const parent of new Set([tmpdir(),'/private/tmp']))try{
    const base=realpathSync(parent);
    if(/^[\x21-\x7e]+$/.test(base))return mkdtempSync(join(base,'opennova-pdf-evidence-'));
  }catch{}
  throw Error('pdf_evidence_unavailable');
}

function run(dir,signal,timeoutMs){
  return new Promise((resolve,reject)=>{
    const packaged=process.env.OPENNOVA_PACKAGED==='1';
    if(packaged&&!process.env.OPENNOVA_BIN_DIR)return reject(Error('pdf_evidence_unavailable'));
    const command=packaged?join(process.env.OPENNOVA_BIN_DIR,'opennova-pdf-evidence'):'/usr/bin/swift';
    const args=['source.pdf','items.json'];
    const child=spawn(command,packaged?args:[script,...args],{cwd:dir,detached:true,stdio:['ignore','pipe','ignore'],
      env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8',TMPDIR:dir,SWIFT_MODULECACHE_PATH:join(dir,'swift-cache'),CLANG_MODULE_CACHE_PATH:join(dir,'clang-cache')}});
    let size=0,reason;const chunks=[];
    const stop=value=>{reason??=value;try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}};
    const abort=()=>stop('cancelled'),timer=setTimeout(()=>stop('pdf_evidence_timeout'),timeoutMs);
    child.stdout.on('data',buf=>{size+=buf.length;if(size>256*1024)stop('pdf_evidence_unavailable');else chunks.push(buf);});
    child.on('error',()=>{reason??='pdf_evidence_unavailable';});
    child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(reason||code!==0)return reject(Error(reason??'pdf_evidence_unavailable'));
      try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Error('pdf_evidence_unavailable'));}
    });
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
}

/** One process per immutable source, independent results in input order. Cancellation aborts the whole batch. */
export async function verifyPdfQuotes({bytes,items,signal,rangedSource=false,timeoutMs=30000}){
  if(signal?.aborted)throw Error('cancelled');
  if(!Array.isArray(items)||items.length>maxItems)throw Error('invalid_pdf_evidence_batch');
  const input=items.map(item=>valid(item)?{page:item.page,quote:item.quote}:null);
  const pending=input.filter(Boolean),fail=reason=>input.map((item,i)=>negative(item??items[i],item?reason:'invalid_pdf_quote'));
  if(!pending.length)return fail('invalid_pdf_quote');
  if(!(bytes instanceof Uint8Array)||!/^%PDF-\d\.\d$/.test(Buffer.from(bytes.subarray(0,8)).toString('latin1')))return fail('pdf_unreadable');
  if(bytes.byteLength>(rangedSource?MAX_RANGED_PDF_SOURCE_BYTES:MAX_NATIVE_FILE_BYTES))return fail('file_too_large');
  if(process.platform!=='darwin'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)return fail('pdf_evidence_unavailable');
  let dir;
  try{
    dir=scratch();
    writeFileSync(join(dir,'source.pdf'),bytes,{mode:0o600,flag:'wx'});
    writeFileSync(join(dir,'items.json'),JSON.stringify(pending),{mode:0o600,flag:'wx'});
    const results=await run(dir,signal,timeoutMs);
    if(signal?.aborted)throw Error('cancelled');
    if(!Array.isArray(results)||results.length!==pending.length)throw Error('pdf_evidence_unavailable');
    let j=0;return input.map((item,i)=>{
      if(!item)return negative(items[i],'invalid_pdf_quote');
      const value=results[j++];
      if(value?.page!==item.page)return negative(item,'pdf_evidence_unavailable');
      if(value.verified===true&&typeof value.quote==='string'&&value.quote.length>0&&value.quote.length<=maxQuote)
        return {verified:true,page:item.page,quote:value.quote};
      return negative(item,reasons.has(value?.reason)?value.reason:'pdf_evidence_unavailable');
    });
  }catch(error){
    if(signal?.aborted||error.message==='cancelled')throw Error('cancelled');
    return fail(error.message==='pdf_evidence_timeout'?'pdf_evidence_timeout':'pdf_evidence_unavailable');
  }finally{if(dir)rmSync(dir,{recursive:true,force:true});}
}
export async function verifyPdfQuote({bytes,page,quote,signal,timeoutMs}){
  return (await verifyPdfQuotes({bytes,items:[{page,quote}],signal,timeoutMs}))[0];
}
