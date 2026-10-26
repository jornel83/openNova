/** Mutations use upstream storage; the journal records intent and recovery. */
const clean=text=>String(text??'').replace(/\s+/g,' ').trim().replace(/^(?:[-*•]\s+)+/,'');
const same=(a,b)=>a.text===b.text&&a.scope===b.scope&&(a.topic??null)===(b.topic??null);
export class MemoryApprovals {
  constructor(ops,{view,context,execute,invalidate,cleanEntry=clean,cleanTopic=s=>s}) {Object.assign(this,{ops,view,context,execute,invalidate,cleanEntry,cleanTopic});}
  async propose(tool,args,executionMode='manual') {
    args={...args};
    if(args.topic?.trim()){args.topic=this.cleanTopic(args.topic);if(!args.topic)throw Error('invalid_memory_topic');}else delete args.topic;
    const old=tool==='forget'?args.entry:args.replace;
    let target;
    if(old){
      const matches=(await this.view()).entries.filter(e=>e.scope==='own'&&(!args.topic||e.topic===args.topic)&&e.text.includes(old));
      if(matches.length!==1)throw Error('memory_match_changed');
      const e=matches[0];target={scope:e.scope,topic:e.topic,text:e.text};
    }
    const normalized={...args};if(tool==='remember')normalized.text=this.cleanEntry(args.text);
    if(target){normalized[tool==='forget'?'entry':'replace']=target.text;if(target.topic!=null)normalized.topic=target.topic;else delete normalized.topic;}
    const prior=this.ops.list('approval').find(p=>p.operation==='memory'&&(p.executionMode??'manual')===executionMode&&p.status==='pending'&&p.tool===tool&&JSON.stringify(p.args)===JSON.stringify({...normalized,scope:'own'}));
    if(prior)return prior;
    const p=this.ops.proposeMemory(tool,normalized,executionMode);
    return this.ops.put({...p,target:target??null});
  }
  async mutate(tool,args,signal) {
    let record;
    try{
      signal?.throwIfAborted();
      record=await this.propose(tool,args,'direct');
      signal?.throwIfAborted();
      return await this.approve(record.id,signal);
    }catch(error){
      if(record){const current=this.ops.get(record.id);if(current.status==='pending')this.ops.put({...current,status:signal?.aborted?'cancelled':'failed',error:String(error.message).slice(0,250)});}
      throw error;
    }
  }
  async approve(id,signal) {
    signal?.throwIfAborted();
    let p=this.ops.get(id);
    if(p.kind!=='approval'||p.operation!=='memory')throw Error('invalid_approval');
    if(p.status==='applied')return p;
    if(!['pending','applying'].includes(p.status))throw Error('approval_not_pending');
    const entries=(await this.view()).entries;
    signal?.throwIfAborted();
    if(p.status==='pending'){
      if(p.target&&!entries.some(e=>same(e,p.target)))throw Error('memory_match_changed');
      // Old-version partial proposals cannot silently acquire a new target.
      if((p.args.replace||p.tool==='forget')&&!p.target)throw Error('memory_proposal_needs_refresh');
      const context=await this.context();
      signal?.throwIfAborted();
      const duplicate=!p.target&&p.tool==='remember'?entries.find(e=>e.scope==='own'&&clean(e.text).toLowerCase()===clean(p.args.text).toLowerCase()):null;
      const intended=duplicate?{scope:duplicate.scope,topic:duplicate.topic,text:duplicate.text}:p.tool==='remember'?{scope:'own',topic:p.args.topic,text:p.args.text}:null;
      p=this.ops.put({...p,status:'applying',context,intended});
    }
    const isDone=rows=>{
      const oldPresent=p.target&&rows.some(e=>same(e,p.target));
      const newPresent=p.intended&&rows.some(e=>same(e,p.intended));
      return p.tool==='forget'?!oldPresent:!!newPresent&&(!p.target||!oldPresent||same(p.target,p.intended));
    };
    const done=isDone(entries);
    if(!done){
      if(p.target&&!entries.some(e=>same(e,p.target)))throw Error('memory_recovery_conflict');
      const args={...p.args};if(args.topic==null)delete args.topic;
      let error,result;
      try{result=await this.execute(p.tool,args,signal);}catch(e){error=e;}
      // The upstream tool can report failure AFTER its file rename. The view,
      // rather than success wording, decides whether the intended change landed.
      const after=(await this.view()).entries;
      if(!isDone(after)){
        const signature=rows=>JSON.stringify(rows.filter(e=>e.scope==='own').map(e=>[e.text,e.topic??null]).sort());
        const unchanged=signature(entries)===signature(after);
        const reason=String(error?.message||result||'memory_apply_not_visible').slice(0,180);
        this.ops.put({...p,status:unchanged?'failed':'conflict',error:reason});
        if(!unchanged){
          if(p.target)this.ops.retireMemory(p.target.text,p.context.messageIds);
          await this.invalidate();
        }
        throw Error('memory_apply_failed: '+reason);
      }
    }
    if(p.target)this.ops.retireMemory(p.target.text,p.context.messageIds);
    if(p.intended)this.ops.restoreMemory(p.intended.text);
    await this.invalidate();
    return this.ops.put({...p,status:'applied',result:done?'reconciled':'applied',appliedAt:Date.now()});
  }
  async recover(){
    for(const p of this.ops.list('approval').reverse())if(p.operation==='memory'&&(p.status==='applying'||(p.status==='pending'&&p.executionMode==='direct'))){
      try{await this.approve(p.id);}catch(error){
        const current=this.ops.get(p.id);
        this.ops.put({...current,status:current.status==='failed'?'failed':'conflict',error:String(error.message).slice(0,250)});
        // An uncertain mutation must not leave an old snapshot asserted as current.
        if(p.target)this.ops.retireMemory(p.target.text,p.context?.messageIds??[]);
        await this.invalidate();
      }
    }
  }
}
