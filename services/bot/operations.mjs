/** Durable mutation journal shared by direct tools and legacy manual controls. */
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,writeFileSync,renameSync,lstatSync,realpathSync,existsSync,unlinkSync} from 'node:fs';
import {join,resolve,relative,dirname,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

const hash=x=>createHash('sha256').update(x).digest('hex');
const copy=x=>JSON.parse(JSON.stringify(x));
export class Operations {
  constructor({home,workspace,legacyWorkspace=workspace}) {
    mkdirSync(home,{recursive:true,mode:0o700});mkdirSync(workspace,{recursive:true,mode:0o700});
    this.workspace=realpathSync(workspace);
    this.db=new DatabaseSync(join(home,'bridge.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL)');
    // Pre-project records referred to the isolated test directory. Bind once;
    // never let a relative old proposal resolve against a new workspace.
    for(const r of this.list('approval'))if(r.operation==='file'&&!r.workspace)this.put({...r,workspace:resolve(legacyWorkspace)});
  }
  close(){this.db.close();}
  put(record){this.db.prepare('INSERT INTO records VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(record.id,record.kind,JSON.stringify(record));return copy(record);}
  get(id){const row=this.db.prepare('SELECT body FROM records WHERE id=?').get(id);if(!row)throw Error('unknown_id');return JSON.parse(row.body);}
  list(kind){return this.db.prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid DESC').all(kind).map(r=>JSON.parse(r.body));}
  filePath(name) {
    if(typeof name!=='string'||!name||isAbsolute(name)||name.split(/[\\/]/).some(p=>p==='..'||p==='.'||!p)||name.includes('\0'))throw Error('invalid_workspace_path');
    const path=resolve(this.workspace,name),rel=relative(this.workspace,path);
    if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('invalid_workspace_path');
    let part=this.workspace;
    for(const piece of rel.split('/')) {
      part=join(part,piece);
      if(existsSync(part)){const stat=lstatSync(part);if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile())||(stat.isFile()&&stat.nlink!==1))throw Error('invalid_workspace_path');}
      else if(part!==path)throw Error('workspace_parent_missing');
    }
    if(!realpathSync(dirname(path)).startsWith(this.workspace+'/')&&realpathSync(dirname(path))!==this.workspace)throw Error('invalid_workspace_path');
    return path;
  }
  readFile(name){const path=this.filePath(name);if(lstatSync(path).size>65536)throw Error('file_too_large');return readFileSync(path,'utf8');}
  proposeFile(name,content,executionMode='manual') {
    if(typeof content!=='string'||Buffer.byteLength(content)>65536)throw Error('file_too_large');
    const path=this.filePath(name),before=existsSync(path)?this.readFile(name):null;
    return this.put({id:randomUUID(),kind:'approval',operation:'file',workspace:this.workspace,executionMode,status:'pending',path:name,beforeHash:before===null?null:hash(before),afterHash:hash(content),content,
      diff:`--- ${name}\n+++ ${name}\n${(before??'').split('\n').map(l=>'-'+l).join('\n')}\n${content.split('\n').map(l=>'+'+l).join('\n')}`,createdAt:Date.now()});
  }
  writeFile(name,content) {
    const record=this.proposeFile(name,content,'direct');
    try{return this.approveFile(record.id);}catch(error){
      const current=this.get(record.id);
      this.put({...current,status:error.message==='file_conflict'?'conflict':current.status==='pending'?'failed':current.status,error:String(error.message).slice(0,250)});
      throw error;
    }
  }
  recoverDirectFiles() {
    for(const r of this.list('approval').reverse())if(r.operation==='file'&&r.executionMode==='direct'&&['pending','applying'].includes(r.status)){
      try{this.approveFile(r.id);}catch(error){this.put({...this.get(r.id),status:error.message==='file_conflict'?'conflict':'failed',error:String(error.message).slice(0,250)});}
    }
  }
  approveFile(id) {
    const r=this.get(id);if(r.kind!=='approval'||r.operation!=='file')throw Error('invalid_approval');
    if(r.status==='applied')return r;
    if(r.workspace!==this.workspace)throw Error('historical_workspace_mismatch');
    if(!['pending','applying'].includes(r.status))throw Error('approval_not_pending');
    const path=this.filePath(r.path),current=existsSync(path)?hash(this.readFile(r.path)):null;
    // Reconcile a crash after rename but before the SQLite commit.
    if(r.status==='applying'&&current===r.afterHash)return this.put({...r,status:'applied',appliedAt:Date.now()});
    if(current!==r.beforeHash)throw Error('file_conflict');
    this.put({...r,status:'applying'});
    const tmp=join(dirname(path),`.nova-${randomUUID()}.tmp`);
    try{writeFileSync(tmp,r.content,{mode:0o600,flag:'wx'});this.filePath(r.path);
      const final=existsSync(path)?hash(this.readFile(r.path)):null;
      if(final!==r.beforeHash)throw Error('file_conflict');
      renameSync(tmp,path);}
    finally{if(existsSync(tmp))unlinkSync(tmp);}
    return this.put({...r,status:'applied',appliedAt:Date.now()});
  }
  proposeMemory(tool,args,executionMode='manual') {
    if(!['remember','forget'].includes(tool)||!args||typeof args!=='object')throw Error('invalid_memory');
    if(args.scope&&args.scope!=='own')throw Error('only_own_memory');
    const text=tool==='remember'?args.text:args.entry;
    if(typeof text!=='string'||!text.trim()||text.length>300)throw Error('invalid_memory');
    return this.put({id:randomUUID(),kind:'approval',operation:'memory',executionMode,status:'pending',tool,args:{...args,scope:'own'},createdAt:Date.now()});
  }
  reject(id){const r=this.get(id);if(r.status!=='pending')throw Error('approval_not_pending');return this.put({...r,status:'rejected'});}
  retireMemory(text,messageIds=[]){if(!text)return;this.put({id:'retired-'+hash(text),kind:'retired',text,messageIds,createdAt:Date.now()});}
  restoreMemory(text){this.db.prepare('DELETE FROM records WHERE id=? AND kind=?').run('retired-'+hash(text),'retired');}
  retired(){return this.list('retired').map(r=>({text:r.text,messageIds:r.messageIds}));}
  startTask(label,durationMs=15000,now=Date.now()) {
    if(typeof label!=='string'||!label.trim()||label.length>200||!Number.isInteger(durationMs)||durationMs<1000||durationMs>120000)throw Error('invalid_task');
    return this.put({id:randomUUID(),kind:'task',label,status:'running',createdAt:now,dueAt:now+durationMs});
  }
  task(id,now=Date.now()){const r=this.get(id);if(r.kind!=='task')throw Error('unknown_task');return r.status==='running'&&now>=r.dueAt?this.put({...r,status:'completed',completedAt:r.dueAt,result:'受控计时任务已完成；未执行外部作业。'}):r;}
  cancelTask(id,now=Date.now()){const r=this.task(id,now);return r.status==='running'?this.put({...r,status:'cancelled',cancelledAt:now}):r;}
  submit(id,text,source='text',context={kind:'none'}) {
    if(typeof id!=='string'||!/^[\w-]{1,100}$/.test(id)||typeof text!=='string'||!text.trim()||text.length>8000)throw Error('invalid_request');
    let old;try{old=this.get(id);}catch(e){if(e.message!=='unknown_id')throw e;}
    if(old){if(old.kind!=='request'||old.input!==text||old.source!==source)throw Error('request_conflict');return {...old,duplicate:true};}
    return this.put({id,kind:'request',input:text,source,context,status:'queued',createdAt:Date.now()});
  }
  request(id){const r=this.get(id);if(r.kind!=='request')throw Error('unknown_request');return r;}
  finish(id,result){return this.put({...this.request(id),...result,updatedAt:Date.now()});}
}
