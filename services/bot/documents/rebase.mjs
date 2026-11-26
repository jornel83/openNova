/** Rebuild a proposal from the actual saved edition, or retain it for manual review. */
import {execFile} from 'node:child_process';
import {promisify,isDeepStrictEqual as equal} from 'node:util';
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {documentCapabilities} from './runner.mjs';
import {normalizeDocumentSpec,MAX_SPEC_BYTES} from './spec.mjs';

const execute=promisify(execFile);
const unavailable=reason=>Object.assign(Error('document_rebase_unavailable'),{details:{reason}});
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);

// Three-way replay. Only fields whose original and proposed values differ are
// taken from Nova; an unchanged subtree comes verbatim from the new baseline.
function merge(old,live,next){
  if(equal(old,next))return live;
  if(equal(old,live)||equal(next,live))return next;
  if(Array.isArray(old)&&Array.isArray(live)&&Array.isArray(next)){
    if(old.length!==live.length)throw unavailable('document_structure_changed');
    if(old.length===next.length)return old.map((value,i)=>merge(value,live[i],next[i]));
    // Align the unchanged prefix and suffix across a Nova insertion or deletion.
    let start=0,end=0;
    while(start<Math.min(old.length,next.length)&&equal(old[start],next[start]))start++;
    while(end<Math.min(old.length,next.length)-start&&equal(old[old.length-1-end],next[next.length-1-end]))end++;
    if(!equal(old.slice(start,old.length-end),live.slice(start,live.length-end)))throw unavailable('document_structure_changed');
    return [...live.slice(0,start),...next.slice(start,next.length-end),...live.slice(live.length-end)];
  }
  if(object(old)&&object(live)&&object(next)){
    if(old.type!==next.type)throw unavailable('document_structure_changed');
    const result={};
    // User-sorted inventory rows still refer to their original identifiers.
    // If a target identity disappeared, asking for a new target is safer than
    // applying an old cell edit to whoever now occupies its previous row.
    let alignedRows;
    if(old.type==='table'&&!equal(old.rows,next.rows)){
      const index=old.columns.findIndex(s=>/^(编号|序号|id)$/i.test(s));
      if(index>=0){
        const ids=rows=>rows.map(r=>r[index]),oldIds=ids(old.rows),liveIds=ids(live.rows);
        if(!equal(oldIds,liveIds)){
          if(!equal(oldIds,ids(next.rows))||oldIds.some(id=>!id)||new Set(oldIds).size!==oldIds.length||
            new Set(liveIds).size!==liveIds.length||liveIds.length!==oldIds.length)throw unavailable('document_structure_changed');
          const byId=new Map(oldIds.map((id,i)=>[id,i]));
          alignedRows=live.rows.map((row,i)=>{
            const source=byId.get(liveIds[i]);
            if(source===undefined)throw unavailable('document_structure_changed');
            return merge(old.rows[source],row,next.rows[source]);
          });
        }
      }
    }
    for(const key of new Set([...Object.keys(old),...Object.keys(live),...Object.keys(next)])){
      const value=key==='rows'&&alignedRows?alignedRows:merge(old[key],live[key],next[key]);
      if(value!==undefined)result[key]=value;
    }
    return result;
  }
  // The new comparison explicitly shows the user's current scalar value
  // against Nova's proposed replacement. It still needs a fresh confirmation.
  if(!object(old)&&!Array.isArray(old)&&!object(next)&&!Array.isArray(next))return next;
  throw unavailable('document_structure_changed');
}

function integerSum(rows,col){
  let sum=0;
  for(const row of rows){
    if(!/^-?(?:0|[1-9]\d{0,14})$/.test(row[col]))return null;
    sum+=Number(row[col]);if(!Number.isSafeInteger(sum))return null;
  }
  return String(sum);
}

function recalculateTotals(old,next,merged){
  if(old.blocks.length!==next.blocks.length)return;
  for(let i=0;i<merged.blocks.length;i++){
    const a=old.blocks[i],b=next.blocks[i],result=merged.blocks[i];
    if(a.type!=='table'||b.type!=='table'||result.type!=='table'||!a.summary||!b.summary||!result.summary||
        !a.summary.some(s=>/^(合计|总计|total)$/i.test(s))||!equal(a.columns,b.columns))continue;
    for(let c=0;c<a.columns.length;c++){
      if(a.summary[c]===b.summary[c]||a.summary[c]!==integerSum(a.rows,c)||b.summary[c]!==integerSum(b.rows,c))continue;
      const total=integerSum(result.rows,c);
      if(total===null)throw unavailable('document_total_unverified');
      result.summary[c]=total;
    }
  }
}

