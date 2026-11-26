/** Explicitly scoped facts; legacy mixed Bot memory remains available as history. */
import {randomUUID} from 'node:crypto';
export class ProjectMemory {
  constructor({ops,projects,getRequest,legacyView}){Object.assign(this,{ops,projects,getRequest,legacyView});}
  entries(projectId=this.projects.state().focus==='work'?this.projects.state().projectId:null){
    return this.ops.list('project_memory').filter(r=>r.status==='active'&&(r.scope==='personal'||projectId&&r.projectId===projectId));
  }
  view(){return {entries:this.entries().map(r=>({...r,scope:r.scope==='personal'?'personal':'own'})),legacyAvailable:true};}
  publicEntries(projectId,rows=this.entries(projectId)){
    let length=0;return rows.slice(0,40).map(({id,projectId,scope,text,topic,sourceRequestId})=>({id,projectId,scope,text,topic,sourceRequestId})).filter(row=>{length+=JSON.stringify(row).length;return length<=12000;});
  }
  recall(args={}){
    const request=this.getRequest(),projectId=request?.projectId??null;
    const query=String(args.query??args.search??'').toLowerCase();
    return {entries:this.publicEntries(projectId,this.entries(projectId).filter(r=>(!query||r.text.toLowerCase().includes(query))&&(!args.topic||r.topic===args.topic)))};
  }
  projectOptions(options,request){
    const projectId=request.projectId??null;
    const activeTexts=new Set(this.entries(projectId).map(r=>r.text));
    const retired=this.ops.list('project_memory').filter(r=>r.status==='retired'&&!activeTexts.has(r.text)&&(r.scope==='personal'||projectId&&r.projectId===projectId)).map(r=>r.text);
    const mask=value=>{
      if(typeof value==='string')return retired.reduce((text,old)=>text.replaceAll(old,'[已撤销的旧记忆]'),value);
      if(Array.isArray(value))return value.map(mask);
      if(value&&Object.getPrototypeOf(value)===Object.prototype)return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,mask(item)]));
      return value;
    };
    let lastReference=-1;
    const isReference=(block,blockIndex)=>{if(blockIndex===0||block.type!=='text')return false;try{const value=JSON.parse(block.text);return value.kind==='project_context_reference'&&value.binding&&typeof value.usage==='string';}catch{return false;}};
    for(const [index,message] of (options.messages??[]).entries())if(message.role==='user'&&message.content?.some(isReference))lastReference=index;
    const messages=options.messages?.map((message,index)=>{
      const direct=message.role==='user'&&message.content?.some(b=>b.type==='text'&&b.text===request.input);
      const content=message.content?.map((block,blockIndex)=>{
        if(message.role==='user'&&isReference(block,blockIndex)){
          if(index!==lastReference)return null;
          const value=JSON.parse(block.text);value.memory=this.publicEntries(projectId);
          if(projectId&&this.projects.store.get(projectId).status==='active'){
            const current=this.projects.store.context(projectId);
            value.context={...value.context,project:current.project,summary:current.summary};
            value.usage='这是本轮最新有效项目记录与记忆；旧参考块和历史回复不能覆盖本块，更正/撤销后不要恢复旧结论。资料引用仍按本轮绑定版本读取。';
          }
          return {...block,text:JSON.stringify(value)};
        }
        return direct?block:mask(block);
      }).filter(Boolean);
      return {...message,content,...(!direct&&message.source?{source:mask(message.source)}:{})};
    }).filter(message=>!Array.isArray(message.content)||message.content.length);
    return {...options,messages,...(retired.length?{system:mask(options.system)}:{})};
  }
  mutate(tool,args,signal){
    signal?.throwIfAborted();
    const request=this.getRequest();if(!request?.id||request.cancelled)throw Error('bridge_request_required');
    const source=this.ops.request(request.id),personal=args.scope==='personal';
    const projectId=personal?null:source.projectId;
    if(!personal&&!projectId)throw Error('explicit_personal_memory_scope_required');
    if(!['own','personal',undefined].includes(args.scope))throw Error('invalid_memory_scope');
    const text=String(tool==='remember'?args.text??'':args.entry??'').trim();
    if(!text||text.length>300)throw Error('invalid_memory');
    const targetText=tool==='forget'?text:args.replace;
    let target;
    if(targetText){const matches=this.entries(projectId).filter(r=>(personal?r.scope==='personal':r.projectId===projectId)&&r.text.includes(targetText)&&(!args.topic||r.topic===args.topic));if(matches.length!==1)throw Error('memory_match_changed');target=matches[0];}
    if(target)this.ops.put({...target,status:'retired',retiredAt:Date.now(),retiredBy:source.id});
    let record;
    if(tool==='remember'){
      record=this.entries(projectId).find(r=>r.text===text&&r.projectId===projectId&&r.scope===(personal?'personal':'project'));
      record??=this.ops.put({id:randomUUID(),kind:'project_memory',projectId,scope:personal?'personal':'project',text,topic:args.topic,
        status:'active',sourceRequestId:source.id,sourceQuote:source.input,createdAt:Date.now(),supersedes:target?.id});
    }
    return {status:'applied',projectId,recordId:record?.id??target?.id};
  }
}
