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

export function createControls({ops,requests,tasks,team,memory,health,memoryView,shutdown,desktopOpen,context,documents,events,voice,research,replyStream,browserState=()=>({connected:false}),voiceState=()=>({connected:false})}) {
  return async(path,body)=>{
    if(path==='/team')return team?.view()??null;
    if(path==='/team-member')return requests.exclusive(()=>team.mutate(body));
    if(path==='/team-overview')return team.overview.view(body);
    if(path==='/team-watch')return tasks.watch.view(body);
    if(path==='/team-watch-policy')return requests.exclusive(()=>tasks.watch.configure(body));
    if(path==='/team-watch-ack')return requests.exclusive(()=>tasks.watch.acknowledge(body));
    if(path==='/background-tasks')return tasks.list(body);
    if(path==='/background-task')return tasks.detail(body.id);
    if(path==='/background-task-start')return tasks.create(body,{source:'web'});
    if(path==='/background-task-cancel')return tasks.cancel(body.id,body.runId);
    if(path==='/background-task-close')return tasks.closeTask(body);
    if(path==='/background-task-reopen')return tasks.reopenTask(body);
    if(path==='/background-task-retry')return tasks.retry(body);
    if(path==='/background-task-read')return tasks.read(body);
    if(path==='/background-task-log')return tasks.log(body);
    if(path==='/background-task-admission')return {foregroundBusy:!!(requests.active||requests.mutation)};
    if(path==='/background-task-rule')return tasks.ruleCreate(body);
    if(path==='/background-task-rule-toggle')return tasks.ruleToggle(body);
    if(path==='/background-task-automation')return tasks.automationPause(body);
    if(path==='/background-task-check')return tasks.createCheck(body);
    if(path==='/background-task-message')return tasks.message(body);
    if(path==='/background-task-pause')return tasks.pause(body);
    if(path==='/background-task-continue')return tasks.continue(body);
    if(path==='/background-task-diff')return tasks.diff(body);
    if(path==='/background-task-apply')return requests.exclusive(()=>tasks.applyChanges(body));
    if(path==='/tasks/review')return tasks.review(body);
    if(path==='/tasks/management')return tasks.configureManagement(body);
    if(path==='/tasks/reassign')return tasks.reassign(body);
    if(path==='/tasks/dependencies')return tasks.setDependencies(body);
    if(path==='/tasks/report-artifact'){
      const file=await tasks.reportArtifact(body);
      return requests.exclusive(()=>documents.open({id:body.actionId||randomUUID(),path:file.path}));
    }
    if(path==='/background-task-open'){
      const file=tasks.artifact(body);
      return requests.exclusive(()=>documents.open({id:body.actionId,path:file.path}));
    }
    if(path==='/research/http'){if(!research?.httpFromScript)throw Error('research_helper_disabled');return research.httpFromScript(body);}
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
    if(path==='/stream-snapshot'){
      if(!events)throw Error('events_not_enabled');
      const {state,cursor}=events.snapshot(()=>({result:research?.refresh(ops.request(body.id))??ops.request(body.id),stream:replyStream?.snapshot(body.id)??null}));
      return {...state,cursor};
    }
    if(path==='/snapshot'){
      const limit=Number.isInteger(body.limit)?Math.max(20,Math.min(500,body.limit)):50;
      const readState=()=>{const records=ops.list('request'),approvals=operationRecords(ops);
      const workContext=context?.capture()??{kind:'none'};
      return {team:team?.view()??null,tasks:tasks?.list({limit:50})??null,replyStream:replyStream?.snapshot()??null,workContext,desktop:{context:workContext,browser:browserState(),voice:voice?.snapshot()??voiceState()},health:health(),busy:!!(requests.active||requests.mutation),activeId:requests.active?.id??null,
        messages:records.slice(0,limit).reverse().map(r=>research?.refresh(r)??r),hasMore:records.length>limit,
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
    if(path==='/result'){const record=ops.request(body.id);return research?.refresh(record)??record;}
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
