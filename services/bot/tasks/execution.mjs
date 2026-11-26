/** Execution permission is independent of employee specialty and workspace template. */
export const EXECUTION_POLICY_VERSION=2;
export const LOCAL_TASK_TOOLS=['glob','grep','read','write','edit','task_command','task_check','task_question'];
export const HOST_TASK_TOOLS=['browser_open','browser_read','browser_click','browser_fill','browser_scroll','browser_close','nova_show','document_open'];
export const NETWORK_TASK_TOOLS=['web_search','web_fetch','research_sources'];
export const TASK_MEDIA_OPERATIONS=['image_generate','gif_generate','media_export','gif_review'];
export const TASK_MEDIA_TOOLS=[...TASK_MEDIA_OPERATIONS,'task_media_status','project_media_characters'];
export const plainWorkspace=task=>['general','documents'].includes(task.workspaceMode);
// V2 Full Access already permits local commands. Its filesystem tools must
// have the same host-user reach, while legacy and review contracts stay scoped.
export const hasFullFilesystemAccess=task=>task.policyVersion>=EXECUTION_POLICY_VERSION&&task.permission==='full'&&!task.managementReview;
export function executionSpec(input){
  if(input.mode!==undefined&&!['analysis','edit'].includes(input.mode))throw Error('invalid_task_permission');
  const permission=input.permission??(input.mode==='analysis'?'read-only':'full');
  if(!['full','read-only'].includes(permission))throw Error('invalid_task_permission');
  const mode=permission==='read-only'?'analysis':'edit';
  if(input.mode!==undefined&&input.mode!==mode)throw Error('conflicting_task_permission');
  return {permission,mode,policyVersion:EXECUTION_POLICY_VERSION};
}
/** The trusted admission fixes which operation this Run can start. */
export function allowedTaskMediaTools(config){
  if(config.summaryRecovery||!hasFullFilesystemAccess(config)||!TASK_MEDIA_OPERATIONS.includes(config.media?.operation)||
    !config.skills?.some(skill=>skill.name==='image-production'&&skill.archiveRoot&&skill.version))return [];
  return [...new Set([config.media.operation,'project_media_characters','task_media_status',
    ...(config.media.operation==='gif_generate'?['gif_review']:[])])];
}
export function allowedTaskTools(config){
  if(config.summaryRecovery)return [];
  if(config.managementReview)return ['glob','grep','read',config.managementReview.kind==='skill-extraction'?'skill_draft':'review_decide'];
  const writable=(config.permission??(config.mode==='analysis'?'read-only':'full'))==='full';
  if(config.documentResearch){
    if(config.workspaceMode!=='documents'||config.policyVersion!==2||config.inputSnapshot?.version!==2||config.media)return [];
    return ['read','task_question',...(config.bridge?.scoped?['document_read']:[]),...(writable?['write',...(config.bridge?.scoped?['document_generate']:[])]:[]),
      ...(config.networkTools??[]).filter(name=>NETWORK_TASK_TOOLS.includes(name))];
  }
  const tools=new Set(LOCAL_TASK_TOOLS);
  if(config.skills?.length){tools.add('skill');if(writable&&!config.media&&config.skills.some(skill=>skill.name==='video-production'))for(const name of ['video_validate','video_submit','video_status','video_wait','video_download','video_edit','video_generate'])tools.add(name);}
  // An explicit media assignment grants one typed operation, not a second
  // execution route around its frozen inputs and destination.
  if(!writable||config.media)for(const name of ['write','edit','task_command','task_check'])tools.delete(name);
  if(config.bridge?.scoped)for(const name of allowedTaskMediaTools(config))tools.add(name);
  if(!config.checksEnabled)tools.delete('task_check');
  if(config.policyVersion>=EXECUTION_POLICY_VERSION){
    for(const name of config.networkTools??[])if(NETWORK_TASK_TOOLS.includes(name))tools.add(name);
    if(writable&&!config.media)for(const name of config.hostTools??[])if(HOST_TASK_TOOLS.includes(name))tools.add(name);
  }else if(config.workspaceMode==='documents'){
    // Existing tasks retain the execution contract they were created with.
    tools.delete('task_command');tools.delete('task_check');
  }
  return [...tools];
}
