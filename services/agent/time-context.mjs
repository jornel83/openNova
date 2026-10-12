/** A logged Harness context refreshed for every model step, including long-lived sessions. */
export const name='opennova-time-context';
export const inject=['systemPrompt'];
export function apply(ctx,config={}) {
 const localZone=config.timeZone||Intl.DateTimeFormat().resolvedOptions().timeZone;
 const zones=[...new Set([localZone,'America/New_York'])];
 const formatters=zones.map(timeZone=>new Intl.DateTimeFormat('en-CA',{
  timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'long',
 }));
 ctx.systemPrompt.context({name:'opennova:current-time',order:9000,required:true,interpolate:false,text:()=>{
  const now=new Date();
  return '当前系统时间（每轮刷新；不是网页发布日期）：\n'+formatters.map((f,i)=>{
   const p=Object.fromEntries(f.formatToParts(now).map(x=>[x.type,x.value]));
   return `${zones[i]}: ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.weekday}`;
  }).join('\n')+`\n用户默认时区：${localZone}。今天、昨天、未给年份的日期按当前时间和对话上下文理解；用户明确给出的历史日期优先。`;
 }});
}
