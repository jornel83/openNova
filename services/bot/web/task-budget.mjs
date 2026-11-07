// Empty form fields mean no limit; the persisted/API representation is zero.
export const budgetInput=value=>value>0?value:'';
export const budgetMinutesInput=value=>value>0?value/60000:'';
function inputLimit(value,min,max,scale=1){
  if(value===undefined||value===null||typeof value==='string'&&!value.trim())return 0;
  if(typeof value!=='number'&&typeof value!=='string')return null;
  const input=Number(value),number=scale===1?input:Math.round(input*scale);
  return Number.isFinite(input)&&Number.isSafeInteger(number)&&number>=min&&number<=max?number:null;
}
export function agentExecutionBudget({maxSteps,tokenBudget,minutes}){
  const values={maxSteps:inputLimit(maxSteps,1,128),tokenBudget:inputLimit(tokenBudget,1000,1000000),timeoutMs:inputLimit(minutes,1000,7200000,60000)};
  return Object.values(values).includes(null)?null:values;
}
export function managementExecutionBudget({tokenBudget,budgetMinutes}){
  const values={tokenBudget:inputLimit(tokenBudget,1000,3000000),timeBudgetMs:inputLimit(budgetMinutes,1000,28800000,60000)};
  return Object.values(values).includes(null)?null:values;
}
export function executionBudgetLabel(task){
  if(!task.maxSteps&&!task.tokenBudget&&!task.timeoutMs)return '执行预算不限制';
  return [task.maxSteps>0?`每轮最多 ${task.maxSteps} 个模型步骤`:'模型步骤不限制',task.tokenBudget>0?`Token 上限 ${task.tokenBudget}`:'Token 不限制',task.timeoutMs>0?`最长 ${task.timeoutMs/60000} 分钟`:'运行时间不限制'].join(' · ');
}
export function managementUsageLabel(management){
  const tokens=management.tokenBudget>0?` / ${management.tokenBudget}`:'（不限制）',minutes=management.timeBudgetMs>0?` / ${management.timeBudgetMs/60000}`:'（不限制）';
  return `累计 ${management.usedTokens??0}${tokens} Token · ${Math.ceil((management.usedDurationMs??0)/60000)}${minutes} 分钟`;
}
