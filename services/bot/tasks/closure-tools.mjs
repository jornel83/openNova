import {createHash} from 'node:crypto';

export const TASK_CLOSURE_TOOLS=['background_task_close','background_task_reopen'];
export const TASK_CLOSURE_INSTRUCTIONS='用户明确说关闭任务、不再继续或从待处理移除时，使用 background_task_close；background_task_cancel 只停止执行，失败记录仍可能在待处理列表。关闭会停止后续跟进并保留执行历史与成果，只有 closure.status=closed 才能说已移出列表，closing 表示仍在停止并确认清理。关闭前从当前任务查询结果复制精确 id、runId、assignmentVersion；用户说第几个时对应最近一次向用户列出的任务，歧义时先澄清，不按新的排序猜测。关闭检查子任务不代表关闭其父任务。已关闭记录可用 background_task_list 的 filter=closed 查询；只有用户明确要求恢复才使用 background_task_reopen，恢复只是重新显示，不会执行或启用自动跟进。若用户还要求继续，恢复后查询最新状态，再按其指令明确接续或重试。';

export function taskClosureTools(tasks,getRequest){
  const action=(label,args)=>{
    const request=getRequest();
    if(!request||request.cancelled)throw Error('bridge_request_required');
    if(request.actor&&request.actor.kind!=='user')throw Error('actor_denied');
    return createHash('sha256').update(request.id+'\0'+label+'\0'+JSON.stringify(args)).digest('hex');
  };
  const binding={id:{type:'string',required:true},runId:{type:'string',required:true}};
  return [
    ['background_task_close','仅按用户明确要求关闭任务并移出默认列表，保留历史及成果。先查询当前绑定；closing 表示仍在停止，closed 才是关闭完成。不会删除文件或关闭父任务。',{
      ...binding,assignmentVersion:{type:'integer',required:true},reason:{type:'string',description:'可选，简短记录用户不再继续的原因。'}
    },args=>tasks.closeTask({...args,actionId:action('close',args)})],
    ['background_task_reopen','仅按用户明确要求将已关闭任务恢复到任务列表。保留原执行状态，不执行、不重试、不启用自动跟进。',binding,
      args=>tasks.reopenTask({...args,actionId:action('reopen',args)})],
  ];
}
