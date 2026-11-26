/** An experience candidate is a parameterized draft, never a copied transcript. */
import {digest} from './bundle.mjs';
const toolName=value=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(value);

export function experienceCandidate(task,report,review,now=Date.now()){
  const source={taskId:task.id,projectId:task.projectId,runId:report.runId,assignmentVersion:report.assignmentVersion??1,reportId:report.id,reviewId:review.id};
  const key=digest(JSON.stringify(source)),tools=[...new Set((report.evidence?.steps??[]).filter(step=>step.status==='completed'&&toolName(step.tool)).map(step=>step.tool))];
  const outputs=[...new Set((report.artifacts??[]).map(item=>/\.([a-z0-9]{1,8})$/i.exec(item.name??'')?.[1]?.toLowerCase()).filter(Boolean))];
  const checks=(report.evidence?.commands??[]).filter(item=>item.status==='completed'&&item.exitCode===0).length+(report.evidence?.checks??[]).filter(item=>item.status==='completed'&&item.exitCode===0).length;
  const family=tools.some(name=>name.startsWith('video_'))?'视频制作':tools.some(name=>name.startsWith('browser_')||name.startsWith('web_'))?'资料检索与整理':tools.some(name=>name==='write'||name==='edit')?'文件处理与交付':'任务执行与核验';
  const description=`用于${family}：确认本次输入和目标，执行工作，核对成果后交付。`;
  const content=`# ${family}\n\n这是从一次已验收任务提炼的流程草稿。下次使用时以用户的新目标、输入和验收要求为准。\n\n## 输入\n\n- input_paths：本次输入资料或素材的位置；缺少必要资料时先询问。\n- output_path：本次交付目录和文件名。\n- acceptance_criteria：本次目标、格式、数量以及检查要求。\n\n## 工作步骤\n\n1. 核对本次输入与约束，检查工具和资料是否可用。\n2. 先读取相关资料，确定可执行步骤；原资料保持用户要求的处理方式。\n3. ${tools.length?'按任务需要使用 '+tools.join('、')+' 等已授权工具；实际参数根据新输入重新确定。':'选择任务已经提供的工具，依据实际结果完成工作。'}\n4. 将本次成果写入 output_path${outputs.length?'；已观察到的交付格式包括 '+outputs.map(value=>'.'+value).join('、')+'，仍以本次要求为准':''}。\n5. 根据 acceptance_criteria 检查内容和文件；${checks?'原任务有成功执行的检查记录，本次需要重新执行适用检查。':'如存在可执行的检查，实际执行后再报告结果。'}\n6. 汇报真实结果、成果位置及未解决事项，交由总管按当前成果验收。\n\n## 适用边界\n\n- 本技能提供方法，不扩大权限、预算或用户目标。\n- 不重放历史任务中的命令、账号、文件位置或提交操作；先核对本次上下文。\n- 工具成功或文件存在不能替代内容质量检查。\n`;
  return {id:'candidate-'+key,kind:'candidate',name:'learned-'+key.slice(0,12),description,content,status:'candidate',ready:false,revision:1,source,
    observedTools:tools,observedFormats:outputs,successfulChecks:checks,createdAt:now,updatedAt:now};
}
