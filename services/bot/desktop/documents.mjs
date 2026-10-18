/** Dispatch local documents through Launch Services; never run the file itself. */
import {spawn} from 'node:child_process';
import {realpathSync,statSync,accessSync,constants} from 'node:fs';
import {resolve,extname,basename} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const documents=new Set(['.pdf','.png','.jpg','.jpeg','.webp','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.md','.txt']);
const sources=new Set(['.js','.mjs','.cjs','.ts','.tsx','.jsx','.py','.sh','.bash','.zsh','.json','.yaml','.yml','.toml','.xml','.html','.css','.scss','.c','.h','.cpp','.hpp','.rs','.go','.java','.swift','.sql','.rb','.php']);
const editors=new Set(['com.apple.TextEdit','com.microsoft.VSCode','com.microsoft.VSCodeInsiders','com.todesktop.230313mzl4w4u92','com.sublimetext.4','com.sublimetext.3','com.barebones.bbedit','dev.zed.Zed']);
const errorCode=e=>e.code==='ENOENT'?'file_not_found':['EACCES','EPERM'].includes(e.code)?'file_access_denied':e.message;
export function inspectFileReference(file){
 try{const stat=statSync(file.path);if(!stat.isFile())throw Error('file_not_found');return {...file,diskStatus:stat.size===file.size&&stat.mtimeMs===file.mtimeMs?'unchanged':'changed',savedVersion:{size:stat.size,mtimeMs:stat.mtimeMs}};}
 catch{return {...file,diskStatus:'missing',invalid:true};}
}
export function createDocumentOpener({workspace,ops,context,spawnOpen=spawn,timeoutMs=10000}){
 const running=new Map();
 for(const record of ops.list('tool'))if(record.operation==='document_open'&&record.status==='running')ops.put({...record,status:'unknown',error:'host_restarted_after_dispatch',finishedAt:Date.now()});
 function open(command,{signal}={}){
  const {id,requestId,path,applicationId}=command;
  if(typeof id!=='string'||!id||id.length>100)return Promise.reject(Error('invalid_command_id'));
  const fingerprint=JSON.stringify({path,applicationId:applicationId||null});
  let old;try{old=ops.get(id);}catch(e){if(e.message!=='unknown_id')throw e;}
  if(old){
   if(old.operation!=='document_open'||old.fingerprint!==fingerprint)return Promise.reject(Error('command_id_conflict'));
   return running.get(id)||Promise.resolve(old);
  }
  const record={id,commandId:id,requestId,kind:'tool',operation:'document_open',tool:'document_open',description:'打开本地文件',fingerprint,status:'running',createdAt:Date.now()};
  const finish=patch=>ops.put({...record,...patch,finishedAt:Date.now()});
  if(signal?.aborted)return Promise.resolve(finish({status:'cancelled'}));
  let file,args;
  try{
   if(typeof path!=='string'||!path||path.includes('\0'))throw Error('invalid_file_path');
   if(/^[\w+.-]+:/.test(path)||path.startsWith('//'))throw Error('file_not_local');
   const absolute=realpathSync(resolve(workspace,path)),stat=statSync(absolute),extension=extname(absolute).toLowerCase();
   if(!stat.isFile())throw Error('unsupported_file_type');accessSync(absolute,constants.R_OK);
   if(!documents.has(extension)&&!sources.has(extension))throw Error('unsupported_file_type');
   if(applicationId&&(typeof applicationId!=='string'||!/^\w[\w.-]{2,180}$/.test(applicationId)))throw Error('invalid_application_id');
   if(sources.has(extension)&&applicationId&&!editors.has(applicationId))throw Error('source_requires_editor');
   file={id:'file-'+createHash('sha256').update(absolute).digest('hex'),path:absolute,name:basename(absolute),extension,size:stat.size,mtimeMs:stat.mtimeMs,applicationId,openStatus:'dispatched',contentAccess:['.md','.txt'].includes(extension)||sources.has(extension)?'text_file':'not_connected'};
   args=[...(applicationId?['-b',applicationId]:sources.has(extension)?['-t']:[]),'--',absolute];
  }catch(e){return Promise.resolve(finish({status:'failed',error:errorCode(e)}));}
  ops.put(record); // Write before Launch Services can receive a side effect.
  const promise=new Promise(resolveResult=>{
   let child,timer,settled=false,stderr='';
   const done=patch=>{
    if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
    const result=finish({...patch,...(patch.status==='dispatched'?{file,output:'打开请求已发送；不代表应用已显示或正文已读取。'}:{})});
    if(patch.status==='dispatched'){ops.put({...file,kind:'file',createdAt:Date.now()});context.selectFile(file);}
    resolveResult(result);
   };
   const cancel=()=>{done({status:'unknown',error:'cancelled_after_dispatch'});child?.kill('SIGTERM');};
   try{
    if(signal?.aborted){done({status:'cancelled'});return;}
    const env=Object.fromEntries(['HOME','USER','LOGNAME','TMPDIR','LANG','LC_CTYPE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));env.PATH='/usr/bin:/bin:/usr/sbin:/sbin';
    child=spawnOpen('/usr/bin/open',args,{shell:false,env,stdio:['ignore','ignore','pipe']});
    child.stderr?.on('data',data=>{stderr=(stderr+data).slice(0,2000);});
    child.once('error',()=>done({status:'failed',error:'open_process_unavailable'}));
    child.once('close',(code,exitSignal)=>{
     if(exitSignal||code===null)return done({status:'unknown',error:'open_process_interrupted'});
     if(code===0)return done({status:'dispatched'});
     done({status:'failed',error:applicationId&&/find application|application.*not found|unable to find|does not exist/i.test(stderr)?'application_not_found':'open_failed',exitCode:code});
    });
    signal?.addEventListener('abort',cancel,{once:true});
    timer=setTimeout(()=>{done({status:'unknown',error:'open_timeout'});child.kill('SIGTERM');},timeoutMs);
    if(signal?.aborted)cancel();
   }catch{done({status:'failed',error:'open_process_unavailable'});}
  });
  running.set(id,promise);promise.finally(()=>running.delete(id));return promise;
 }
 return {open,file(id){const file=ops.get(id);if(file.kind!=='file')throw Error('unknown_file');return file;}};
}
export function createDocumentTool({opener,getRequest}){
 return ['document_open','用本机默认或指定应用打开实际存在的文档。先用 glob/grep 定位；同名有歧义时询问选哪个。仅返回打开回执；PDF、Office 正文未接入，文本需用 read 另行读取磁盘版本。',{
  path:{type:'string',required:true},applicationId:{type:'string',description:'可选 macOS bundle ID；不指定时使用默认应用，源代码用文本编辑器。'},
 },async args=>{const request=getRequest();if(!request?.id)throw Error('bridge_request_required');return opener.open({...args,id:randomUUID(),requestId:request.id},{signal:request.signal});}];
}
