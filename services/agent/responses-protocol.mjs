/** Stateless Responses projection. Only completed output is executable by Harness. */
const FORMAT='opennova-responses-v1';
const DEFAULT_TOOLS=['web_search','web_fetch'];
const textOf=content => {
  if (!Array.isArray(content) || content.some(b=>b.type!=='text')) throw Error('unsupported_content');
  return content.map(b=>b.text).join('');
};
function call(item, allowed) {
  if (!item.call_id || typeof item.call_id!=='string' || !allowed.has(item.name) ||
      (item.namespace && item.namespace!=='opennova') || typeof item.arguments!=='string') throw Error('invalid_tool_call');
  let args;try {args=JSON.parse(item.arguments);} catch {throw Error('invalid_tool_arguments');}
  if (!args || Array.isArray(args) || typeof args!=='object') throw Error('invalid_tool_arguments');
  return {type:'tool-call',id:item.call_id,name:item.name,arguments:item.arguments};
}
export function projectToolRequest(options, allowedTools=DEFAULT_TOOLS) {
  if (options.model!=='gpt-6.1-sol') throw Error('unsupported_model');
  const allowed=new Set(allowedTools);
  const tools=(options.tools??[]).map(t=>{
    if (!allowed.has(t.name) || t.deferLoading) throw Error('unsupported_tools');
    return {type:'function',name:t.name,description:t.description,parameters:t.parameters,strict:false};
  });
  const input=[];
  for (const m of options.messages) {
    if (m.role==='tool') {
      if (!m.toolCallId) throw Error('invalid_tool_result');
      input.push({type:'function_call_output',call_id:m.toolCallId,output:textOf(m.content)});
    } else if (m.role==='assistant') {
      const replay=m.source?.replayState;
      if (replay?.response?.format===FORMAT) {
        if (replay.blocks?.length!==m.content.length) throw Error('invalid_replay');
        for (const b of replay.blocks) {
          if (!Array.isArray(b?.items)) throw Error('invalid_replay');
          input.push(...b.items);
        }
      } else {
        for (const b of m.content) {
          if (b.type==='text') input.push({role:'assistant',content:b.text});
          else if (b.type==='tool-call') {
            const item={type:'function_call',call_id:b.id,name:b.name,namespace:'opennova',arguments:b.arguments};
            call(item,allowed);input.push(item);
          } else throw Error('unsupported_content');
        }
      }
    } else if (['system','developer','user'].includes(m.role)) {
      input.push({role:m.role==='system'?'developer':m.role,content:textOf(m.content)});
    } else throw Error('unsupported_role');
  }
  return {model:options.model,input,...(options.system?{instructions:options.system}:{}),
    ...(tools.length?{tools:[{type:'namespace',name:'opennova',description:'OpenNova tools',tools}]}:{})};
}
export async function* responseToolChunks(client, options, allowedTools=DEFAULT_TOOLS) {
  const request=projectToolRequest(options,allowedTools);
  const result=await client.streamItems({...request,signal:options.signal});
  options.signal?.throwIfAborted();
  if (!Array.isArray(result?.output)) throw Error('incomplete_model_response');
  const allowed=new Set((options.tools??[]).map(t=>t.name));
  const blocks=[], replay=[], ids=new Set();let pending=[], characters=0;
  for (const item of result.output) {
    if (item.type==='reasoning') {pending.push(item);continue;}
    let block;
    if (item.type==='function_call') {
      block=call(item,allowed);
      if (ids.has(block.id)) throw Error('duplicate_tool_call');
      ids.add(block.id);
    } else if (item.type==='message' && item.role==='assistant' && item.status==='completed') {
      if (item.content.some(c=>!['output_text','refusal'].includes(c.type))) throw Error('unsupported_model_content');
      const text=item.content.map(c=>c.text??c.refusal).join('');
      characters+=text.length;if(characters>16000)throw Error('response_too_large');
      block={type:'text',text};
    } else throw Error('unsupported_model_output');
    blocks.push(block);replay.push({items:[...pending,item]});pending=[];
  }
  if (!blocks.length) throw Error('incomplete_model_response');
  if (pending.length) replay.at(-1).items.push(...pending);
  for (const [index,block] of blocks.entries()) {
    yield {type:'block-start',index,blockType:block.type};
    if(block.type==='text')yield {type:'text-delta',index,text:block.text};
    else yield {type:'tool-call-delta',index,id:block.id,name:block.name,argumentsDelta:block.arguments};
    yield {type:'block-end',index,block};
  }
  yield {type:'finish',reason:{kind:ids.size?'tool-calls':'stop'},replayState:{response:{format:FORMAT},blocks:replay}};
}
