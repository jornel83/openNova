/** One command path for voice, terminal and browser clients. */
import {randomUUID,createHash} from 'node:crypto';
import {generatedImageVersion} from './images/preview.mjs';
import {readDocumentProposal} from './documents/proposals.mjs';
import {documentUndoChoices} from './documents/decision-tool.mjs';
import {readProjectEdition,readProjectEditionArtifact} from './projects/edition-export.mjs';
import {experimentControl} from './experiments/service.mjs';
import {isProjectResult} from './operations.mjs';

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

function operationRecords(ops,state){
  return [...ops.list('approval'),...ops.list('tool')]
    .filter(r=>!(r.proposal||r.operation==='document_proposal_decide'||isProjectResult(r))||(state?.focus==='work'&&r.projectId===state.projectId))
    .sort((a,b)=>b.createdAt-a.createdAt);
}

export function createControls({ops,requests,tasks,team,skills,notifications,memory,projects,health,memoryView,shutdown,desktopOpen,context,documents,documentGenerator,events,voice,voiceDevices,research,replyStream,browserState=()=>({connected:false}),voiceState=()=>({connected:false})}) {
  return async(path,body)=>{
    if(path==='/projects')return projects.view();
    if(path==='/project-detail')return projects.detail(body.projectId??body.id);
    if(path==='/project-action')return requests.exclusive(()=>projects.action(body));
    if(path==='/project-reference')return requests.exclusive(()=>projects.reference(body));
    if(path==='/project-record')return requests.exclusive(()=>projects.record(body));
    if(path==='/project-edition'||path==='/project-edition-file'){
      if(!body.expectedProject||typeof body.sourceId!=='string'||body.sourceId.length>200)throw Error('invalid_project_edition');
      const state=projects.validateExpected(body.expectedProject);
      if(state.focus!=='work')throw Error('project_state_changed');
      if(path==='/project-edition')return readProjectEdition(ops,state.projectId,body.sourceId);
      if(typeof body.artifactId!=='string'||body.artifactId.length>200)throw Error('invalid_project_edition');
      const file=await readProjectEditionArtifact(ops,state.projectId,body.sourceId,body.artifactId);
      projects.validateExpected(body.expectedProject);
      return {bytes:file.bytes,contentType:file.format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
    }
    if(path==='/project-experiments'||path==='/experiment-evidence')return experimentControl(path,{ops,projects},body);
    if(path==='/skills')return skills.catalog(body);
    if(path==='/skill-action')return requests.exclusive(()=>skills.mutate(body));
    if(path==='/skill-history')return skills.store.history(body.name);
    if(path==='/skill-candidate')return requests.exclusive(()=>skills.candidate(body));
    if(path==='/team')return team?.view()??null;
    if(path==='/team-member')return requests.exclusive(()=>team.mutate(body));
    if(path==='/team-overview')return team.overview.view(body);
    if(path==='/team-watch')return tasks.watch.view(body);
    if(path==='/team-watch-policy')return requests.exclusive(()=>tasks.watch.configure(body));
    if(path==='/team-watch-ack')return requests.exclusive(()=>tasks.watch.acknowledge(body));
    if(path==='/background-tasks')return tasks.list({...body,...(projects&&!body.allProjects&&body.projectId===undefined?{projectId:projects.state().projectId}:{})});
    if(path==='/background-video-preview')return tasks.video.preview(body.id,body.recordId);
    if(path==='/background-task')return tasks.detail(body.id);
    if(path==='/background-task-start')return requests.exclusive(()=>{
      let prior;try{prior=tasks.row('task',body.id);}catch{}
      if(!prior&&projects){if(body.webClient&&!body.expectedProject)throw Error('project_state_changed');projects.validateExpected(body.expectedProject);}
      const {webClient,...input}=body;return tasks.create(input,{source:'web'});
    });
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
      return requests.exclusive(()=>documents.open({id:body.actionId||randomUUID(),path:file.path},file.mediaRole?{selectContext:false,allowVideo:file.mediaRole==='video'}:undefined));
    }
    if(path==='/background-task-open'){
      const file=tasks.artifact(body);
      return requests.exclusive(()=>documents.open({id:body.actionId,path:file.path}));
    }
    if(path==='/research/http'){if(!research?.httpFromScript)throw Error('research_helper_disabled');return research.httpFromScript(body);}
    if(path==='/voice/publish')return voice.publish(body);
    if(path==='/voice/poll')return voice.poll(body.voiceInstanceId);
    if(path==='/voice/ack')return voice.ack(body);
    if(['/voice-devices','/voice-device-settings','/voice-devices-select'].includes(path)){
      if(!voiceDevices)throw Error('voice_devices_unavailable');
      return path==='/voice-devices'?voiceDevices.list():path==='/voice-device-settings'?voiceDevices.settings():voiceDevices.select(body);
    }
    if(path==='/task-notification-next')return notifications?.next(body)??{notification:null};
    if(path==='/task-notification-claim')return notifications?.claim(body)??{notification:null};
    if(path==='/task-notification-active')return notifications?.active(body)??{valid:false};
    if(path==='/task-notification-ack')return notifications?.ack(body)??{acknowledged:false};
    if(path==='/voice/cancel-request')return requests.cancel(body.id);
    if(path==='/voice-control'){
      if(!voice)throw Error('voice_unavailable');
      // Device changes go through inventory validation and durable settings first.
      if(body.action==='devices')throw Error('invalid_voice_control');
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
      const readState=()=>{const records=notifications?null:ops.list('request'),approvals=operationRecords(ops,projects?.state());
      const recentDecisions=new Set(approvals.slice(0,30).filter(r=>r.operation==='document_proposal_decide').map(r=>r.proposalId));
      const undoable=new Set(documentUndoChoices(ops,projects?.state()).map(row=>row.id));
      const conversation=notifications?.conversation(limit,{projectId:body.projectId,unclassified:body.unclassified===true})??{messages:records.slice(0,limit).reverse(),hasMore:records.length>limit};
      const workContext=context?.capture()??{kind:'none'};
      return {projects:projects?.view()??null,team:team?.view()??null,tasks:tasks?.list({limit:50,...(projects?{projectId:projects.state().projectId}:{})})??null,replyStream:replyStream?.snapshot()??null,workContext,desktop:{context:workContext,browser:browserState(),voice:voice?.snapshot()??voiceState()},health:health(),busy:!!(requests.active||requests.mutation),activeId:requests.active?.id??null,
        messages:conversation.messages.map(r=>r.kind==='request'?(research?.refresh(r)??r):r),hasMore:conversation.hasMore,
        approvals:approvals.filter((r,i)=>i<30||conversation.messages.some(m=>m.id===r.requestId)||recentDecisions.has(r.proposal?.id)||['pending','conflict'].includes(r.proposal?.status)||['pending','applying','running'].includes(r.status)).map(r=>
          r.operation==='document_generate'&&r.proposal?.status==='applied'?{...r,proposal:{...r.proposal,undoAvailable:undoable.has(r.proposal.id)}}:approvalPreview(r))};};
      if(!events)return readState();
      const {state,cursor}=events.snapshot(readState);return {...state,cursor};
    }
    if(path==='/context-clear'){context?.clearSelection();return {context:context?.capture()??{kind:'none'}};}
    if(path==='/document-proposal'){
      if(typeof body.id!=='string'||!body.id||body.id.length>200||!body.expectedProject||Object.keys(body).some(k=>!['id','expectedProject'].includes(k)))throw Error('invalid_document_proposal');
      const state=projects?.validateExpected(body.expectedProject);
      if(state?.focus!=='work')throw Error('project_state_changed');
      return readDocumentProposal({ops,projectId:state.projectId,id:body.id});
    }
    if(path==='/document-proposal-action')return requests.exclusive(async()=>{
      if(typeof body.id!=='string'||!body.id||body.id.length>200||typeof body.actionId!=='string'||!body.actionId||body.actionId.length>180||
        !['confirm','discard','undo'].includes(body.action)||!body.expectedProject||Object.keys(body).some(k=>!['id','action','actionId','expectedProject'].includes(k)))throw Error('invalid_document_proposal');
      const state=projects.validateExpected(body.expectedProject);
      if(state.focus!=='work')throw Error('project_state_changed');
      const binding={...state,cwd:projects.project().workspace,context:context.capture()};
      const id='document-panel-decision-'+createHash('sha256').update(body.actionId).digest('hex');
      const request={id,projectId:state.projectId,binding};
      const isCurrent=()=>{const now=projects.state();return now.projectId===state.projectId&&now.focus==='work'&&now.revision===state.revision;};
      const result=await documentGenerator.decide({id:body.id,action:body.action},{id,request,isCurrent});
      if(result.contextSelected&&isCurrent())projects.saveContext();
      return result;
    });
    if(path==='/image-preview')return generatedImageVersion({ops,projects},body,{allowGif:true});
    if(path==='/gif-open')return requests.exclusive(async()=>{
      if(Object.keys(body).some(key=>!['operationId','expectedProject'].includes(key)))throw Error('invalid_image_preview');
      const {artifact}=await generatedImageVersion({ops,projects},{...body,artifact:'gif'},{allowGif:true});
      const opened=await documents.open({id:randomUUID(),path:artifact.path},{selectContext:false});
      if(opened.status!=='dispatched')throw Error(opened.error||'open_failed');
      return {status:opened.status,path:artifact.path};
    });
    if(path==='/image-select'||path==='/image-open')return requests.exclusive(async()=>{
      const {file}=await generatedImageVersion({ops,projects},body);
      if(path==='/image-open'){
        const opened=await documents.open({id:randomUUID(),path:file.path});
        if(opened.status!=='dispatched')throw Error(opened.error||'open_failed');
      }
      context.selectFile(file);
      projects.saveContext();
      return {file};
    });
    if(path==='/document-open'){
      if(!documents)throw Error('documents_not_enabled');
      if(typeof body.id!=='string'||typeof body.fileId!=='string'||Object.keys(body).some(k=>!['id','fileId'].includes(k)))throw Error('invalid_document_request');
      return requests.exclusive(()=>{const file=documents.file(body.fileId);return documents.open({id:body.id,path:file.path,applicationId:file.applicationId});});
    }
    if(path==='/ask'){
      if(projects&&body.webClient&&!body.expectedProject){let prior;try{prior=ops.request(body.id);}catch{}if(!prior)throw Error('project_state_changed');}
      return requests.submit(body.id,body.text,body.source||'text',{expectedProject:body.expectedProject});
    }
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
    if(path==='/operations')return operationRecords(ops,projects?.state());
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
