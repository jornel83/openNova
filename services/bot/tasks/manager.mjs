/** Durable Task / Run / Job records; command effects live in supervised workers. */
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,statSync,realpathSync,openSync,readSync,closeSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

const worker=fileURLToPath(new URL('./worker.mjs',import.meta.url));
const live=new Set(['queued','running','cancelling']);
const terminal=new Set(['completed','failed','cancelled','interrupted']);
const idOk=value=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
const MAX_LOG=8*1024*1024;
export class TaskManager {
  constructor({ops,home,workspace,events,spawnWorker=spawn}){
    Object.assign(this,{db:ops.db,workspace:realpathSync(workspace),events,spawnWorker});
    this.root=join(home,'tasks');mkdirSync(this.root,{recursive:true,mode:0o700});
    this.workers=new Map();this.closed=false;
    for(const table of ['background_task','background_run','background_job'])
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, body TEXT NOT NULL)`);
    // A restart never replays commands, including a launch whose delivery was
    // uncertain. A surviving supervisor will publish its cleanup receipt.
    for(const task of this.all())if(live.has(task.status)&&task.status!=='queued'){
      const run=this.row('run',task.runId),job=this.row('job',run.jobId);
      const receipt=this.receipt(job);
      this.finish(task,run,job,receipt??{status:'interrupted',cleanupConfirmed:false,error:'host_interrupted_checking_cleanup'});
    }
    this.timer=setInterval(()=>this.tick(),250);this.timer.unref();
    queueMicrotask(()=>this.tick());
  }
  row(kind,id){
    if(!idOk(id))throw Error('invalid_task_id');
    const row=this.db.prepare(`SELECT body FROM background_${kind} WHERE id=?`).get(id);
    if(!row)throw Error('unknown_task');return JSON.parse(row.body);
  }
  put(kind,record){this.db.prepare(`INSERT INTO background_${kind} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(record.id,JSON.stringify(record));return record;}
  atomic(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  all(){return this.db.prepare('SELECT body FROM background_task ORDER BY rowid DESC').all().map(r=>JSON.parse(r.body));}
  changed(task){this.events?.publish('task.updated',this.summary(task),task.requestId);}
  summary(task){
    const run=this.row('run',task.runId),job=this.row('job',run.jobId);
    return {...task,runNumber:run.number,startedAt:run.startedAt,finishedAt:run.finishedAt,exitCode:job.exitCode,error:job.error,
      cleanupConfirmed:job.cleanupConfirmed,logTruncated:job.truncated??false,
      canRetry:['failed','cancelled','interrupted'].includes(task.status)&&job.cleanupConfirmed===true};
  }
  list({limit=50,offset=0}={}){
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0)throw Error('invalid_task_page');
    const all=this.all().sort((a,b)=>Number(live.has(b.status))-Number(live.has(a.status))||Number(!!b.unread)-Number(!!a.unread));
    return {tasks:all.slice(offset,offset+limit).map(t=>this.summary(t)),total:all.length,problem:this.lastError?'task_scheduler_failed':null,
      activeCount:all.filter(t=>live.has(t.status)).length,unreadCount:all.filter(t=>t.unread).length,hasMore:offset+limit<all.length};
  }
  spec(input){
    const {title,command}=input;
    if(typeof title!=='string'||!title.trim()||title.length>160||typeof command!=='string'||!command.trim()||command.length>16000||command.includes('\0'))throw Error('invalid_task_command');
    const workdir=input.workdir??'.';
    if(typeof workdir!=='string'||!workdir||workdir.includes('\0'))throw Error('invalid_task_workdir');
    let cwd;try{cwd=realpathSync(resolve(this.workspace,workdir));}catch{throw Error('invalid_task_workdir');}
    const rel=relative(this.workspace,cwd);
    if(rel==='..'||rel.startsWith('../')||isAbsolute(rel)||!statSync(cwd).isDirectory())throw Error('invalid_task_workdir');
    const timeoutMs=input.timeoutMs??1800000;
    if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>7200000)throw Error('invalid_task_timeout');
    const artifacts=input.artifacts??[];
    if(!Array.isArray(artifacts)||artifacts.length>20||artifacts.some(p=>typeof p!=='string'||!p||p.length>1000||p.includes('\0')||isAbsolute(p)||p.split(/[\\/]/).includes('..')))throw Error('invalid_task_artifacts');
    return {title:title.trim(),command,cwd,timeoutMs,artifacts};
  }
  create(input,{requestId,source='web'}={}){
    if(this.closed)throw Error('host_stopping');
    const spec=this.spec(input),id=input.id;
    if(!idOk(id))throw Error('invalid_task_id');
    const fingerprint=hash(JSON.stringify(spec));
    const old=this.db.prepare('SELECT body FROM background_task WHERE id=?').get(id);
    if(old){const task=JSON.parse(old.body);if(task.fingerprint!==fingerprint)throw Error('task_id_conflict');return this.detail(id);}
    if(this.all().filter(t=>live.has(t.status)).length>=100)throw Error('task_queue_full');
    const now=Date.now(),task={id,...spec,fingerprint,requestId,source,status:'queued',createdAt:now,updatedAt:now,unread:false};
    this.atomic(()=>this.newRun(task,1));this.changed(task);queueMicrotask(()=>this.tick());return this.detail(id);
  }
  newRun(task,number){
    const run={id:randomUUID(),taskId:task.id,number,status:'queued',createdAt:Date.now(),jobId:randomUUID()};
    const job={id:run.jobId,runId:run.id,taskId:task.id,status:'queued',cleanupConfirmed:true,createdAt:run.createdAt};
    task.runId=run.id;task.status='queued';task.updatedAt=run.createdAt;task.unread=false;
    this.put('job',job);this.put('run',run);this.put('task',task);
  }
  detail(id){
    const task=this.row('task',id),runs=this.db.prepare("SELECT body FROM background_run WHERE json_extract(body,'$.taskId')=? ORDER BY rowid").all(id).map(r=>JSON.parse(r.body));
    return {task:this.summary(task),runs:runs.map(run=>({...run,job:{...this.row('job',run.jobId),logPath:join(this.root,run.jobId,'output.log')}}))};
  }
  directory(job){return join(this.root,job.id);}
  receipt(job){
    try{
      const value=JSON.parse(readFileSync(join(this.directory(job),'result.json'),'utf8'));
      if(value.jobId!==job.id||value.runId!==job.runId||!terminal.has(value.status)||typeof value.cleanupConfirmed!=='boolean')return null;
      return value;
    }catch{return null;}
  }
  finish(task,run,job,result){
    // Stale workers can never overwrite a replacement Run.
    if(this.row('task',task.id).runId!==run.id)return;
    const finishedAt=result.finishedAt??Date.now();
    const status=task.status==='cancelling'&&result.cleanupConfirmed?'cancelled':result.status;
    this.atomic(()=>{
      this.put('job',{...job,...result,id:job.id,status,finishedAt,artifacts:this.artifacts(task,job)});
      this.put('run',{...run,status,finishedAt});
      task={...task,status,updatedAt:finishedAt,unread:true};this.put('task',task);
    });
    this.changed(task);
  }
  artifacts(task,job){
    return task.artifacts.map((path,index)=>{
      try{
        const absolute=realpathSync(resolve(task.cwd,path)),rel=relative(this.workspace,absolute),stat=statSync(absolute);
        if(rel==='..'||rel.startsWith('../')||isAbsolute(rel)||!stat.isFile())throw Error();
        return {id:`${job.id}-${index}`,path:absolute,name:path,size:stat.size,mtimeMs:stat.mtimeMs,status:'available'};
      }catch{return {id:`${job.id}-${index}`,name:path,status:'missing'};}
    });
  }
  tick(){
    if(this.closed)return;
    try{
      for(const task of this.all()){
        const run=this.row('run',task.runId),job=this.row('job',run.jobId);
        if((live.has(task.status)&&task.status!=='queued')||job.cleanupConfirmed===false){
          const receipt=this.receipt(job);
          if(receipt&&(live.has(task.status)||receipt.cleanupConfirmed!==job.cleanupConfirmed||receipt.error!==job.error))this.finish(task,run,job,receipt);
        }
      }
      this.lastError=null;
      // One active project command. Unconfirmed cleanup also holds the slot.
      if(this.workers.size||this.all().some(t=>['running','cancelling'].includes(t.status)||this.row('job',this.row('run',t.runId).jobId).cleanupConfirmed===false))return;
      const next=this.all().reverse().filter(t=>t.status==='queued').sort((a,b)=>this.row('run',a.runId).createdAt-this.row('run',b.runId).createdAt)[0];if(next)this.launch(next);
    }catch(error){this.lastError=String(error.message);}
  }
  launch(task){
    const run=this.row('run',task.runId),job=this.row('job',run.jobId),startedAt=Date.now();
    try{mkdirSync(this.directory(job),{mode:0o700});}catch{this.finish(task,run,job,{status:'failed',error:'task_directory_failed',cleanupConfirmed:true});return;}
    task={...task,status:'running',updatedAt:startedAt};run.status='running';run.startedAt=startedAt;job.status='running';job.cleanupConfirmed=false;
    this.atomic(()=>{this.put('task',task);this.put('run',run);this.put('job',job);});this.changed(task);
    let child;
    try{
      child=this.spawnWorker(process.execPath,[worker,this.directory(job)],{cwd:task.cwd,detached:true,
        env:{...process.env,NODE_OPTIONS:''},stdio:['ignore','ignore','ignore','ipc']});
      this.workers.set(job.id,child);
      child.on('message',message=>{
        if(this.closed)return;
        if(message.type==='log')this.events?.publish('task.log',{taskId:task.id,runId:run.id,jobId:job.id,bytes:message.bytes,truncated:message.truncated},task.requestId);
        if(message.type==='result')this.tick();
      });
      const exited=()=>{
        this.workers.delete(job.id);
        if(this.closed)return;
        const current=this.row('task',task.id),receipt=this.receipt(job);
        if(current.runId===run.id&&live.has(current.status))this.finish(current,run,job,receipt??{status:'interrupted',cleanupConfirmed:false,error:'worker_lost_check_state'});
        this.tick();
      };
      child.once('exit',exited);
      child.once('error',()=>{
        this.workers.delete(job.id);
        if(!this.closed)this.finish(this.row('task',task.id),run,job,{status:'failed',cleanupConfirmed:true,error:'worker_spawn_failed'});
      });
      child.send({type:'start',spec:{jobId:job.id,runId:run.id,command:task.command,cwd:task.cwd,timeoutMs:task.timeoutMs,logLimit:MAX_LOG}},()=>{});
    }catch{
      this.workers.delete(job.id);this.finish(task,run,job,{status:'failed',cleanupConfirmed:!child?.pid,error:'worker_spawn_failed'});
    }
  }
  cancel(id,expectedRunId){
    const task=this.row('task',id),run=this.row('run',task.runId),job=this.row('job',run.jobId);
    if(expectedRunId&&expectedRunId!==task.runId)throw Error('task_run_changed');
    if(!live.has(task.status))return this.detail(id);
    if(task.status==='queued')this.finish(task,run,job,{status:'cancelled',cleanupConfirmed:true});
    else{
      task.status='cancelling';task.updatedAt=Date.now();
      this.atomic(()=>{this.put('task',task);this.put('run',{...run,status:'cancelling'});this.put('job',{...job,status:'cancelling'});});this.changed(task);
      const child=this.workers.get(job.id);if(child?.connected)child.send({type:'stop',reason:'cancelled'},()=>{});
    }
    return this.detail(id);
  }
  retry({id,runId,actionId}){
    if(this.closed)throw Error('host_stopping');
    if(!idOk(actionId))throw Error('invalid_task_id');
    const task=this.row('task',id);
    if(task.lastRetryAction===actionId)return this.detail(id);
    if(task.runId!==runId)throw Error('task_run_changed');
    if(!this.summary(task).canRetry)throw Error('task_retry_unavailable');
    const number=this.row('run',task.runId).number+1;
    task.lastRetryAction=actionId;this.atomic(()=>this.newRun(task,number));this.changed(task);queueMicrotask(()=>this.tick());return this.detail(id);
  }
  read({id,runId}){
    const task=this.row('task',id);if(task.runId===runId&&terminal.has(task.status)){task.unread=false;this.put('task',task);this.changed(task);}return this.summary(task);
  }
  jobFor(id,runId){const task=this.row('task',id),run=this.row('run',runId??task.runId);if(run.taskId!==id)throw Error('unknown_task');return this.row('job',run.jobId);}
  log({id,runId,offset=0,limit=32768}){
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<4||limit>65536)throw Error('invalid_log_range');
    const job=this.jobFor(id,runId),path=join(this.directory(job),'output.log');let fd;
    try{
      fd=openSync(path,'r');const size=statSync(path).size;
      if(offset>size)throw Error('invalid_log_range');
      const buffer=Buffer.alloc(Math.min(limit,size-offset));let length=readSync(fd,buffer,0,buffer.length,offset);
      // Keep the cursor on UTF-8 boundaries. The worker writes complete strings.
      if(offset+length<size&&length){const tail=Buffer.alloc(1);readSync(fd,tail,0,1,offset+length);if((tail[0]&0xc0)===0x80){length--;while(length>0&&(buffer[length]&0xc0)===0x80)length--;}}
      return {text:buffer.subarray(0,length).toString('utf8'),offset,nextOffset:offset+length,size,hasMore:offset+length<size,runId:job.runId,truncated:job.truncated??false};
    }catch(error){if(error.code==='ENOENT')return {text:'',offset:0,nextOffset:0,size:0,hasMore:false,runId:job.runId};throw error;}
    finally{if(fd!==undefined)closeSync(fd);}
  }
  artifact({id,runId,artifactId}){
    const job=this.jobFor(id,runId),artifact=job.artifacts?.find(a=>a.id===artifactId);
    if(!artifact||artifact.status!=='available')throw Error('task_artifact_missing');
    try{const path=realpathSync(artifact.path),stat=statSync(path);if(path!==artifact.path||!stat.isFile()||stat.size!==artifact.size||stat.mtimeMs!==artifact.mtimeMs)throw Error();return artifact;}
    catch{throw Error('task_artifact_changed');}
  }
  async close(){
    if(this.closing)return this.closing;
    this.closed=true;clearInterval(this.timer);
    return this.closing=(async()=>{
      await Promise.all([...this.workers.values()].map(child=>new Promise(resolveDone=>{
        const timer=setTimeout(resolveDone,6500);child.once('exit',()=>{clearTimeout(timer);resolveDone();});
        if(child.connected){child.send({type:'stop',reason:'interrupted'},()=>{});child.disconnect();}
      })));
      for(const task of this.all())if(['running','cancelling'].includes(task.status)){
        const run=this.row('run',task.runId),job=this.row('job',run.jobId);
        this.finish(task,run,job,this.receipt(job)??{status:'interrupted',cleanupConfirmed:false,error:'cleanup_unconfirmed'});
      }
    })();
  }
}

