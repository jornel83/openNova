/** SQLite outbox; delivery acknowledgements are reconciled before every retry. */
import {createHash} from 'node:crypto';
export const eventFingerprint=event=>createHash('sha256').update(JSON.stringify(event)).digest('hex');
export function ensureDeliveryTables(db){
  db.exec('CREATE TABLE IF NOT EXISTS team_event (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS team_outbox (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
}
export function enqueueTeamEvent(db,event){
  ensureDeliveryTables(db);const fingerprint=eventFingerprint(event),old=db.prepare('SELECT body FROM team_event WHERE id=?').get(event.id);
  if(old){if(eventFingerprint(JSON.parse(old.body))!==fingerprint)throw Error('team_event_conflict');return;}
  db.prepare('INSERT INTO team_event VALUES (?,?)').run(event.id,JSON.stringify(event));
  db.prepare('INSERT INTO team_outbox VALUES (?,?)').run(event.id,JSON.stringify({id:event.id,eventId:event.id,reportId:event.reportId,recipientBotId:event.recipientBotId,fingerprint,status:'pending',attempts:0,nextAttemptAt:0,createdAt:event.createdAt}));
}
export class TeamOutbox {
  constructor({db,delivery,now=Date.now,retryMs=1000,maxRetryMs=60000}){Object.assign(this,{db,delivery,now,retryMs,maxRetryMs});ensureDeliveryTables(db);this.running=null;this.closed=false;}
  get(id){const row=this.db.prepare('SELECT body FROM team_outbox WHERE id=?').get(id);return row?JSON.parse(row.body):null;}
  list(){return this.db.prepare('SELECT body FROM team_outbox ORDER BY rowid').all().map(r=>JSON.parse(r.body));}
  put(row){this.db.prepare('UPDATE team_outbox SET body=? WHERE id=?').run(JSON.stringify(row),row.id);return row;}
  receipt(event,row,receipt){
    if(!receipt||receipt.eventId!==event.id||receipt.recipientBotId!==event.recipientBotId||receipt.fingerprint!==row.fingerprint||!receipt.messageId||!receipt.sessionId)throw Error('team_delivery_receipt_invalid');
    return receipt;
  }
  tick(){if(this.closed)return Promise.resolve();if(this.running)return this.running;this.running=this.drain().finally(()=>{this.running=null;});return this.running;}
  async drain(){
    for(const original of this.list().filter(r=>r.status!=='delivered'&&r.nextAttemptAt<=this.now()).slice(0,10)){
      if(this.closed)break;
      const event=JSON.parse(this.db.prepare('SELECT body FROM team_event WHERE id=?').get(original.eventId).body);
      let row=original;
      try{
        let receipt=await this.delivery.lookup(event.id);
        if(!receipt){
          row=this.put({...row,status:'sending',attempts:row.attempts+1,lastAttemptAt:this.now()});
          await this.delivery.deliver(event);
          // A successful RPC is not a durable receipt. Read the recipient back.
          receipt=await this.delivery.lookup(event.id);
        }
        receipt=this.receipt(event,row,receipt);
        this.put({...row,status:'delivered',receipt,deliveredAt:this.now(),error:null});
      }catch(error){
        // An acknowledgement may be lost after the recipient persisted it.
        try{const receipt=this.receipt(event,row,await this.delivery.lookup(event.id));this.put({...row,status:'delivered',receipt,deliveredAt:this.now(),error:null});continue;}catch{}
        this.put({...row,status:'retry',error:String(error.message).slice(0,200),nextAttemptAt:this.now()+Math.min(this.maxRetryMs,this.retryMs*2**Math.min(row.attempts,6))});
      }
    }
  }
  async close(){this.closed=true;await this.running;}
}
