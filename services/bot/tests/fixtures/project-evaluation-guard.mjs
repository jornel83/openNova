/** Manual live-model evaluation may only mutate its temporary project metadata. */
export const name='project-evaluation-tools';
export const inject=['tools','systemPrompt'];
const allowed=new Set(['project_list','project_context','project_manage','project_record','read_own_chat']);
export function apply(ctx){
  ctx.tools.guard(exec=>allowed.has(exec.name)?undefined:'Synthetic evaluation permits project metadata only.');
  ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>{const result=await next();return {...result,tools:result.tools.filter(tool=>allowed.has(tool.name))};});
}
