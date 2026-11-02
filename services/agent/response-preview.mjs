/** A provisional display channel. It never supplies executable tools or history. */
export function createResponsePreview(emit=()=>{}, {now=Date.now,enabled=true}={}) {
  let itemId, index, text='', started=false, ended=false, firstText=false, mixed=false;
  const send=event=>{try{emit({...event,at:now()});}catch{/* A viewer cannot own inference. */}};
  const abandon=reason=>{if(ended)return;ended=true;send({type:'abandoned',reason});};
  const invalid=()=>{abandon('stream_changed');throw Error('incomplete_model_response');};
  send({type:'start'});
  return {
    event(event) {
      if(ended)return;
      if(event.type==='response.output_text.delta'&&!firstText){firstText=true;send({type:'model-text'});}
      if(!enabled)return;
      if(event.type==='response.output_item.added'){
        const item=event.item;
        if(started && (item.type==='function_call'||(item.type==='message'&&item.id!==itemId)))invalid();
        if(item?.type==='function_call'||(item?.type==='message'&&item.phase!=='final_answer'))mixed=true;
        if(mixed||item?.type!=='message'||item.role!=='assistant'||item.phase!=='final_answer')return;
        if(started)invalid();
        started=true;itemId=item.id;index=event.output_index;
        send({type:'answer-start'});
      }else if(event.type==='response.output_text.delta'&&started&&event.output_index===index){
        if(event.item_id&&event.item_id!==itemId)invalid();
        if(event.content_index!==undefined&&event.content_index!==0)invalid();
        if(typeof event.delta!=='string')invalid();
        text+=event.delta;if(text.length>16000)invalid();
        send({type:'text',text});
      }else if(event.type==='response.output_item.done'&&started&&event.output_index===index){
        const item=event.item;
        if(item?.id!==itemId||item.phase!=='final_answer'||item.status!=='completed'||
          item.content?.some(c=>c.type!=='output_text')||item.content?.map(c=>c.text).join('')!==text)invalid();
      }
    },
    settle(output) {
      if(ended)return;
      send({type:'model-completed'});
      if(started){
        const messages=output.filter(i=>i.type==='message');
        if(output.some(i=>i.type==='function_call')||messages.length!==1||messages[0].id!==itemId||
          messages[0].phase!=='final_answer'||messages[0].content.some(c=>c.type!=='output_text')||
          messages[0].content.map(c=>c.text).join('')!==text)invalid();
        send({type:'settled',text});
      }
      ended=true;
    },
    abandon,
  };
}