async function readPDF({spec,originalPath,latestPath,scratch,command,script,call}){
  const specPath=join(scratch,'input.json'),mapPath=join(scratch,'regions.json');
  const generated=join(scratch,'reference.pdf'),recovered=join(scratch,'recovered.pdf');
  const reader=join(dirname(script),'rebase_pdf.swift');
  await call(command,[script,'--spec',specPath,'--output',generated,'--regions',mapPath]);
  await call(command,[reader,'verify',generated,originalPath]);
  const positions=JSON.parse(await readFile(mapPath,'utf8'));
  const values=JSON.parse(await call(command,[reader,'regions',originalPath,latestPath,mapPath]));
  const updated=structuredClone(spec);
  let paragraph=0,line=0,cell=0;
  const readText=(text,listPrefix='')=>{
    const count=positions.lineCounts[paragraph++];
    if(!Number.isSafeInteger(count))throw unavailable('pdf_position_unverified');
    const slice=values.lines.slice(line,line+count);line+=count;
    if(slice.every(([a,b])=>a===b))return text;
    // Multiple wrapped lines can lose spaces/newlines in the PDF text layer.
    // A changed value is only inferred when the original line is unambiguous.
    if(slice.length!==1||slice[0][0]!==listPrefix+text||!slice[0][1].startsWith(listPrefix))throw unavailable('pdf_position_unverified');
    return slice[0][1].slice(listPrefix.length);
  };
  updated.title=readText(spec.title);
  if(spec.subtitle)updated.subtitle=readText(spec.subtitle);
  for(const block of updated.blocks){
    if(block.type==='list'){
      block.items=block.items.map((s,i)=>readText(s,block.ordered?(i+1)+'. ':'• '));
    }else if(block.type==='table'){
      for(const row of [...block.rows,...(block.summary?[block.summary]:[])]){
        for(let i=0;i<row.length;i++){
          const [before,after]=values.cells[cell++];
          if(before===after)continue;
          if(before!==row[i]||after.includes('\n'))throw unavailable('pdf_position_unverified');
          row[i]=after;
        }
      }
    }else block.text=readText(block.text);
  }
  if(line!==values.lines.length||cell!==values.cells.length)throw unavailable('pdf_position_unverified');
  await writeFile(specPath,JSON.stringify(updated));
  await call(command,[script,'--spec',specPath,'--output',recovered]);
  await call(command,[reader,'verify',recovered,latestPath]);
  return updated;
}

export async function rebaseDocumentCandidate({baseSpec,candidateSpec,basePrintableSpec,format,originalPath,latestPath,signal}){
  if(!['pdf','docx'].includes(format)||baseSpec.claims?.length&&!basePrintableSpec)throw unavailable('document_baseline_unverified');
  const printable=basePrintableSpec??baseSpec,cap=documentCapabilities()[format];
  if(!cap.available)throw unavailable('document_runtime_unavailable');
  const scratch=await mkdtemp(join(format==='pdf'?'/private/tmp':tmpdir(),'opennova-rebase-'));
  try{
    signal?.throwIfAborted();
    const call=async(binary,args)=>{
      const result=await execute(binary,args,{cwd:scratch,signal,timeout:90000,maxBuffer:4*MAX_SPEC_BYTES,
        env:{PATH:'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8',HOME:process.env.HOME,
          TMPDIR:scratch,PYTHONDONTWRITEBYTECODE:'1'}});
      return result.stdout;
    };
    const specPath=join(scratch,'input.json');
    await writeFile(specPath,JSON.stringify(printable),{mode:0o600});
    const recovered=format==='docx'
      ?JSON.parse(await call(cap.command,['-I','-B',join(dirname(cap.script),'rebase_docx.py'),specPath,originalPath,latestPath]))
      :await readPDF({spec:printable,originalPath,latestPath,scratch,command:cap.command,script:cap.script,call});
    if(!equal(recovered.blocks.slice(baseSpec.blocks.length),printable.blocks.slice(baseSpec.blocks.length)))throw unavailable('document_evidence_changed');
    const latest=normalizeDocumentSpec({...baseSpec,title:recovered.title,...(recovered.subtitle===undefined?{}:{subtitle:recovered.subtitle}),
      layout:recovered.layout,blocks:recovered.blocks.slice(0,baseSpec.blocks.length)});
    const proposal=structuredClone(merge(baseSpec,latest,candidateSpec));
    recalculateTotals(baseSpec,candidateSpec,proposal);
    return {baseSpec:latest,spec:normalizeDocumentSpec(proposal)};
  }catch(error){
    if(signal?.aborted)throw Error('cancelled');
    if(error.message==='document_rebase_unavailable')throw error;
    throw unavailable(format==='docx'?'word_content_or_format_unverified':'pdf_content_or_layout_unverified');
  }finally{await rm(scratch,{recursive:true,force:true});}
}
