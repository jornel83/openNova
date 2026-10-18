export const reconnectDelay=attempt=>Math.min(30000,1000*2**Math.min(attempt,5));
/** Persist before executing. A worker restart never repeats an uncertain action. */
export function createCommandRunner({storage,execute}){
 const running=new Map();let queue=Promise.resolve();
 return function run(command){
  const fingerprint=JSON.stringify({method:command.method,args:command.args||{},page:command.page||null});
  if(running.has(command.id)){const old=running.get(command.id);return old.fingerprint===fingerprint?old.promise:Promise.resolve({id:command.id,status:'failed',error:'command_id_conflict'});}
  const promise=(async()=>{
   let reserved=false,previous;
   queue=queue.then(async()=>{const journal=await storage.get();previous=journal[command.id];if(!previous){if(Object.keys(journal).length>=2048)throw Error('command_journal_full');journal[command.id]={fingerprint};await storage.set(journal);reserved=true;}});
   await queue;
   if(!reserved)return {id:command.id,status:previous.fingerprint===fingerprint?'unknown':'failed',error:previous.fingerprint===fingerprint?'worker_restarted':'command_id_conflict'};
   if(!['open','read','click','fill','scroll','windows.ensure','cancel'].includes(command.method))return {id:command.id,status:'failed',error:'unsupported_method'};
   if(!Number.isFinite(command.deadlineAt)||command.deadlineAt<Date.now())return {id:command.id,status:'cancelled',error:'deadline_exceeded'};
   try{return {...await execute(command),id:command.id};}catch(e){return {id:command.id,status:'failed',error:String(e.message).slice(0,200)};}
  })();running.set(command.id,{fingerprint,promise});return promise;
 };
}
/** Keep useful text while bounding aggregate target URLs, not only individual fields. */
export function boundedResult(value){
 const r=structuredClone(value),size=()=>new TextEncoder().encode(JSON.stringify({type:'result',result:r})).length;
 while(size()>131072&&r.snapshot?.targets?.length){r.snapshot.targets.pop();r.snapshot.targetsTruncated=true;}
 while(size()>131072&&r.snapshot?.text?.length){r.snapshot.text=r.snapshot.text.slice(0,Math.floor(r.snapshot.text.length/2));r.snapshot.truncated=true;}
 return size()<=131072?r:{id:r.id,status:'failed',error:'result_too_large'};
}
