/** User closure is independent of execution outcome and waits for cleanup. */
const idOk=value=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value);
const stoppable=new Set(['queued','blocked','running','pausing','waiting_input','waiting_event','paused']);
const live=new Set(['queued','blocked','running','pausing','cancelling']);
export const taskIsClosed=task=>['closing','closed'].includes(task?.closure?.status);
export function assertTaskOpen(task){if(taskIsClosed(task))throw Error('task_closed');}

export class TaskClosure {
  constructor(tasks){
    this.tasks=tasks;this.db=tasks.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_closure_action (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS background_task_closure ON background_task(json_extract(body,'$.closure.status'))`);
  }
  action(id){const row=this.db.prepare('SELECT body FROM task_closure_action WHERE id=?').get(id);return row?JSON.parse(row.body):null;}
  saveAction(action){this.db.prepare('INSERT INTO task_closure_action VALUES (?,?)').run(action.id,JSON.stringify(action));}
  request(kind,{id,runId,assignmentVersion,actionId,reason=''}){
    if(this.tasks.closed)throw Error('host_stopping');
    if(!idOk(id)||!idOk(runId)||!idOk(actionId)||typeof reason!=='string'||reason.length>2000||assignmentVersion!==undefined&&(!Number.isInteger(assignmentVersion)||assignmentVersion<1))throw Error('invalid_task_closure');
    const task=this.tasks.row('task',id),old=this.action(actionId);
    if(task.runId!==runId)throw Error('task_run_changed');
    const version=assignmentVersion??old?.assignmentVersion??task.assignmentVersion??1;
    const action={id:actionId,kind,taskId:id,runId,assignmentVersion:version,reason};
    if(old){
      if(['kind','taskId','runId','assignmentVersion','reason'].some(key=>old[key]!==action[key]))throw Error('task_id_conflict');
      // Replaying a closed action after restore must never close the task again.
      return {task,old,action};
    }
    if((task.assignmentVersion??1)!==version)throw Error('task_assignment_changed');
    if(this.tasks.closureAncestor(task))throw Error('task_closed');
    if(task.managementReview)throw Error('management_task_not_configurable');
    if(this.tasks.applying)throw Error('task_workspace_busy');
    return {task,action:{...action,createdAt:Date.now()}};
  }
  close(body){
    const {task,old,action}=this.request('close',body);
    if(old)return this.tasks.detail(task.id);
    this.tasks.atomic(()=>{
      this.saveAction(action);
      if(!taskIsClosed(task)){
        task.closure={status:'closing',actionId:action.id,runId:task.runId,assignmentVersion:task.assignmentVersion??1,requestedAt:action.createdAt,...(action.reason?{reason:action.reason}:{})};
        task.automationPaused=true;task.management={...task.management,paused:true};task.updatedAt=action.createdAt;
        if(task.handoff?.status==='stopping')task.handoff={...task.handoff,status:'cancelled',reason:'task_closed'};
        this.tasks.put('task',task);
      }
    });
    this.tasks.changed(task);this.reconcile(task.id);
    return this.tasks.detail(task.id);
  }
  reopen(body){
    const {task,old,action}=this.request('reopen',body);
    if(old)return this.tasks.detail(task.id);
    if(task.closure?.status!=='closed')throw Error('task_reopen_unavailable');
    this.tasks.atomic(()=>{
      this.saveAction(action);delete task.closure;
      task.automationPaused=true;task.management={...task.management,paused:true};task.unread=false;task.updatedAt=action.createdAt;
      this.tasks.put('task',task);
    });
    this.tasks.changed(task);return this.tasks.detail(task.id);
  }
  related(task){
    const found=new Map([[task.id,task]]),pending=[task];
    // Checks and review jobs can themselves own checks. Bound traversal by IDs,
    // including all Runs' children so an old cleanup receipt is never hidden.
    while(pending.length){const parent=pending.pop();for(const child of this.tasks.queries.related({parentTaskId:parent.id,managementTargetId:parent.id}))if(!found.has(child.id)){found.set(child.id,child);pending.push(child);}}
    return [...found.values()];
  }
  reconcile(id){
    let task=this.tasks.row('task',id);if(task.closure?.status!=='closing')return;
    for(const child of this.related(task)){
      if(!child.automationPaused||!child.management?.paused||child.handoff?.status==='stopping'){
        child.automationPaused=true;child.management={...child.management,paused:true};
        if(child.handoff?.status==='stopping')child.handoff={...child.handoff,status:'cancelled',reason:'task_closed'};
        this.tasks.put('task',child);this.tasks.changed(child);
      }
      const run=this.tasks.row('run',child.runId),job=this.tasks.row('job',run.jobId);
      if(stoppable.has(child.status)&&(live.has(child.status)||job.cleanupConfirmed===true))this.tasks.cancel(child.id,child.runId);
      else if(job.cleanupConfirmed!==true){const worker=this.tasks.workers.get(job.id);if(worker?.connected)worker.send({type:'stop',reason:'cancelled'},()=>{});}
    }
    task=this.tasks.row('task',id);
    const related=this.related(task),ids=new Set(related.map(child=>child.id));
    let historicalCleanupPending=false;
    for(const child of related){
      const unfinished=this.db.prepare("SELECT r.body AS run,j.body AS job FROM background_run r JOIN background_job j ON j.id=json_extract(r.body,'$.jobId') WHERE json_extract(r.body,'$.taskId')=? AND COALESCE(json_extract(j.body,'$.cleanupConfirmed'),0)<>1").all(child.id);
      for(const row of unfinished){
        const run=JSON.parse(row.run),job=JSON.parse(row.job);if(run.id===child.runId)continue;
        const worker=this.tasks.workers.get(job.id);if(worker?.connected)worker.send({type:'stop',reason:'cancelled'},()=>{});
        if(this.tasks.receipt(job)?.cleanupConfirmed===true){
          // Old Runs cannot pass through finish(), which is tied to the current
          // Run. Confirm cleanup without rewriting their outcome or reports.
          this.tasks.put('job',{...job,cleanupConfirmed:true});
        }else historicalCleanupPending=true;
      }
    }
    if(historicalCleanupPending)return;
    for(const child of related){
      const run=this.tasks.row('run',child.runId),job=this.tasks.row('job',run.jobId);
      if(live.has(child.status)||job.cleanupConfirmed!==true||this.tasks.workers.has(job.id))return;
    }
    for(const jobId of this.tasks.workers.keys())if(ids.has(this.tasks.row('job',jobId).taskId))return;
    task.closure={...task.closure,status:'closed',closedAt:Date.now()};task.unread=false;task.updatedAt=task.closure.closedAt;
    this.tasks.put('task',task);this.tasks.changed(task);
  }
  tick(){
    for(const row of this.db.prepare("SELECT id FROM background_task WHERE json_extract(body,'$.closure.status')='closing'").all())this.reconcile(row.id);
  }
}
