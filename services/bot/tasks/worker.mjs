/** Owns one command process group. IPC loss stops work even if the Bot crashes. */
import {spawn} from 'node:child_process';
import {appendFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {StringDecoder} from 'node:string_decoder';

const directory=process.argv[2];
let spec,child,stopReason,finished=false,rootExited=false,pipesClosed=false,bytes=0,truncated=false;
let deadline,killTimer,checkTimer,noticeTimer;
const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
const send=value=>{if(process.connected)process.send(value,()=>{});};
const groupAlive=()=>{
  if(!child?.pid)return false;
  try{process.kill(-child.pid,0);return true;}catch(error){return error.code!=='ESRCH';}
};
const killGroup=signal=>{
  if(!child?.pid)return;
  try{process.kill(-child.pid,signal);}catch(error){if(error.code!=='ESRCH')send({type:'cleanup-error'});}
};
function output(text){
  if(!text||finished)return;
  try{
    let data=Buffer.from(text),remaining=spec.logLimit-bytes;
    if(data.length>remaining){
      let end=Math.max(0,remaining);
      while(end>0&&(data[end]&0xc0)===0x80)end--;
      data=data.subarray(0,end);truncated=true;
    }
    if(data.length){appendFileSync(join(directory,'output.log'),data);bytes+=data.length;}
    if(!noticeTimer)noticeTimer=setTimeout(()=>{noticeTimer=null;send({type:'log',bytes,truncated});},150);
  }catch{stop('log_write_failed');}
}
function finish(status,extra={}){
  if(finished)return;
  finished=true;
  for(const timer of [deadline,killTimer,checkTimer,noticeTimer])clearTimeout(timer);
  const result={jobId:spec.jobId,runId:spec.runId,status,finishedAt:Date.now(),bytes,truncated,...extra};
  try{
    writeFileSync(join(directory,'result.tmp'),JSON.stringify(result),{mode:0o600});
    renameSync(join(directory,'result.tmp'),join(directory,'result.json'));
    send({type:'result'});
  }catch{process.exitCode=1;}
  if(process.connected)process.disconnect();
}
function settle(code,signal){
  if(finished)return;
  // A shell may exit before its descendants. Never release the project slot
  // while an ordinary descendant in the owned process group can still write.
  const started=Date.now();
  const check=()=>{
    if(!groupAlive()&&(!child||pipesClosed)){
      for(const decoder of Object.values(decoders))output(decoder.end());
      const status=stopReason==='cancelled'?'cancelled':stopReason==='interrupted'?'interrupted':stopReason?'failed':code===0?'completed':'failed';
      finish(status,{exitCode:code,signal,cleanupConfirmed:true,error:stopReason||undefined});return;
    }
    killGroup(Date.now()-started>1000?'SIGKILL':'SIGTERM');
    if(Date.now()-started>4500){
      child?.stdout?.destroy();child?.stderr?.destroy();
      finish('interrupted',{exitCode:code,signal,cleanupConfirmed:false,error:'cleanup_unconfirmed'});return;
    }
    checkTimer=setTimeout(check,50);
  };
  check();
}
function stop(reason){
  if(finished)return;
  stopReason??=reason;
  if(!spec)return;
  if(!child){finish(stopReason==='cancelled'?'cancelled':'interrupted',{cleanupConfirmed:true});return;}
  killGroup('SIGTERM');
  killTimer??=setTimeout(()=>killGroup('SIGKILL'),1000);
}
process.on('disconnect',()=>{stop('interrupted');if(!spec)process.exit(0);});
process.on('SIGTERM',()=>stop('interrupted'));
process.on('SIGINT',()=>stop('interrupted'));
process.on('message',message=>{
  if(message.type==='stop'){stop(message.reason==='cancelled'?'cancelled':'interrupted');return;}
  if(message.type!=='start'||spec)return;
  spec=message.spec;
  if(stopReason||!process.connected){stop(stopReason||'interrupted');return;}
  try{
    writeFileSync(join(directory,'output.log'),'',{mode:0o600,flag:'wx'});
    child=spawn('/bin/sh',['-c',spec.command],{cwd:spec.cwd,env:process.env,detached:true,stdio:['ignore','pipe','pipe']});
    child.on('error',()=>{if(!rootExited){rootExited=true;stopReason??='spawn_failed';settle(null,null);}});
    child.stdout.on('data',data=>output(decoders.stdout.write(data)));
    child.stderr.on('data',data=>output(decoders.stderr.write(data)));
    child.once('exit',(code,signal)=>{
      if(rootExited)return;rootExited=true;
      // Drain data already in pipes before checking the remaining process group.
      setImmediate(()=>settle(code,signal));
    });
    child.once('close',()=>{pipesClosed=true;});
    child.once('spawn',()=>send({type:'started',pid:child.pid}));
    deadline=setTimeout(()=>stop('task_timeout'),spec.timeoutMs);
  }catch{stopReason='spawn_failed';settle(null,null);}
});
