/** One command path for voice, terminal and browser clients. */
import {randomUUID,createHash} from 'node:crypto';

function approvalPreview(record) {
  if(record.kind==='tool'||record.operation!=='file')return record;
  // Earlier proposals stored a full minus/plus diff; recover the immutable old
  // content from it, never from the possibly changed live file.
  const lines=(record.diff||'').split('\n').slice(2),before=[];
  for(const line of lines){if(!line.startsWith('-'))break;before.push(line.slice(1));}
  const text=before.join('\n');
  const valid=record.beforeHash===null||createHash('sha256').update(text).digest('hex')===record.beforeHash;
  return {...record,beforeContent:record.beforeHash===null?null:valid?text:null,previewValid:valid};
}

const operationRecords=ops=>[...ops.list('approval'),...ops.list('tool')].sort((a,b)=>b.createdAt-a.createdAt);

export function createControls({ops,requests,memory,health,memoryView,shutdown,desktopOpen,context,documents,events,voice,browserState=()=>({connected:false}),voiceState=()=>({connected:false})}) {
  return async(path,body)=>{
    if(path==='/voice/publish')return voice.publish(body);
    if(path==='/voice/poll')return voice.poll(body.voiceInstanceId);
    if(path==='/voice/ack')return voice.ack(body);
    if(path==='/voice/cancel-request')return requests.cancel(body.id);
    if(path==='/voice-control'){
      if(!voice)throw Error('voice_unavailable');
      const receipt=voice.enqueue(body);
      if(['stop','end'].includes(body.action)&&receipt.requestId)await requests.cancel(receipt.requestId);
      return receipt;
    }
    if(path==='/desktop-open'){
      if(Object.keys(body).length)throw Error('invalid_desktop_request');
      if(!desktopOpen)throw Error('browser_not_enabled');
      return desktopOpen();
    }
    if(path==='/health')return health();
    if(path==='/snapshot'){
      const limit=Number.isInteger(body.limit)?Math.max(20,Math.min(500,body.limit)):50;
      const readState=()=>{const records=ops.list('request'),approvals=operationRecords(ops);
      const workContext=context?.capture()??{kind:'none'};
      return {workContext,desktop:{context:workContext,browser:browserState(),voice:voice?.snapshot()??voiceState()},health:health(),busy:!!(requests.active||requests.mutation),activeId:requests.active?.id??null,
        messages:records.slice(0,limit).reverse(),hasMore:records.length>limit,
        approvals:approvals.filter((r,i)=>i<30||records.slice(0,limit).some(m=>m.id===r.requestId)||['pending','applying','running'].includes(r.status)).map(approvalPreview)};};
      if(!events)return readState();
      const {state,cursor}=events.snapshot(readState);return {...state,cursor};
    }
    if(path==='/context-clear'){context?.clearSelection();return {context:context?.capture()??{kind:'none'}};}
    if(path==='/document-open'){
      if(!documents)throw Error('documents_not_enabled');
      if(typeof body.id!=='string'||typeof body.fileId!=='string'||Object.keys(body).some(k=>!['id','fileId'].includes(k)))throw Error('invalid_document_request');
      return requests.exclusive(()=>{const file=documents.file(body.fileId);return documents.open({id:body.id,path:file.path,applicationId:file.applicationId});});
    }
    if(path==='/ask')return requests.submit(body.id,body.text,body.source||'text');
    if(path==='/result')return ops.request(body.id);
    if(path==='/cancel'){
      const state=voice?.snapshot();
      let deliveryError;
      try{if(state?.connected&&state.requestId===body.id)voice.enqueue({id:body.controlId||randomUUID(),action:'stop',voiceInstanceId:state.voiceInstanceId,generation:state.generation,requestId:body.id});}
      catch(error){deliveryError=error;}
      const result=await requests.cancel(body.id);
      if(deliveryError)throw deliveryError;
      return result;
    }
    if(path==='/approvals')return ops.list('approval');
    if(path==='/operations')return operationRecords(ops);
    if(path==='/approve')return requests.exclusive(()=>ops.get(body.id).operation==='file'?ops.approveFile(body.id):memory.approve(body.id));
    if(path==='/reject')return requests.exclusive(()=>ops.reject(body.id));
    if(path==='/tasks')return ops.list('task').map(r=>ops.task(r.id));
    if(path==='/task')return ops.task(body.id);
    if(path==='/cancel-task')return ops.cancelTask(body.id);
    if(path==='/memory')return memoryView();
    if(path==='/shutdown')return shutdown();
    throw Error('unknown_route');
  };
}
