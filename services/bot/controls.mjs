/** One command path for voice, terminal and browser clients. */
import {createHash} from 'node:crypto';

function approvalPreview(record) {
  if(record.kind==='tool'||record.operation!=='file')return record;
  // Earlier proposals stored a full minus/plus diff; recover the immutable old
  // content from it, never from the possibly changed live file.
  const lines=(record.diff||'').split('\n').slice(2),before=[];
  for(const line of lines){if(!line.startsWith('-'))break;before.push(line.slice(1));}
  const text=before.join('\n');
  const valid=record.beforeHash===null||createHash('sha256').update(text).digest('hex')===record.beforeHash;
  return {...record,beforeContent:record.beforeHash===null?null:valid?text:null,previewValid:valid};
}

const operationRecords=ops=>[...ops.list('approval'),...ops.list('tool')].sort((a,b)=>b.createdAt-a.createdAt);

export function createControls({ops,requests,memory,health,memoryView,shutdown,context,documents}) {
  return async(path,body)=>{
    if(path==='/health')return health();
    if(path==='/snapshot'){
      const limit=Number.isInteger(body.limit)?Math.max(20,Math.min(500,body.limit)):50;
      const records=ops.list('request'),approvals=operationRecords(ops);
      return {workContext:context?.capture()??{kind:'none'},health:health(),busy:!!(requests.active||requests.mutation),activeId:requests.active?.id??null,
        messages:records.slice(0,limit).reverse(),hasMore:records.length>limit,
        approvals:approvals.filter((r,i)=>i<30||['pending','applying','running'].includes(r.status)).map(approvalPreview)};
    }
    if(path==='/document-open'){
      if(!documents)throw Error('documents_not_enabled');
      if(typeof body.id!=='string'||typeof body.fileId!=='string'||Object.keys(body).some(k=>!['id','fileId'].includes(k)))throw Error('invalid_document_request');
      return requests.exclusive(()=>{const file=documents.file(body.fileId);return documents.open({id:body.id,path:file.path,applicationId:file.applicationId});});
    }
    if(path==='/ask')return requests.submit(body.id,body.text,body.source||'text');
    if(path==='/result')return ops.request(body.id);
    if(path==='/cancel')return requests.cancel(body.id);
    if(path==='/approvals')return ops.list('approval');
    if(path==='/operations')return operationRecords(ops);
    if(path==='/approve')return requests.exclusive(()=>ops.get(body.id).operation==='file'?ops.approveFile(body.id):memory.approve(body.id));
    if(path==='/reject')return requests.exclusive(()=>ops.reject(body.id));
    if(path==='/tasks')return ops.list('task').map(r=>ops.task(r.id));
    if(path==='/task')return ops.task(body.id);
    if(path==='/cancel-task')return ops.cancelTask(body.id);
    if(path==='/memory')return memoryView();
    if(path==='/shutdown')return shutdown();
    throw Error('unknown_route');
  };
}
