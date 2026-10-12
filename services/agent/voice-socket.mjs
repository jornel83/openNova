import {createServer} from 'node:net';
import {mkdtempSync,rmSync,chmodSync} from 'node:fs';
import {createInterface} from 'node:readline';

export async function voiceSocket(onDelta) {
  const directory=mkdtempSync('/tmp/opennova-voice-');
  chmodSync(directory,0o700);
  const path=directory+'/control.sock';
  let peer, lines, rpc=0, readyResolve;
  const ready=new Promise(resolve => {readyResolve=resolve;});
  const pending=new Map();
  const server=createServer(socket => {
    if (peer) {socket.destroy();return;}
    peer=socket; lines=createInterface({input:socket});
    lines.on('line',line => {
      try {
        if (line.length > 128*1024) throw new Error();
        const event=JSON.parse(line);
        if (event.type === 'control_ready') readyResolve();
        else if (['delta','status','sources','web_error'].includes(event.type)) onDelta(event);
        else if (event.type === 'ack') pending.get(event.rpc)?.resolve();
        else pending.get(event.rpc)?.reject(new Error('voice_control_failed'));
      } catch {socket.destroy();}
    });
    const failed=() => {for (const item of pending.values()) item.reject(new Error('voice_control_closed'));};
    socket.on('error',failed);socket.on('close',failed);
  });
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(path,resolve);});
  return {
    path,
    async ready() { await bounded(ready,30000); },
    async command(type,id,sessionId) {
      if (!peer || peer.destroyed) throw new Error('voice_control_closed');
      const key=++rpc;
      try {
        await bounded(new Promise((resolve,reject) => {
          pending.set(key,{resolve,reject});
          peer.write(JSON.stringify({type,id,sessionId,rpc:key})+'\n');
        }),20000);
      } finally { pending.delete(key); }
    },
    close() {lines?.close();peer?.destroy();server.close();rmSync(directory,{recursive:true,force:true});},
  };
}
export async function bounded(promise,ms) {
  let timer;
  try {return await Promise.race([promise,new Promise((_,reject) => {
    timer=setTimeout(() => reject(new Error('voice_control_timeout')),ms);
  })]);} finally {clearTimeout(timer);}
}
