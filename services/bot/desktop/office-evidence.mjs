/** Read bounded Office package parts in a fixed, isolated Python worker (no office app or model). */
import {spawn} from 'node:child_process';
import {accessSync,constants,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativeFileMime} from './file-types.mjs';

const script=fileURLToPath(new URL('../../../tools/documents/office_evidence.py',import.meta.url));
const types=new Map(['docx','xlsx'].map(ext=>[nativeFileMime('source.'+ext),ext]));
const known=new Set(['office_invalid_locator','office_quote_not_found','office_location_not_found','office_unsupported_content',
  'office_package_unreadable','office_resource_limit','office_formula_not_supported']);
const failed=reason=>({verified:false,reason});
function run(dir,type,signal,timeoutMs){
  return new Promise((resolve,reject)=>{
    const candidates=process.env.OPENNOVA_PACKAGED==='1'?[process.env.OPENNOVA_PYTHON]:['/opt/homebrew/bin/python3','/usr/local/bin/python3','/usr/bin/python3'];
    const python=candidates.filter(Boolean).find(p=>{try{accessSync(p,constants.X_OK);return true;}catch{return false;}});
    if(!python)return reject(Error('office_evidence_unavailable'));
    const proc=spawn(python,['-I','-B',script,type],{cwd:dir,env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',TMPDIR:dir},stdio:['ignore','pipe','ignore']});
    let size=0,reason;const chunks=[];
    const stop=why=>{reason??=why;proc.kill('SIGKILL');};
    const abort=()=>stop('cancelled');const timer=setTimeout(()=>stop('office_evidence_timeout'),timeoutMs);
    proc.stdout.on('data',buf=>{size+=buf.length;if(size>256*1024)stop('office_evidence_unavailable');else chunks.push(buf);});
    proc.on('error',()=>{reason??='office_evidence_unavailable';});
    proc.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(reason||code!==0)return reject(Error(reason??'office_evidence_unavailable'));
      try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Error('office_evidence_unavailable'));}
    });
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
}
export async function verifyOfficeQuotes({bytes,mime,items,signal,timeoutMs=12000}){
  if(signal?.aborted)throw Error('cancelled');
  if(!Array.isArray(items)||items.length>32)throw Error('invalid_office_evidence_batch');
  const type=types.get(mime),all=reason=>items.map(()=>failed(reason));if(!items.length)return [];
  if(!type)return all('unsupported_evidence_locator');
  if(!(bytes instanceof Uint8Array)||!bytes.byteLength)return all('office_package_unreadable');
  if(bytes.byteLength>20*1024*1024)return all('file_too_large');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>120000)return all('office_evidence_unavailable');
  const safe=items.map(item=>{
    const l=item?.locator;if(!l||typeof l!=='object'||Array.isArray(l)||typeof item.quote!=='string'||!item.quote.trim()||
      !item.quote.isWellFormed()||item.quote.length>1200)return null;
    if(type==='docx'&&Object.keys(l).length===1&&Number.isSafeInteger(l.paragraph)&&l.paragraph>=1&&l.paragraph<=100000)return {locator:{paragraph:l.paragraph},quote:item.quote};
    if(type==='xlsx'&&Object.keys(l).length===2&&typeof l.sheet==='string'&&l.sheet.length<=31&&l.sheet.trim()&&l.sheet.isWellFormed()&&
      typeof l.cell==='string'&&/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(l.cell))return {locator:{sheet:l.sheet,cell:l.cell},quote:item.quote};
    return null;
  });
  if(!safe.some(Boolean))return all('office_invalid_locator');
  let dir;
  try{
    dir=mkdtempSync(join(tmpdir(),'opennova-office-evidence-'));
    writeFileSync(join(dir,'source.zip'),bytes,{mode:0o600,flag:'wx'});writeFileSync(join(dir,'items.json'),JSON.stringify(safe),{mode:0o600,flag:'wx'});
    const result=await run(dir,type,signal,timeoutMs);if(signal?.aborted)throw Error('cancelled');
    if(!Array.isArray(result)||result.length!==safe.length)return all('office_evidence_unavailable');
    return result.map((r,i)=>!safe[i]?failed('office_invalid_locator'):r?.verified===true&&typeof r.quote==='string'&&r.quote.length>0&&r.quote.length<=1200?
      {verified:true,quote:r.quote}:failed(known.has(r?.reason)?r.reason:'office_evidence_unavailable'));
  }catch(e){if(signal?.aborted||e.message==='cancelled')throw Error('cancelled');return all(e.message==='office_evidence_timeout'?e.message:'office_evidence_unavailable');}
  finally{if(dir)rmSync(dir,{recursive:true,force:true});}
}