export function taskTools(tasks,getRequest){
  return [
    ['background_task_start','将明确的测试、构建或脚本交给后台执行，立即返回任务编号；随后结束本轮等待，用户可继续聊天。不要循环等待。命令在项目内目录运行，不能守护化；结束交流或停止播报不会取消任务。',{
      title:{type:'string',required:true},command:{type:'string',required:true},workdir:{type:'string'},timeoutMs:{type:'number'},artifacts:{type:'array',items:{type:'string'},description:'需要展示的结果文件，相对执行目录；最多 20 项。'},
    },args=>{
      const request=getRequest();if(!request||request.cancelled||request.signal?.aborted)throw Error('bridge_request_required');
      return tasks.create({...args,id:hash(request.id+'\0'+JSON.stringify(tasks.spec(args)))},{requestId:request.id,source:'assistant'});
    }],
    ['background_task_list','查询后台任务的真实状态与结果；不执行或重跑命令。',{},()=>tasks.list({limit:30})],
    ['background_task_status','查询指定后台任务及每次执行的实际结果。',{id:{type:'string',required:true}},a=>tasks.detail(a.id)],
    ['background_task_log','读取后台任务日志，nextOffset 可用于继续读取。',{id:{type:'string',required:true},runId:{type:'string'},offset:{type:'number'}},a=>tasks.log(a)],
    ['background_task_cancel','用户要求取消指定后台任务时使用；取消中不代表进程已停止，也不撤销已保存文件。',{id:{type:'string',required:true}},a=>tasks.cancel(a.id)],
    ['background_task_retry','用户明确要求重试已停止的失败、取消或中断任务时，创建新的执行尝试。先查询当前 runId。',{id:{type:'string',required:true},runId:{type:'string',required:true}},a=>{
      const request=getRequest();if(!request||request.cancelled)throw Error('bridge_request_required');
      return tasks.retry({...a,actionId:hash(request.id+'\0'+a.id+'\0'+a.runId)});
    }],
  ];
}
