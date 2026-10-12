import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {bounded} from '../../services/agent/voice-socket.mjs';
/** Small host transport for the existing JSONL worker, not an agent loop. */
export class AgentClient {
  constructor({web=false,onEvent=()=>{}}={}){Object.assign(this,{web,onEvent,counter:0});}
  async start() {
    const env={...process.env};
    if(env.OPENNOVA_PROXY)Object.assign(env,{HTTP_PROXY:env.OPENNOVA_PROXY,HTTPS_PROXY:env.OPENNOVA_PROXY,NODE_USE_ENV_PROXY:'1',NO_PROXY:'localhost,127.0.0.1'});
    let resolve,reject;const ready=new Promise((a,b)=>{resolve=a;reject=b;});this.readyReject=reject;
    this.process=spawn(process.execPath,[fileURLToPath(new URL('../../services/agent/stream-worker.mjs',import.meta.url)),...(this.web?['--web']:[])],{env,stdio:['pipe','pipe','ignore']});
    this.lines=createInterface({input:this.process.stdout});
    this.lines.on('line',line=>{
      try {
        const e=JSON.parse(line);
        if(e.type==='ready'){this.ready=e;resolve(e);return;}
        if(!this.ready&&e.type==='error'){reject(Error(e.code));return;}
        if(e.id!==this.active?.id)return;
        this.onEvent(e);
        if(['reply','cancelled','error'].includes(e.type)) {
          const current=this.active;this.active=undefined;
          if(e.type==='error')current.reject(Error(e.code));else current.resolve(e);
        }
      }catch(error){this.active?.reject(error);}
    });
    this.process.on('error',e=>{reject(e);this.active?.reject(Error('worker_closed'));});
    this.exited=new Promise(r=>this.process.once('close',()=>{reject(Error('worker_closed'));this.active?.reject(Error('worker_closed'));r();}));
    return bounded(ready,65000);
  }
  send(e){this.process.stdin.write(JSON.stringify(e)+'\n');}
  ask(text) {
    if(this.active)throw Error('agent_busy');
    const id=++this.counter;
    return new Promise((resolve,reject)=>{this.active={id,resolve,reject};this.send({type:'ask',id,text});});
  }
  cancel(){if(this.active)this.send({type:'cancel',id:this.active.id});}
  async close(){
    if(!this.process)return;
    this.lines?.close();if(!this.process.stdin.destroyed)this.process.stdin.end(JSON.stringify({type:'close'})+'\n');
    try{await bounded(this.exited,30000);}catch{this.process.kill('SIGTERM');try{await bounded(this.exited,5000);}catch{this.process.kill('SIGKILL');await this.exited;}}
  }
}
