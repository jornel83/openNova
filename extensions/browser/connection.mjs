export const reconnectDelay=attempt=>Math.min(30000,1000*2**Math.min(attempt,5));
/** Persist before executing. A worker restart never repeats an uncertain action. */
export function createCommandRunner({storage,execute,now=Date.now}){
 const running=new Map();let queue=Promise.resolve();
 const serial=fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;};
 return function run(command){
  for(const [key,entry] of running)if(entry.confirmed&&entry.deadlineAt<now())running.delete(key);
  const fingerprint=JSON.stringify({method:command.method,args:command.args||{},page:command.page||null});
  if(running.has(command.id)){const old=running.get(command.id);return old.fingerprint===fingerprint?old.promise:Promise.resolve({id:command.id,status:'failed',error:'command_id_conflict'});}
  const entry={fingerprint,deadlineAt:command.deadlineAt,confirmed:false};
  const promise=(async()=>{
   let previous,expired=false;
   await serial(async()=>{
    const journal=await storage.get();
    // Never discard uncertain deliveries, including records from older versions.
    for(const [key,value] of Object.entries(journal))if(value.confirmed&&value.deadlineAt<now())delete journal[key];
    previous=journal[command.id];if(previous)return;
    if(!Number.isFinite(command.deadlineAt)||command.deadlineAt<now()){expired=true;return;}
    if(Object.keys(journal).length>=2048)throw Error('command_journal_full');
    journal[command.id]={fingerprint,deadlineAt:command.deadlineAt,confirmed:false};await storage.set(journal);
   });
   if(previous)return {id:command.id,status:previous.fingerprint===fingerprint?'unknown':'failed',error:previous.fingerprint===fingerprint?'worker_restarted':'command_id_conflict'};
   if(expired)return {id:command.id,status:'cancelled',error:'deadline_exceeded'};
   if(!['open','read','click','fill','scroll','close','windows.ensure','chat.show','cancel'].includes(command.method))return {id:command.id,status:'failed',error:'unsupported_method'};
   if(command.deadlineAt<now())return {id:command.id,status:'cancelled',error:'deadline_exceeded'};
   let result;try{result={...await execute(command),id:command.id};}catch(e){result={id:command.id,status:'failed',error:String(e.message).slice(0,200)};}
   if(result.status==='completed')await serial(async()=>{const journal=await storage.get();journal[command.id].confirmed=true;await storage.set(journal);entry.confirmed=true;});
   return result;
  })();entry.promise=promise;running.set(command.id,entry);
  promise.catch(()=>running.delete(command.id));return promise;
 };
}
/** Keep useful text while bounding aggregate target URLs, not only individual fields. */
export function boundedResult(value){
 const r=structuredClone(value),size=()=>new TextEncoder().encode(JSON.stringify({type:'result',result:r})).length;
 while(size()>131072&&r.snapshot?.targets?.length){r.snapshot.targets.pop();r.snapshot.targetsTruncated=true;}
 while(size()>131072&&r.snapshot?.text?.length){r.snapshot.text=r.snapshot.text.slice(0,Math.floor(r.snapshot.text.length/2));r.snapshot.truncated=true;}
 return size()<=131072?r:{id:r.id,status:'failed',error:'result_too_large'};
}
