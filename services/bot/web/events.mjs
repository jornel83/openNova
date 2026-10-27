/** POST SSE parser, shared by authenticated browser clients. */
export async function readEvents(response,onEvent,{cursor,signal}={}) {
 const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',last={...cursor};
 const abort=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
 try {
  signal?.throwIfAborted();
  while(true){
   const {value,done}=await reader.read();signal?.throwIfAborted();if(done)throw Error('event_stream_closed');
   pending+=decoder.decode(value,{stream:true});if(pending.length>2*1024*1024)throw Error('event_frame_too_large');
   let boundary;
   while((boundary=pending.indexOf('\n\n'))>=0){
    const frame=pending.slice(0,boundary);pending=pending.slice(boundary+2);
    const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(!data)continue;
    const event=JSON.parse(data);
    if(event.hostEpoch!==last.hostEpoch||!Number.isInteger(event.seq)||event.seq>last.seq+1)throw Error('cursor_reset');
    if(event.seq<=last.seq)continue;
    onEvent(event);last={hostEpoch:event.hostEpoch,seq:event.seq};
   }
  }
 } finally {signal?.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
