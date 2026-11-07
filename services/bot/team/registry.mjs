/** Bot owns identity; SQLite owns work settings and recoverable roster operations. */
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {nameProblem} from '../../../engine/bot/ds-bot/src/shared/mentions.js';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const active=new Set(['queued','blocked','running','pausing','cancelling','waiting_input','waiting_event','paused']);
export class TeamRegistry {
  constructor({rt,db,events,workspace}){
    Object.assign(this,{rt,db,events,workspace});this.chiefId=rt.state.mainBotIds[0];
    db.exec('CREATE TABLE IF NOT EXISTS team_record (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
    if(!this.get('settings'))this.put('settings',{schemaVersion:1,enabled:true});
    if(this.get('settings').schemaVersion!==1)throw Error('unsupported_team_schema');
    this.tail=Promise.resolve();
  }
  get(id){const r=this.db.prepare('SELECT body FROM team_record WHERE id=?').get(id);return r?JSON.parse(r.body):null;}
  put(id,value){this.db.prepare('INSERT INTO team_record VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id,JSON.stringify(value));return value;}
  enabled(){return this.get('settings').enabled;}
  profile(id){return this.get('bot:'+id)??{enabled:id===this.chiefId,revision:1,taskTypes:['code','documents','command']};}
  bot(id){const b=this.rt.botOf(id);if(!b)throw Error('unknown_team_member');return b;}
  view(){const tasks=this.tasks?.queries?.unfinished()??this.tasks?.all()??[];return {version:1,enabled:this.enabled(),chiefBotId:this.chiefId,members:Object.values(this.rt.state.bots).map(b=>{
    const work=tasks.filter(t=>(t.assignedBotId??this.chiefId)===b.id&&!t.managementReview&&active.has(t.status));
    return {id:b.id,name:b.name,role:b.role,instructions:b.instructions,chief:b.id===this.chiefId,...this.profile(b.id),
      status:work.some(t=>['running','pausing','cancelling'].includes(t.status))?'working':work.some(t=>t.status==='waiting_input')?'waiting_input':work.some(t=>t.status==='blocked')?'blocked':work.some(t=>t.status==='queued')?'queued':work.length?'paused':'idle',
      tasks:work.map(t=>({id:t.id,title:t.title,status:t.status})),model:b.model??'opennova-chatgpt/gpt-6.1-sol'};
  })};}
  changed(){this.events?.publish('team.updated',{});}
  mutate(body){const run=()=>this.change(body);const next=this.tail.then(run,run);this.tail=next.catch(()=>{});return next;}
  async recover(){for(const {body} of this.db.prepare("SELECT body FROM team_record WHERE id LIKE 'op:%'").all()){
    const op=JSON.parse(body);if(op.status!=='completed')await this.mutate(op.input);
  }}
  async change(input){
    const {actionId,action}=input;
    if(typeof actionId!=='string'||!/^[\w-]{1,100}$/.test(actionId)||!['create','update','toggle'].includes(action))throw Error('invalid_team_action');
    const fingerprint=hash(input);let op=this.get('op:'+actionId);
    if(op&&op.fingerprint!==fingerprint)throw Error('team_action_conflict');
    if(op?.status==='completed')return this.view();
    if(action==='toggle'){
      if(typeof input.enabled!=='boolean')throw Error('invalid_team_action');
      if(!input.enabled&&(this.tasks?.queries?.unfinished()??this.tasks?.all()??[]).some(t=>t.assignedBotId&&t.assignedBotId!==this.chiefId&&active.has(t.status)))throw Error('team_has_unfinished_tasks');
      this.put('settings',{schemaVersion:1,enabled:input.enabled});
    }else{
      if(!this.enabled())throw Error('team_disabled');
      const {name,role,instructions}=input;
      // Historical taskTypes describe specialties only. They never grant or
      // remove execution authority; an empty list means general work.
      const taskTypes=input.taskTypes??(action==='update'?this.profile(input.id).taskTypes:[]);
      if(typeof name!=='string'||!name.trim()||name.length>40||typeof role!=='string'||role.length>24||typeof instructions!=='string'||instructions.length>4000||!Array.isArray(taskTypes)||taskTypes.some(t=>!['code','documents','command'].includes(t)))throw Error('invalid_team_member');
      if(nameProblem(name)||input.enabled!==undefined&&typeof input.enabled!=='boolean')throw Error('invalid_team_member');
      if(!op&&Object.values(this.rt.state.bots).some(b=>b.name===name.trim()&&(action==='create'||b.id!==input.id)))throw Error('team_name_taken');
      if(action==='create'&&Object.keys(this.rt.state.bots).length>=20)throw Error('team_member_limit');
      if(action==='update'&&input.id===this.chiefId)throw Error('chief_profile_managed');
      if(action==='update'&&!op){this.bot(input.id);if(this.profile(input.id).revision!==input.revision)throw Error('team_member_changed');}
      if(input.enabled===false&&(input.id===this.chiefId||(this.tasks?.queries?.unfinished()??this.tasks?.all()??[]).some(t=>t.assignedBotId===input.id&&active.has(t.status))))throw Error('member_has_unfinished_tasks');
      if(!op){op={input,fingerprint,status:'pending',beforeIds:Object.keys(this.rt.state.bots)};this.put('op:'+actionId,op);}
      let bot;
      if(action==='create'){
        bot=Object.values(this.rt.state.bots).find(b=>b.name===name.trim()&&!op.beforeIds.includes(b.id));
        bot??=await this.rt.createBot({name,role,instructions,pickModel:true,createdBy:this.chiefId});
        this.rt.dropKickoff(bot.id);
        await this.rt.updateBot(bot.id,{model:'opennova-chatgpt/gpt-6.1-sol'});
      }else bot=await this.rt.updateBot(input.id,{name,role,instructions});
      this.put('bot:'+bot.id,{enabled:input.enabled!==false,revision:action==='create'?1:input.revision+1,taskTypes:[...new Set(taskTypes)]});
    }
    this.put('op:'+actionId,{input,fingerprint,status:'completed'});this.changed();return this.view();
  }
  assignment(input){
    const id=input.assignedBotId||this.chiefId,profile=this.profile(id);this.bot(id);
    if(id!==this.chiefId&&!this.enabled())throw Error('team_disabled');
    if(!profile.enabled)throw Error('team_member_disabled');
    return {assignedBotId:id,supervisorBotId:this.chiefId,reportTo:this.chiefId,assignmentVersion:1,
      routing:id===this.chiefId?'chief-background':'employee-background'};
  }
  snapshot(task){
    const id=task.assignedBotId??this.chiefId;this.assignment({...task,assignedBotId:id});const bot=this.bot(id);
    const read=path=>{try{if(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())return '';return readFileSync(path,'utf8').slice(0,6000);}catch(e){if(e.code==='ENOENT')return '';throw e;}};
    return {botId:id,name:bot.name,role:bot.role,instructions:id===this.chiefId?'负责完成用户交代的后台工作。':bot.instructions,
      profileRevision:this.profile(id).revision,policyVersion:1,model:'opennova-chatgpt/gpt-6.1-sol',
      memory:{own:read(join(this.rt.home,'memory','bots',id,'MEMORY.md')),team:read(join(this.rt.home,'memory','team','MEMORY.md'))}};
  }
  owner(task){const id=task.assignedBotId??this.chiefId;return {assignedBotId:id,ownerName:this.rt.botOf(id)?.name??'已停用员工',ownershipOrigin:task.assignedBotId?'assigned':'legacy'};}
}
