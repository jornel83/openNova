import {createConnection} from 'node:net';
import {createInterface} from 'node:readline';

/** Runtime control for OpenNova's single conversational agent. */
export class VoiceControl {
  constructor(send) { this.send=send; }
  arm(id, sessionId) {
    this.current={id,sessionId,cancelled:false,attemptId:null};
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
    if (frame.type === 'chunk' && String(frame.attemptId) === this.current.attemptId &&
        frame.chunk.type === 'text-delta') {
      this.send({type:'delta',id:this.current.id,attemptId:this.current.attemptId,text:frame.chunk.text});
    }
  }
  async cancel(id) {
    if (this.current?.id !== id) return;
    this.current.cancelled=true;
    if (String(this.agent?.session.id) === this.current.sessionId) {
      this.agent.cancel({kind:'user'});
      await this.agent.whenIdle();
    }
  }
}

export const name='opennova-voice-control';
export async function apply(ctx) {
  const path=process.env.OPENNOVA_VOICE_SOCKET;
  if (!path) throw new Error('voice_socket_required');
  const socket=createConnection(path);
  await new Promise((resolve,reject) => {socket.once('connect',resolve);socket.once('error',reject);});
  const send=value => {
    if (socket.destroyed) return;
    if (socket.writableLength > 128*1024) { socket.destroy(); return; }
    socket.write(JSON.stringify(value)+'\n');
  };
  const control=new VoiceControl(send);
  ctx.on('agent/status', ({agent,status}) => { if (status === 'running') control.running(agent); });
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
  ctx.on('dispose', () => {lines.close();socket.destroy();});
  send({type:'control_ready'});
}
