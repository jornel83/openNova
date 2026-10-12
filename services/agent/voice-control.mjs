import {createConnection} from 'node:net';
import {createInterface} from 'node:readline';
import {createWebBudget} from './web-budget.mjs';
import {apply as applyWebPolicy} from './web-policy.mjs';
import {SourceBook,WebEvents} from './web-events.mjs';

/** Runtime control for OpenNova's single conversational agent. */
export class VoiceControl {
  constructor(send,{web=false,limits}={}) { this.send=send;this.web=web;if(web)this.budget=createWebBudget({limits}); }
  arm(id, sessionId) {
    this.finish();
    this.current={id,sessionId,cancelled:false,attemptId:null};
    if(this.web)this.current.signal=this.budget.startRequest(id).signal;
  }
  finish() {
    const r=this.current;if(!r)return;
    if(r.abortListener)r.signal.removeEventListener('abort',r.abortListener);
    this.budget?.finishRequest(r.id);
  }
  running(agent) {
    if (String(agent.session.id) !== this.current?.sessionId) return;
    this.agent=agent;
    if (this.current.cancelled) agent.cancel({kind:'user'});
  }
  frame(agent, frame) {
    if (String(agent.session.id) !== this.current?.sessionId) return;
    this.agent=agent;
    if (this.current.cancelled) { agent.cancel({kind:'user'}); return; }
    if (frame.type === 'start') this.current.attemptId=String(frame.attemptId);
    if (!this.web && frame.type === 'chunk' && String(frame.attemptId) === this.current.attemptId &&
        frame.chunk.type === 'text-delta') {
      this.send({type:'delta',id:this.current.id,attemptId:this.current.attemptId,text:frame.chunk.text});
    }
  }
  async cancel(id) {
    if (this.current?.id !== id) return;
    this.current.cancelled=true;
    this.finish();
    if (String(this.agent?.session.id) === this.current.sessionId) {
      this.agent.cancel({kind:'user'});
      await this.agent.whenIdle();
    }
  }
}

export const name='opennova-voice-control';
export const inject=['systemPrompt'];
export async function apply(ctx,config={}) {
  const path=process.env.OPENNOVA_VOICE_SOCKET;
  if (!path) throw new Error('voice_socket_required');
  const socket=createConnection(path);
  await new Promise((resolve,reject) => {socket.once('connect',resolve);socket.once('error',reject);});
  const send=value => {
    if (socket.destroyed) return;
    if (socket.writableLength > 128*1024) { socket.destroy(); return; }
    socket.write(JSON.stringify(value)+'\n');
  };
  const control=new VoiceControl(send,config);
  if(config.web) {
    const events=new WebEvents({book:new SourceBook(),current:()=>control.current,send});
    applyWebPolicy(ctx,{budget:control.budget,
      current:agent=>String(agent?.session.id)===control.current?.sessionId?control.current:undefined,
      active:()=>control.current,
      onStatus:(r,phase,toolCallId)=>{if(!r.cancelled)send({type:'status',id:r.id,phase,step:r.step,...(toolCallId?{toolCallId}:{})});},
      onResult:(r,call,result)=>events.result(r,call,result),
      onFailure:(r,code)=>{if(!r.cancelled)send({type:'web_error',id:r.id,code});},
    });
  }
  ctx.on('agent/status', ({agent,status}) => {
    if(status==='running')control.running(agent);
    else if(String(agent.session.id)===control.current?.sessionId)control.finish();
  });
  ctx.on('agent/assistant-stream', ({agent,frame}) => control.frame(agent,frame));
  const lines=createInterface({input:socket});
  lines.on('line', async line => {
    let request;
    try {
      if (line.length > 4096) throw new Error();
      request=JSON.parse(line);
      if (!Number.isSafeInteger(request.id)) throw new Error();
      if (request.type === 'arm' && typeof request.sessionId === 'string') control.arm(request.id,request.sessionId);
      else if (request.type === 'cancel') await control.cancel(request.id);
      else throw new Error();
      send({type:'ack',rpc:request.rpc});
    } catch { send({type:'control_error',rpc:request?.rpc}); }
  });
  socket.on('error', () => { void control.cancel(control.current?.id); });
  socket.on('close', () => { void control.cancel(control.current?.id); });
  ctx.on('dispose', () => {control.finish();lines.close();socket.destroy();});
  send({type:'control_ready'});
}
