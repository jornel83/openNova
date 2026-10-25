/** Serial foreground admission; client lifetimes do not own the running work. */
import {errorEvent} from '../agent/errors.mjs';
export class Requests {
  constructor(ops,run,{context,events}={}) {
    this.context=context;this.events=events;
    this.ops=ops;this.run=run;
    for(const r of ops.list('request'))if(['queued','running'].includes(r.status))ops.finish(r.id,{status:'interrupted',error:'host_restarted_check_state_before_retry'});
  }
  submit(id,text,source='text') {
    let prior;try{prior=this.ops.request(id);}catch(e){if(e.message!=='unknown_id')throw e;}
    if(this.closed)throw Error('host_stopping');
    if((this.active||this.mutation)&&!prior)throw Error('bot_busy');
    const r=this.ops.submit(id,text,source,prior?.context??this.context?.capture());
    if(r.duplicate)return r;
    const controller=new AbortController();
    const current={id:r.id,events:[],cancelled:false,controller,signal:controller.signal};this.active=current;
    current.work=Promise.resolve().then(async()=>{
      if(current.cancelled)return;
      this.ops.finish(id,{status:'running',startedAt:Date.now()});
      const result=await this.run(r,current);
      if(!current.cancelled)this.ops.finish(id,{...result,status:'completed'});
    }).catch(error=>{const diagnostic=errorEvent(error,'conversation');this.ops.finish(id,{status:'failed',error:diagnostic.code,diagnostic});})
      .finally(async()=>{try{await current.cancelling;}catch{}if(current.cancelError)return;this.settle(current);});
    return r;
  }
  async exclusive(fn) {
    if(this.closed)throw Error('host_stopping');
    if(this.active||this.mutation)throw Error('bot_busy');
    const work=Promise.resolve().then(fn);this.mutation=work;
    try{return await work;}finally{if(this.mutation===work){this.mutation=undefined;this.events?.publish('request.updated',{busy:false});}}
  }
  async close() {
    this.closed=true;
    if(this.active)await this.cancel(this.active.id);
    await this.mutation?.catch(()=>{});
  }
  async cancel(id) {
    const current=this.active;
    if(current?.id===id){
      current.cancelled=true;current.controller.abort();
      current.cancelling??=Promise.resolve().then(()=>current.cancel?.()).then(()=>{delete current.cancelError;},error=>{
        current.cancelError=true;this.ops.finish(id,{error:'cancel_cleanup_failed'});throw error;
      });
      try{await current.cancelling;}catch(error){current.cancelling=undefined;throw error;}
      await current.work;this.settle(current);
    }
    return this.ops.request(id);
  }
  settle(current){
    if(current.cancelled)this.ops.finish(current.id,{status:current.timedOut?'failed':'cancelled',error:current.timedOut?'agent_timeout':undefined,
      diagnostic:current.timedOut?errorEvent(Error('agent_timeout'),'conversation'):undefined});
    if(this.active===current){this.active=undefined;this.events?.publish('request.updated',this.ops.request(current.id),current.id);}
  }
}
