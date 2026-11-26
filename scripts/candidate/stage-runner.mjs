// Lives as leader of a private process group while the probe owns its IPC pipe.
// On loss of the verifier (including SIGKILL), reap only that group's children.
import {spawn} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';

if(!process.send)throw Error('candidate_probe_parent_required');
let child,closing=false;
function reap(){
  if(closing)return;closing=true;
  process.kill(-process.pid,'SIGTERM');
  setTimeout(()=>process.kill(-process.pid,'SIGKILL'),1000);
}
process.on('disconnect',reap);
process.on('SIGINT',reap);
process.on('SIGTERM',reap);
function done(value){if(process.connected)process.send(value,()=>{});}
process.on('message',message=>{
  if(message.type==='close')return reap();
  if(message.type==='stop'){
    if(child?.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
    return;
  }
  if(message.type!=='start'||child||closing)return;
  let fd;
  try{
    fd=openSync(message.log,'wx',0o600);
    child=spawn(message.file,message.args,{cwd:message.cwd,env:message.env,stdio:['ignore',fd,fd]});
    child.once('error',()=>done({error:'stage_spawn_failed'}));
    child.once('exit',(code,signal)=>done({code,signal}));
  }catch{done({error:'stage_spawn_failed'});}
  finally{if(fd!==undefined)closeSync(fd);}
});
