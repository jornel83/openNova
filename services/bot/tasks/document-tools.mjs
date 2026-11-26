/** The host owns all frozen bytes and durable receipts. A worker can only name an admitted input or destination. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,readSync,fstatSync,lstatSync,realpathSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,basename,dirname,extname,resolve,relative,isAbsolute,sep} from 'node:path';
import {createFileReader} from '../desktop/file-reader.mjs';
import {createDocumentGenerator,MAX_DOCUMENT_BYTES} from '../documents/generator.mjs';
import {MAX_SPEC_BYTES} from '../documents/spec.mjs';
import {readTaskInputBytes} from './frozen-documents.mjs';
import {readJson} from './agent-files.mjs';
import {DatabaseSync} from 'node:sqlite';

const hash=v=>createHash('sha256').update(v).digest('hex');
// These failures come from decoding and validating the immutable draft, before the executor starts.
const invalidDraftErrors=new Set(['invalid_document_spec_json','invalid_document_spec','invalid_document_text','invalid_document_heading',
  'invalid_document_list','invalid_document_table','document_summary_columns_mismatch','invalid_document_layout','invalid_document_sources',
  'unsupported_document_block','document_content_too_large','document_table_too_large','invalid_evidence_claims','invalid_evidence_citation']);
const inside=(root,p)=>{const r=relative(root,p);return r&&r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r);};
function clean(v){if(typeof v!=='string'||!v.trim()||v.length>4096||/[\\\x00-\x1f]/.test(v)||v.startsWith('//')||/^\w+:/.test(v)||v.split('/').includes('..'))throw Error('invalid_task_document_path');return v;}
function safeParents(path){let dir=dirname(path);while(!existsSync(dir)){const parent=dirname(dir);if(parent===dir||lstatExists(dir))throw Error('invalid_task_document_path');dir=parent;}
  if(realpathSync(dir)!==dir)throw Error('invalid_task_document_path');}
function lstatExists(path){try{lstatSync(path);return true;}catch(e){if(e.code!=='ENOENT')throw e;return false;}}
function bytesAt(path,limit){safeParents(path);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const s=fstatSync(fd);if(!s.isFile()||s.size<1||s.size>limit)throw Error('invalid_task_document_size');
    const b=Buffer.alloc(s.size+1);let n=0;
    while(n<b.length){const r=readSync(fd,b,n,b.length-n,n);if(!r)break;n+=r;}
    const end=fstatSync(fd);if(n!==s.size||end.ctimeMs!==s.ctimeMs||lstatSync(path).ino!==s.ino)throw Error('task_document_changed');return b.subarray(0,n);
  }finally{closeSync(fd);}}
export function taskDocumentEligibility(task,run,name){
  return task.documentResearch===true&&task.workspaceMode==='documents'&&task.policyVersion===2&&task.inputSnapshot?.version===2&&task.inputSnapshot.projectId===task.projectId&&
    !task.managementReview&&!run.managementReview&&!run.summaryRecovery&&!task.media&&!['closed','closing'].includes(task.closure?.status)&&
    (name==='document_read'||(name==='document_generate'&&task.permission==='full'));
}
/** Scoped receipts used for capture; include successful earlier runs of this assignment. */
export function documentDeliveries(ops,task){
  if(!task.documentResearch)return [];
  return ops.list('document_artifact').filter(a=>a.taskId===task.id&&a.projectId===task.projectId&&a.assignmentVersion===task.assignmentVersion);
}
function chooseFile(task,args){
  const files=task.inputSnapshot.files;let matches;
  if(args.current===true){if(args.path!==undefined)throw Error('invalid_file_read');matches=files.filter(f=>f.current);}
  else{const p=clean(args.path);matches=files.filter(f=>f.path===p||f.sourcePath===p||!p.includes('/')&&basename(f.path)===p);}
  if(matches.length!==1)throw Error(matches.length?'ambiguous_task_input':'task_document_input_not_bound');return matches[0];
}
export function createTaskDocumentTools({home,ops,tasks,readNative,runner}){
  home=realpathSync(home);
  const local=new AsyncLocalStorage(),current=()=>local.getStore();
  // Network observations live in the separate worker database, shared by this assignment's Runs.
  // Read-only and scoped by trusted home, bot, and workspace; a model cannot provide a DB path.
  function observations(s,id){
    const path=join(tasks.agentHome(s.task),'research','bridge.sqlite');
    if(!existsSync(path)||realpathSync(path)!==path)return [];
    const db=new DatabaseSync(path,{readOnly:true});
    try{return db.prepare("SELECT body FROM records WHERE kind='research_observation' AND json_extract(body,'$.botId')=? AND json_extract(body,'$.workspace')=?"+(id?' AND id=?':'')).all(
      'task:'+s.task.id,s.request.binding.cwd,...(id?[id]:[])).map(r=>({...JSON.parse(r.body),projectId:s.task.projectId}));}finally{db.close();}
  }
  const scoped={
    get(id){const s=current();let row;try{row=ops.get(id);}catch(e){if(e.message!=='unknown_id')throw e;}
      if(s&&(!row||row.taskId!==s.task.id||row.projectId!==s.task.projectId||row.assignmentVersion!==s.task.assignmentVersion))row=observations(s,id)[0];
      if(!row)throw Error('unknown_id');return row;},
    list(kind){const s=current();if(s&&kind==='research_observation')return observations(s);
      return ops.list(kind).filter(r=>s?r.taskId===s.task.id&&r.projectId===s.task.projectId&&r.assignmentVersion===s.task.assignmentVersion:!!r.taskId);},
    put(row){const s=current();if(row.kind==='file')return row;
      const tags=s?{taskId:s.task.id,runId:s.run.id,assignmentVersion:s.task.assignmentVersion,actionId:s.actionId,...s.readIntent?{readIntent:s.readIntent}:{}}:null;
      if(tags&&row.commit?.artifact)Object.assign(row.commit.artifact,tags);
      if(tags&&row.artifact)Object.assign(row.artifact,tags);
      return ops.put({...row,...tags});},
  };
  const context={capture:()=>({kind:'none'}),selectFile:()=>{}};
  const getRequest=()=>{
    const state=current();if(!state)return null;
    if(tasks.row){
      const task=tasks.row('task',state.task.id),run=tasks.row('run',state.run.id);
      if(tasks.closed||task.status!=='running'||run.status!=='running'||task.runId!==run.id||
         task.projectId!==state.task.projectId||task.assignmentVersion!==state.task.assignmentVersion||['closing','closed'].includes(task.closure?.status))return null;
    }
    return state.request;
  };
  const reader=createFileReader({home,ops:scoped,context,getRequest,readNative,resolveFrozen:()=>{
    const {file:f}=current();
    return {path:f.sourcePath,entry:'task_snapshot',saved:{bytes:readTaskInputBytes(home,f),version:{size:f.size,mtimeMs:f.mtimeMs,ctimeMs:f.ctimeMs,ino:f.ino},
      extension:extname(f.path).toLowerCase(),mime:f.mime,sha256:f.sha256,snapshotPath:f.snapshotPath}};
  }});
  const generator=createDocumentGenerator({home,ops:scoped,context,getRequest,runner,selectOutput:false});
  async function generateAtDestination(input,id,signal){
    for(;;){
      try{return await generator.generate(input,{id,signal});}
      catch(error){
        if(error.message!=='command_id_conflict')throw error;
        const old=scoped.get(id);
        if(old.operation!=='document_generate'||old.status!=='failed'||old.phase!=='not_committed'||
          old.targetPath||old.stagePath||old.spec||old.commit||old.artifact||!invalidDraftErrors.has(old.error))throw error;
        // The old receipt remains replayable. Every proposed correction competes for
        // the same next destination ID, even across runs or a process restart.
        id='task-generate-'+hash(id);
      }
    }
  }
  async function execute({task,run,name,args,actionId,signal}){
    if(!taskDocumentEligibility(task,run,name)||!args||Array.isArray(args)||typeof args!=='object'||!actionId)throw Error('task_tool_denied');
    const root=realpathSync(join(tasks.agentHome(task),'workspace'));
    if(root!==readJson(join(tasks.agentHome(task),'workspace.json'))?.path)throw Error('task_workspace_missing');
    const namespace=hash(JSON.stringify([task.projectId,task.id,task.assignmentVersion]));
    const request={id:'task-doc-'+namespace,projectId:task.projectId,signal,binding:{focus:'work',projectId:task.projectId,cwd:root,context:{kind:'none'}}};
    const state={task,run,request,actionId};
    return local.run(state,async()=>{
      let record;
      if(name==='document_read'){
        if(Object.keys(args).some(k=>!['path','current','question','startPage','endPage'].includes(k))||typeof args.question!=='string'||
          (args.current!==undefined&&typeof args.current!=='boolean'))throw Error('invalid_file_read');
        const file=chooseFile(task,args);if(!file.mime)throw Error('unsupported_file_type');state.file=file;
        const input={path:file.path,question:args.question.trim(),...(args.startPage!==undefined?{startPage:args.startPage}:{}),...(args.endPage!==undefined?{endPage:args.endPage}:{})};
        let id='task-read-'+hash(JSON.stringify([namespace,file.path,file.sha256,input]));
        // A killed transport may leave a read without a result. Only reads
        // (no publication side effect) may retry, once per later Run.
        const previous=scoped.list('tool').filter(r=>r.operation==='document_read'&&(r.id===id||r.readIntent===id));
        const saved=previous.find(r=>r.status==='completed');
        if(saved)id=saved.id;
        else if(previous.length&&!previous.some(r=>r.runId===run.id)){state.readIntent=id;id+='-'+hash(run.id).slice(0,12);}
        else if(previous.some(r=>r.readIntent&&r.runId===run.id))id=previous.find(r=>r.readIntent&&r.runId===run.id).id;
        record=await reader.read(input,{id,signal});
      }else{
        if(Object.keys(args).some(k=>!['action','format','outputPath','specPath','expectedTarget'].includes(k))||args.action!==undefined&&args.action!=='create'||
          !['docx','pdf'].includes(args.format)||args.expectedTarget!==undefined&&args.expectedTarget!=='absent')throw Error('invalid_document_generate');
        const p=resolve(root,clean(args.specPath)),output=resolve(task.documentOutputPath?task.inputSnapshot.source:root,clean(args.outputPath));
        if(!inside(join(root,'.nova-spec'),p)||extname(p)!=='.json'||extname(output)!=='.'+args.format||
           (task.documentOutputPath?output!==task.documentOutputPath:!inside(root,output)||relative(root,output).split(sep).some(x=>x.startsWith('.'))))throw Error('invalid_task_document_path');
        safeParents(output);const bytes=bytesAt(p,MAX_SPEC_BYTES);
        // Keep the selected spec immutable even if a user changes the workspace while the executor runs.
        const bucket=join(home,'task-document-specs',namespace);mkdirSync(bucket,{recursive:true,mode:0o700});
        const specPath=join(bucket,hash(bytes)+'.json');try{writeFileSync(specPath,bytes,{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST'||!bytesAt(specPath,MAX_SPEC_BYTES).equals(bytes))throw e;}
        const id='task-generate-'+hash(JSON.stringify([namespace,output]));
        record=await generateAtDestination({format:args.format,specPath,outputPath:output},id,signal);
        if(record.status==='completed'&&record.artifact){
          try{if(hash(bytesAt(record.artifact.path,MAX_DOCUMENT_BYTES))!==record.artifact.sha256)throw Error();}
          catch{throw Error('task_document_delivery_changed');}
        }
      }
      // Private caches, original request arguments and internal staging locations are not worker results.
      const {id,status,readStatus,readScope,content,limitation,recovery,error,source,artifact,contentValidation,layoutValidation,output}=record;
      return {id,status,taskId:task.id,projectId:task.projectId,readStatus,readScope,content,limitation,recovery,error,output,
        ...(source?{source:{sourceId:source.sourceId,path:source.path,name:source.name,sha256:source.sha256,version:source.version,entry:source.entry}}:{}),
        ...(artifact?{artifact:{id:artifact.id,path:artifact.path,format:artifact.format,size:artifact.size,sha256:artifact.sha256},contentValidation,layoutValidation}:{})};
    });
  }
  return {execute};
}
