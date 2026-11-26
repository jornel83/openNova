import {spawn} from 'node:child_process';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MAX_NATIVE_FILE_BYTES,MAX_RANGED_PDF_SOURCE_BYTES} from './file-types.mjs';

const script=fileURLToPath(new URL('../../../tools/documents/read_pdf_pages.swift',import.meta.url));
const errors=new Set(['pdf_unreadable','pdf_encrypted','pdf_page_range_out_of_bounds','pdf_page_range_too_large','pdf_pages_failed']);
function scratchDirectory(){
  for(const candidate of new Set([tmpdir(),'/private/tmp'])){
    try{
      const base=realpathSync(candidate);
      if(/^[\x21-\x7e]+$/.test(base))return mkdtempSync(join(base,'opennova-pdf-pages-'));
    }catch{}
  }
  throw Error('pdf_pages_runtime_unavailable');
}

function execute(args,workdir,signal,timeoutMs){
  return new Promise((resolve,reject)=>{
    const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8',TMPDIR:workdir,
      SWIFT_MODULECACHE_PATH:join(workdir,'swift-cache'),CLANG_MODULE_CACHE_PATH:join(workdir,'clang-cache')};
    const packaged=process.env.OPENNOVA_PACKAGED==='1';
    if(packaged&&!process.env.OPENNOVA_BIN_DIR)return reject(Error('pdf_pages_runtime_unavailable'));
    const command=packaged?join(process.env.OPENNOVA_BIN_DIR,'opennova-pdf-pages'):'/usr/bin/swift';
    const child=spawn(command,packaged?args:[script,...args],{cwd:workdir,env,detached:true,stdio:['ignore','pipe','ignore']});
    let stdout='',reason;
    const stop=code=>{
      reason??=code;
      try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}
    };
    const abort=()=>stop('cancelled');
    const timer=setTimeout(()=>stop('pdf_pages_timeout'),timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      if(stdout.length+chunk.length>1024)stop('pdf_pages_failed');
      else stdout+=chunk;
    });
    child.on('error',()=>{reason??='pdf_pages_runtime_unavailable';});
    child.on('close',(code,termination)=>{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(reason)return reject(Error(reason));
      if(termination)return reject(Error(termination==='SIGXFSZ'?'pdf_pages_output_too_large':'pdf_pages_failed'));
      let receipt;try{receipt=JSON.parse(stdout);}catch{}
      if(code!==0){
        const error=Error(errors.has(receipt?.error)?receipt.error:'pdf_pages_failed');
        if(Number.isSafeInteger(receipt?.pageCount)&&receipt.pageCount>0)error.pageCount=receipt.pageCount;
        return reject(error);
      }
      if(!Number.isSafeInteger(receipt?.pageCount)||receipt.pageCount<1)return reject(Error('pdf_pages_failed'));
      resolve(receipt.pageCount);
    });
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
}

export async function preparePdfPages({bytes,range=null,signal,timeoutMs=30000}){
  if(signal?.aborted)throw Error('cancelled');
  if(!(bytes instanceof Uint8Array)||!bytes.byteLength)throw Error('pdf_unreadable');
  if(bytes.byteLength>(range===null?MAX_NATIVE_FILE_BYTES:MAX_RANGED_PDF_SOURCE_BYTES))throw Error('file_too_large');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw Error('pdf_pages_failed');
  let startPage=1,endPage=null;
  if(range!==null){
    if(!range||typeof range!=='object'||Array.isArray(range)||Object.keys(range).some(key=>!['startPage','endPage'].includes(key))||
      !Number.isSafeInteger(range.startPage)||!Number.isSafeInteger(range.endPage)||range.startPage<1||range.endPage<range.startPage)throw Error('invalid_pdf_page_range');
    startPage=range.startPage;endPage=range.endPage;
    if(endPage-startPage+1>256)throw Error('pdf_page_range_too_large');
  }
  if(process.platform!=='darwin')throw Error('pdf_pages_runtime_unavailable');
  // The range case writes its private copy synchronously before the first await.
  const source=range===null?Buffer.from(bytes):Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(!/^%PDF-\d\.\d/.test(source.toString('ascii',0,8)))throw Error('pdf_unreadable');
  const directory=scratchDirectory();
  try{
    const input=join(directory,'source.pdf'),output=join(directory,'pages.pdf');
    writeFileSync(input,source,{flag:'wx',mode:0o600});
    const args=endPage===null?[input]:[input,String(startPage),String(endPage),output];
    const pageCount=await execute(args,directory,signal,timeoutMs);
    if(signal?.aborted)throw Error('cancelled');
    if(endPage===null)return {bytes:source,pageCount,startPage:1,endPage:pageCount};
    const size=statSync(output).size;if(!size||size>MAX_NATIVE_FILE_BYTES)throw Error('pdf_pages_output_too_large');
    const selected=readFileSync(output);
    if(endPage>pageCount||selected.length!==size||!/^%PDF-\d\.\d/.test(selected.toString('ascii',0,8)))throw Error('pdf_pages_failed');
    return {bytes:selected,pageCount,startPage,endPage};
  }finally{rmSync(directory,{recursive:true,force:true});}
}
