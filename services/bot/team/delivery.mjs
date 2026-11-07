/** Durable Bot-envelope mailbox consumed by the separate management session.
 * Native rt.deliver uses followup and wakes a Bot; this adapter never does so.
 */
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {readdirSync,mkdirSync} from 'node:fs';
import {readJson,saveJson} from '../tasks/agent-files.mjs';
import {eventFingerprint} from './outbox.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
export class ManagementDelivery {
  constructor({home,chiefId,sessionId='opennova-management-'+hash(chiefId).slice(0,24),now=Date.now}){
    if(typeof chiefId!=='string'||!chiefId||typeof sessionId!=='string'||!sessionId)throw Error('invalid_management_recipient');
    Object.assign(this,{chiefId,sessionId,now});this.root=join(home,'team-management',hash(chiefId),hash(sessionId));mkdirSync(this.root,{recursive:true,mode:0o700});
  }
  path(eventId){return join(this.root,hash(eventId)+'.json');}
  async lookup(eventId){return readJson(this.path(eventId))?.receipt??null;}
  async deliver(event){
    if(event.recipientBotId!==this.chiefId)throw Error('management_recipient_mismatch');
    const fingerprint=eventFingerprint(event),old=readJson(this.path(event.id));
    if(old){if(old.receipt.fingerprint!==fingerprint)throw Error('management_message_conflict');return old.receipt;}
    const messageId='team-message-'+hash(event.id),receipt={eventId:event.id,recipientBotId:this.chiefId,sessionId:this.sessionId,messageId,fingerprint,acceptedAt:this.now()};
    saveJson(this.path(event.id),{receipt,message:{id:messageId,role:'user',content:[{type:'text',text:JSON.stringify({type:'opennova.task.report',...event})}],
      source:{kind:'bot',form:'relay',role:'report',exchangeId:event.id,senderSessionId:event.assignedBotId??event.taskId},event},consumedAt:null});
    return receipt;
  }
  messages(){return readdirSync(this.root).filter(n=>n.endsWith('.json')).map(n=>readJson(join(this.root,n))).sort((a,b)=>a.receipt.acceptedAt-b.receipt.acceptedAt);}
  async consume(eventId,consumerId){
    const path=this.path(eventId),record=readJson(path);if(!record)throw Error('management_message_missing');
    if(record.consumerId&&record.consumerId!==consumerId)throw Error('management_message_consumed');
    if(!record.consumedAt)saveJson(path,{...record,consumerId,consumedAt:this.now()});return record.message;
  }
}
export const createManagementDelivery=options=>new ManagementDelivery(options);
