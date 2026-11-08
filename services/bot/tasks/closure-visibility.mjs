/** Child executions remain in parent history after that parent is closed. */
export function closedAncestorSql(alias='t'){
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias))throw Error('invalid_task_alias');
  return `EXISTS (WITH RECURSIVE closed_ancestors(id,body) AS (
    SELECT p.id,p.body FROM background_task p WHERE p.id=json_extract(${alias}.body,'$.parentTaskId') OR p.id=json_extract(${alias}.body,'$.managementReview.targetTaskId')
    UNION SELECT p.id,p.body FROM background_task p JOIN closed_ancestors a ON p.id=json_extract(a.body,'$.parentTaskId') OR p.id=json_extract(a.body,'$.managementReview.targetTaskId')
  ) SELECT 1 FROM closed_ancestors WHERE json_extract(body,'$.closure.status')='closed')`;
}

export function hasClosedAncestor(tasks,task){
  const pending=[task.parentTaskId,task.managementReview?.targetTaskId],seen=new Set([task.id]);
  while(pending.length){
    const id=pending.pop();if(!id||seen.has(id))continue;seen.add(id);
    let parent;try{parent=tasks.row('task',id);}catch{continue;}
    if(parent.closure?.status==='closed')return true;
    pending.push(parent.parentTaskId,parent.managementReview?.targetTaskId);
  }
  return false;
}
