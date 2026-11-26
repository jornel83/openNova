/** Run repository-owned generators without evaluating user-provided code. */
import {spawn} from 'node:child_process';
import {accessSync,chmodSync,constants,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {ROOT} from '../../runtime/sources.mjs';
import {GENERATOR_VERSION} from './spec.mjs';

const scripts={docx:'generate_docx.py',pdf:'generate_pdf.swift'};
const executable=paths=>paths.find(path=>{try{accessSync(path,constants.X_OK);return true;}catch{return false;}});
export function documentCapabilities({root=ROOT,env=process.env}={}){
  const packaged=env.OPENNOVA_PACKAGED==='1';
  const python=executable(packaged?[env.OPENNOVA_PYTHON].filter(Boolean):['/opt/homebrew/bin/python3','/usr/local/bin/python3','/usr/bin/python3']);
  const swift=process.platform==='darwin'&&executable(packaged?(env.OPENNOVA_BIN_DIR?[join(env.OPENNOVA_BIN_DIR,'opennova-generate-pdf')]:[]):['/usr/bin/swift']);
  return Object.fromEntries(Object.entries(scripts).map(([format,file])=>{
    const command=format==='docx'?python:swift,script=resolve(root,'tools/documents',file);
    let digest;try{digest=createHash('sha256').update(readFileSync(script)).digest('hex');}catch{}
    return [format,{available:!!command&&!!digest,command:command||null,script,...(packaged&&format==='pdf'?{compiled:true}:{}),generatorVersion:GENERATOR_VERSION,...(digest?{implementationSha256:digest}:{}),
      ...(!command||!digest?{error:!digest?'document_generator_missing':format==='pdf'?'pdf_runtime_unavailable':'python_runtime_unavailable'}:{})}];
  }));
}
function pdfRuntimeDirectory(){
  // Swift may terminate before running the script when its temporary directory
  // contains non-ASCII characters. Keep all compiler scratch space
  // independent from the user's project; the final artifact stays in its stage.
  for(const candidate of [...new Set([tmpdir(),'/private/tmp'])]){
    let directory;
    try{
      const base=realpathSync(candidate);
      if(!/^[\x21-\x7e]+$/.test(base))continue;
      directory=mkdtempSync(join(base,'opennova-document-runtime-'));chmodSync(directory,0o700);
      return directory;
    }catch{if(directory)rmSync(directory,{recursive:true,force:true});}
  }
  throw Error('document_runtime_directory_unavailable');
}
export function runDocumentGenerator({format,specPath,outputPath,workdir,signal,timeoutMs=120000,root=ROOT}){
  const capability=documentCapabilities({root})[format];
  if(!capability?.available)return Promise.reject(Error(capability?.error??'unsupported_document_format'));
  signal?.throwIfAborted();
  const cwd=resolve(workdir),input=resolve(cwd,specPath),output=resolve(cwd,outputPath);
  const ownsRuntime=format==='pdf',temp=ownsRuntime?pdfRuntimeDirectory():join(cwd,'runtime');
  if(!ownsRuntime)mkdirSync(temp,{recursive:true,mode:0o700});
  const env={PATH:'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',LANG:process.env.LANG||'en_US.UTF-8',
    ...(process.env.HOME?{HOME:process.env.HOME}:{}),TMPDIR:temp,PYTHONDONTWRITEBYTECODE:'1',SWIFT_MODULECACHE_PATH:join(temp,'swift-cache'),CLANG_MODULE_CACHE_PATH:join(temp,'clang-cache')};
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{if(ownsRuntime)rmSync(temp,{recursive:true,force:true});};
    let child;
    try{child=spawn(capability.command,[...(capability.compiled?[]:[capability.script]),'--spec',input,'--output',output],{cwd,env,stdio:['ignore','pipe','pipe'],detached:true});}
    catch{try{cleanup();}catch{}reject(Error('document_generator_spawn_failed'));return;}
    let stdout='',stderr='',reason,timer,killTimer,done=false,spawnFailure;
    const stop=why=>{reason??=why;try{process.kill(-child.pid,'SIGTERM');}catch{}killTimer??=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},1500);};
    const abort=()=>stop('cancelled');
    const finish=(error,value)=>{
      if(done)return;done=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);
      try{cleanup();}catch{error??=Error('document_runtime_cleanup_failed');error.details={...error.details,cleanupFailed:true};}
      error?reject(error):resolve(value);
    };
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{stdout=(stdout+chunk).slice(0,65537);if(Buffer.byteLength(stdout)>65536)stop('document_generator_output_too_large');});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8000);});
    // 'close' also follows a spawn error. Wait for it before removing runtime
    // files so no surviving compiler process can still be using the directory.
    child.on('error',error=>{spawnFailure=error.code==='ENOENT'?'document_runtime_unavailable':'document_generator_spawn_failed';});
    child.on('close',(code,terminationSignal)=>{
      const details={exitCode:Number.isInteger(code)?code:null,signal:typeof terminationSignal==='string'&&/^SIG[A-Z0-9]+$/.test(terminationSignal)?terminationSignal:null};
      const failure=message=>Object.assign(Error(message),{details});
      if(reason)return finish(failure(reason));
      if(spawnFailure)return finish(failure(spawnFailure));
      if(details.signal)return finish(failure('document_generator_crashed'));
      if(code!==0){
        for(const output of [stdout,stderr]){try{const failure=JSON.parse(output);
          if(failure?.generation?.status==='failed'&&/^[a-z][a-z0-9_]{3,80}$/.test(failure.error))return finish(Object.assign(Error(failure.error),{details}));
        }catch{}}
        const match=stderr.match(/(?:^|\n)(?:Error:\s*)?([a-z][a-z0-9_]{3,80})(?:\n|$)/);return finish(failure(match?.[1]??'document_generator_failed'));
      }
      try{const receipt=JSON.parse(stdout);if(receipt?.generation?.status!=='completed'||receipt?.contentValidation?.status!=='passed'||!receipt.layoutValidation)throw Error();
        finish(null,{...receipt,generatorVersion:capability.generatorVersion,implementationSha256:capability.implementationSha256});
      }catch{finish(Error('invalid_document_generator_receipt'));}
    });
    timer=setTimeout(()=>stop('document_generation_timeout'),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
}
