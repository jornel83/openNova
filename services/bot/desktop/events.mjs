/** Ephemeral invalidations; SQLite and a fresh snapshot remain authoritative. */
import {randomUUID} from 'node:crypto';
export function createEvents({capacity=512}={}) {
 if(!Number.isInteger(capacity)||capacity<1)throw Error('invalid_event_capacity');
 const hostEpoch=randomUUID(),listeners=new Set(),buffer=[];let seq=0,closed=false;
 const cursor=()=>({hostEpoch,seq});
 const deliver=(listener,event)=>{try{if(listener(structuredClone(event))===false)listeners.delete(listener);}catch{listeners.delete(listener);}};
 return {
  publish(type,payload,requestId){
   if(closed)return;
   const event={hostEpoch,seq:++seq,type,...(requestId?{requestId}:{}),payload:structuredClone(payload)};
   buffer.push(event);if(buffer.length>capacity)buffer.shift();
   for(const listener of [...listeners])deliver(listener,event);
  },
  snapshot(readState){
   // Synchronous readers only: no async gap between state and high-water mark.
   const state=readState();if(state?.then)throw Error('snapshot_must_be_synchronous');
   return {state,cursor:cursor()};
  },
  subscribe(from,onEvent){
   if(closed)throw Error('events_closed');
   if(!from||from.hostEpoch!==hostEpoch||!Number.isInteger(from.seq)||from.seq<0||from.seq>seq||from.seq<seq-buffer.length)throw Error('cursor_reset');
   listeners.add(onEvent);
   for(const event of buffer.filter(e=>e.seq>from.seq)){if(!listeners.has(onEvent))break;deliver(onEvent,event);}
   return ()=>listeners.delete(onEvent);
  },
  close(){closed=true;listeners.clear();buffer.length=0;},
 };
}
