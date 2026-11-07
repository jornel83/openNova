import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TeamRegistry} from '../team/registry.mjs';
import {TeamActors} from '../team/actor.mjs';
import {validateInputFiles,prepareDocuments} from '../tasks/documents.mjs';
function fixture(t){
 const home=mkdtempSync(join(tmpdir(),'nova-team-'));const db=new DatabaseSync(':memory:');
 const state={mainBotIds:['chief'],bots:{chief:{id:'chief',name:'Nova',role:'总管'}}};let seq=0;
 const rt={home,state,botOf:id=>state.bots[id],dropKickoff:()=>{},createBot:async b=>{if(Object.values(state.bots).some(x=>x.name===b.name))throw Error('name_taken');const id='b'+(++seq);return state.bots[id]={...b,id};},updateBot:async(id,patch)=>Object.assign(state.bots[id],patch)};
 const team=new TeamRegistry({rt,db,workspace:home});t.after(()=>{db.close();rmSync(home,{recursive:true,force:true});});return {team,rt,home,db};
}
const create={action:'create',actionId:'create-1',name:'资料员',role:'整理',instructions:'根据资料整理，保留出处。',taskTypes:['documents']};
test('roster intents reconcile after upstream saved but local acknowledgement was lost',async t=>{
 const {team,rt,db}=fixture(t);let fail=true;const update=rt.updateBot;rt.updateBot=async(...args)=>{if(fail){fail=false;throw Error('simulated_crash');}return update(...args);};
 await assert.rejects(team.mutate(create),/simulated_crash/);assert.equal(Object.keys(rt.state.bots).length,2);
 const restarted=new TeamRegistry({rt,db,workspace:rt.home});await restarted.recover();await restarted.mutate(create);assert.equal(Object.keys(rt.state.bots).length,2);
 assert.equal(restarted.view().members[1].model,'opennova-chatgpt/gpt-6.1-sol');await assert.rejects(restarted.mutate({...create,name:'另一个'}),/team_action_conflict/);
});
test('specialties do not restrict assignments; membership revisions, enablement and legacy ownership still apply',async t=>{
 const {team}=fixture(t);await team.mutate(create);const m=team.view().members[1];
 assert.equal(team.assignment({kind:'agent',workspaceMode:'documents',assignedBotId:m.id}).routing,'employee-background');
 for(const workspaceMode of ['general','code','documents'])assert.equal(team.assignment({kind:'agent',workspaceMode,assignedBotId:m.id}).assignedBotId,m.id);
 assert.equal(team.assignment({command:'true',assignedBotId:m.id}).assignedBotId,m.id);
 assert.equal(team.assignment({command:'true',parentTaskId:'document-task',assignedBotId:m.id}).assignedBotId,m.id);
 assert.equal(team.assignment({command:'true'}).assignedBotId,'chief');assert.equal(team.owner({}).ownershipOrigin,'legacy');
 team.tasks={all:()=>[{assignedBotId:m.id,status:'waiting_input'}]};
 await assert.rejects(team.mutate({...create,action:'update',actionId:'disable',id:m.id,revision:m.revision,enabled:false}),/unfinished/);
 team.tasks={all:()=>[]};await team.mutate({...create,action:'update',actionId:'rename',id:m.id,revision:m.revision,name:'新名字'});
 await assert.rejects(team.mutate({...create,action:'update',actionId:'stale',id:m.id,revision:m.revision}),/member_changed/);
 await team.mutate({action:'toggle',actionId:'off',enabled:false});assert.throws(()=>team.assignment({kind:'agent',workspaceMode:'documents',assignedBotId:m.id}),/team_disabled/);
 assert.equal(team.assignment({command:'true'}).assignedBotId,'chief');
});
test('employees default to general work and omitted specialties preserve existing employee settings',async t=>{
 const {team}=fixture(t);const {taskTypes,...generic}=create;
 await team.mutate(generic);const member=team.view().members[1];assert.deepEqual(member.taskTypes,[]);
 assert.equal(team.assignment({kind:'agent',workspaceMode:'general',assignedBotId:member.id}).assignedBotId,member.id);
 await team.mutate({...create,action:'update',actionId:'specialize',id:member.id,revision:member.revision});
 let current=team.view().members[1];assert.deepEqual(current.taskTypes,['documents']);
 await team.mutate({...generic,action:'update',actionId:'rename',id:member.id,revision:current.revision,name:'研究员'});
 current=team.view().members[1];assert.deepEqual(current.taskTypes,['documents']);assert.equal(current.name,'研究员');
 await team.mutate({...generic,action:'update',actionId:'general',id:member.id,revision:current.revision,taskTypes:[]});
 current=team.view().members[1];assert.deepEqual(current.taskTypes,[]);
 await team.mutate({...generic,action:'update',actionId:'disable',id:member.id,revision:current.revision,enabled:false});
 assert.throws(()=>team.assignment({kind:'agent',workspaceMode:'general',assignedBotId:member.id}),/team_member_disabled/);
});
test('context includes only the assigned employee and team memory',async t=>{
 const {team,home}=fixture(t);await team.mutate(create);for(const [dir,text] of [['bots/b1','OWN'],['bots/chief','CHIEF_PRIVATE'],['team','SHARED']]){mkdirSync(join(home,'memory',dir),{recursive:true});writeFileSync(join(home,'memory',dir,'MEMORY.md'),text);}
 const snapshot=team.snapshot({assignedBotId:'b1',kind:'agent',workspaceMode:'documents'});assert.deepEqual(snapshot.memory,{own:'OWN',team:'SHARED'});assert.ok(!JSON.stringify(snapshot).includes('CHIEF_PRIVATE'));
});
test('host-issued actors reject forged, foreign and stale execution and admit supervisor without foreground',async t=>{
 const {team}=fixture(t);await team.mutate(create);let run={assignedBotId:'b1',assignmentVersion:1,runId:'r',status:'running'};
 const actors=new TeamActors({team,tasks:{row:()=>run}});assert.throws(()=>actors.check({kind:'user'}),/actor_denied/);
 const worker=actors.issue({kind:'worker',botId:'b1',taskId:'t',runId:'r',assignmentVersion:1});actors.check(worker,'t');assert.throws(()=>actors.check(worker,'foreign'),/actor_denied/);assert.throws(()=>actors.run(worker,()=>actors.request()),/actor_denied/);
 run={...run,runId:'new'};assert.throws(()=>actors.check(worker,'t'),/actor_stale/);
 run={assignedBotId:'chief',assignmentVersion:1,runId:'s',status:'running'};const supervisor=actors.issue({kind:'supervisor',botId:'chief',taskId:'s-task',runId:'s',assignmentVersion:1});assert.equal(actors.run(supervisor,()=>actors.request()).id,'s');actors.revoke(supervisor);assert.throws(()=>actors.check(supervisor),/actor_denied/);
});
test('document inputs refuse secrets, traversal and symlinks, preserve source and resume',async t=>{
 const {home}=fixture(t);writeFileSync(join(home,'input.txt'),'source');symlinkSync(join(home,'input.txt'),join(home,'link.txt'));
 for(const file of ['../input.txt','link.txt','.env','secrets.json'])assert.throws(()=>validateInputFiles(home,[file]));
 const taskHome=join(home,'task');const workspace=await prepareDocuments({source:home,home:taskHome,mode:'edit',inputFiles:['input.txt']});assert.equal(workspace.kind,'documents');assert.deepEqual(await prepareDocuments({source:home,home:taskHome,mode:'edit',inputFiles:[]}),workspace);
});
test('invalid or duplicate roster requests do not poison restart recovery',async t=>{
 const {team}=fixture(t);await team.mutate(create);
 await assert.rejects(team.mutate({...create,actionId:'duplicate'}),/team_name_taken/);
 await assert.rejects(team.mutate({...create,actionId:'bad-name',name:'@all'}),/invalid_team_member/);
 assert.equal(team.get('op:duplicate'),null);assert.equal(team.get('op:bad-name'),null);await team.recover();
});
