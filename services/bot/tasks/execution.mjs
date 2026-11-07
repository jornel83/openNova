/** Execution permission is independent of employee specialty and workspace template. */
export const EXECUTION_POLICY_VERSION=2;
export const LOCAL_TASK_TOOLS=['glob','grep','read','write','edit','task_command','task_check','task_question'];
export const HOST_TASK_TOOLS=['browser_open','browser_read','browser_click','browser_fill','browser_scroll','browser_close','nova_show','document_open'];
export const NETWORK_TASK_TOOLS=['web_search','web_fetch','research_sources'];
export const plainWorkspace=task=>['general','documents'].includes(task.workspaceMode);
export function executionSpec(input){
  if(input.mode!==undefined&&!['analysis','edit'].includes(input.mode))throw Error('invalid_task_permission');
  const permission=input.permission??(input.mode==='analysis'?'read-only':'full');
  if(!['full','read-only'].includes(permission))throw Error('invalid_task_permission');
  const mode=permission==='read-only'?'analysis':'edit';
  if(input.mode!==undefined&&input.mode!==mode)throw Error('conflicting_task_permission');
  return {permission,mode,policyVersion:EXECUTION_POLICY_VERSION};
}
export function allowedTaskTools(config){
  if(config.managementReview)return ['glob','grep','read','review_decide'];
  const writable=(config.permission??(config.mode==='analysis'?'read-only':'full'))==='full';
  const tools=new Set(LOCAL_TASK_TOOLS);
  if(!writable)for(const name of ['write','edit','task_command','task_check'])tools.delete(name);
  if(!config.checksEnabled)tools.delete('task_check');
  if(config.policyVersion>=EXECUTION_POLICY_VERSION){
    for(const name of config.networkTools??[])if(NETWORK_TASK_TOOLS.includes(name))tools.add(name);
    if(writable)for(const name of config.hostTools??[])if(HOST_TASK_TOOLS.includes(name))tools.add(name);
  }else if(config.workspaceMode==='documents'){
    // Existing tasks retain the execution contract they were created with.
    tools.delete('task_command');tools.delete('task_check');
  }
  return [...tools];
}
