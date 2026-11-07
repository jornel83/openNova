/** Persist 0 for unlimited; Infinity is only used during budget arithmetic. */
export const validBudget=(value,min,max)=>value===0||Number.isInteger(value)&&value>=min&&value<=max;
export const remainingBudget=(limit,used=0)=>limit===0?Infinity:limit-used;
export function capBudget(...limits){
  const limit=Math.min(...limits.map(value=>value===0||value===undefined?Infinity:value));
  return limit===Infinity?0:limit;
}
