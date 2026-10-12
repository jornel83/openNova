import {toSpeechText} from './speech-text.mjs';
import {mapWebLinks} from './web-links.mjs';
function canonical(raw) {
  try {const u=new URL(raw);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||raw.length>2048)return;
    if(u.hostname==='localhost'||u.hostname==='127.0.0.1'||u.hostname==='[::1]')return;
    u.hash='';return u.href;
  }catch{return;}
}
export class SourceBook {
  constructor(){this.known=new Map();this.counter=0;}
  add(items,retrieval='search') {
    for(const s of items.slice(0,20)) {
      const url=canonical(s.url);if(!url)continue;
      const previous=this.known.get(url);
      this.known.set(url,{id:previous?.id??String(++this.counter),url,
        title:String(s.title||previous?.title||new URL(url).hostname).replace(/[\x00-\x1f]/g,' ').slice(0,200),
        ...(typeof s.publishedAt==='string'?{publishedAt:s.publishedAt.slice(0,50)}:{}),
        retrievedAt:previous?.retrievedAt??new Date().toISOString(),retrieval:previous?.retrieval==='fetch'?'fetch':retrieval});
      if(this.known.size>100)this.known.delete(this.known.keys().next().value);
    }
  }
  items(){return [...this.known.values()];}
  ingest(events) {
    const names=new Map();
    for(const e of events) {
      if(e.type==='tool/call')names.set(e.data.callId,e.data.name);
      if(e.type==='tool/result')this.result(names.get(e.data.message.toolCallId),{isError:e.data.message.isError,meta:e.data.meta});
    }
  }
  result(name,result) {
    if(result.isError)return false;
    if(name==='web_search'&&Array.isArray(result.meta?.sources)){this.add(result.meta.sources);return true;}
    if(name==='web_fetch'&&result.meta?.statusCode>=200&&result.meta.statusCode<300){this.add([result.meta],'fetch');return true;}
    return false;
  }
}
export class WebEvents {
  constructor({book,current,send}){Object.assign(this,{book,current,send});}
  result(request,call,result) {
    if(this.current()!==request||request.cancelled)return;
    if(this.book.result(call.name,result))this.send({type:'sources',id:request.id,items:this.book.items()});
  }
}
export function projectWebReply(original,book) {
  if(typeof original!=='string'||original.length>16000)throw Error('response_too_large');
  const selected=new Map();
  const accept=raw=>{const s=book.known.get(canonical(raw));if(s)selected.set(s.id,s);return s;};
  const bare=url=>accept(url)?url:'';
  let text=mapWebLinks(original,{bare,markdown:(label,url)=>accept(url)?`[${label}](${url})`:mapWebLinks(label,{bare})});
  // Native tools cite URLs; ungrounded numeric markers cannot be assigned by guessing.
  text=text.replace(/\[\d+(?:\s*[,，-]\s*\d+)*\]/g,'');
  const speechText=toSpeechText(text);
  if(!speechText || speechText.length>6000)throw Error('invalid_speech_text');
  return {text,speechText,sources:[...selected.values()]};
}
