// Isolated protocol fixture: production project storage/service and voice lease.
// Model answers are synthetic; this process never starts a Bot or audio device.
import {createInterface} from 'node:readline';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Operations} from '../../../../services/bot/operations.mjs';
import {ProjectStore,DEFAULT_PROJECT_ID} from '../../../../services/bot/projects/store.mjs';
import {ProjectService} from '../../../../services/bot/projects/service.mjs';
import {createVoiceChannel} from '../../../../services/bot/desktop/voice.mjs';

const home=mkdtempSync(join(tmpdir(),'nova-voice-host-')),workspace=join(home,'A'),other=join(home,'B');
mkdirSync(workspace);mkdirSync(other);
const ops=new Operations({home,workspace}),store=new ProjectStore({ops,home,workspace});
const b=store.mutate({action:'create',actionId:'create-b',name:'B',directory:other}).result;
const voice=createVoiceChannel({pollMs:10});
let session;
const sessions={async activate({project,focus}){session={sessionId:'session-'+project.id,cwd:project.workspace,focus};},capture(){return {...session};}};
const context={capture:()=>({kind:'none'}),restore(){}};
const router={async classify(){return {focus:'work',projectId:store.state().projectId};}};
const projects=new ProjectService({store,ops,sessions,context,router,voice});
await projects.initialize();
const accepted=[],cancelled=[];
async function api(path,body){
 if(path==='/projects')return projects.view();
 if(path==='/voice/publish')return voice.publish(body);
 if(path==='/voice/poll')return voice.poll(body.voiceInstanceId);
 if(path==='/voice/ack')return voice.ack(body);
 if(path==='/snapshot')return {voice:voice.snapshot(),project:projects.state(),accepted,cancelled,b:b.id,a:DEFAULT_PROJECT_ID};
 if(path==='/select')return projects.transition({projectId:body.projectId,revision:projects.state().revision,actionId:'selection-'+body.id});
 if(path==='/ask'){
  const admission=projects.admit(body),record=ops.submit(body.id,body.text,body.source,admission.context,admission);
  const controller=new AbortController();
  const result=await projects.bind(record,{id:record.id,controller,signal:controller.signal});
  const text=result.binding.projectId===b.id?'橙色方案。':'蓝色方案。';
  ops.put({...ops.request(record.id),status:'completed',text,speechText:text});
  accepted.push({id:record.id,source:body.source,projectId:result.binding.projectId});
  return {status:'queued'};
 }
 if(path==='/result')return ops.request(body.id);
 if(path==='/voice/cancel-request'){cancelled.push(body.id);return {cancelled:true};}
 throw Error('unknown_fixture_endpoint');
}
try{
 for await(const line of createInterface({input:process.stdin})){
  const {id,path,body}=JSON.parse(line);
  try{process.stdout.write(JSON.stringify({id,result:await api(path,body)})+'\n');}
  catch(error){process.stdout.write(JSON.stringify({id,error:error.message})+'\n');}
 }
}finally{voice.close();ops.close();rmSync(home,{recursive:true,force:true});}
