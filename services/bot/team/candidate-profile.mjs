// Candidate evidence may include files outside the employee worktree. Only the
// host's project-specific profile can name the verifier and its receipt root.
import {accessSync,constants,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {inside} from '../tasks/workspace.mjs';

export const builtinChecks=['build','doctor','coldStart','warmStart','chat','oldDefault','cleanup'];
const commandText=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=16000&&!value.includes('\0');
export const verifierCommand=path=>/^[\w/.-]+$/.test(path)?path:"'"+path.replaceAll("'","'\\''")+"'";

export function loadCandidateProfile(home,projectRoot){
  const path=join(home,'candidate-review.json');
  let config;
  try{
    const stat=lstatSync(path);
    if(!stat.isFile()||stat.size>64*1024)throw Error();
    config=JSON.parse(readFileSync(path,'utf8'));
  }catch(error){throw Error(error.code==='ENOENT'?'candidate_review_not_configured':'invalid_candidate_review_profile');}
  return normalizeCandidateProfile(config,home,projectRoot);
}

export function normalizeCandidateProfile(config,home,projectRoot){
  const {version,kind,source,command,receiptRoot,reproductions=[],regressions}=config??{};
  try{
    if(version!==1||kind!=='text-only-start'||![source,command,receiptRoot].every(p=>typeof p==='string'&&isAbsolute(p)&&!/[\x00-\x1f\x7f]/.test(p)&&p===realpathSync(p)))throw Error();
    if(source!==realpathSync(projectRoot))throw Error('candidate_review_project_mismatch');
    if(inside(source,command)||inside(source,receiptRoot)||inside(receiptRoot,source)||!lstatSync(command).isFile()||!lstatSync(receiptRoot).isDirectory())throw Error();
    const taskRoot=join(realpathSync(home),'tasks');
    if(inside(taskRoot,command)||inside(taskRoot,receiptRoot)||inside(receiptRoot,taskRoot))throw Error();
    accessSync(command,constants.X_OK);
    if(!Array.isArray(regressions)||!regressions.length||regressions.length>16||!Array.isArray(reproductions)||reproductions.length>16)throw Error();
    const checks=new Set(builtinChecks),commands=new Set([command,verifierCommand(command)]);
    for(const row of regressions){
      if(typeof row.check!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(row.check)||checks.has(row.check)||!commandText(row.command)||commands.has(row.command))throw Error();
      checks.add(row.check);commands.add(row.command);
    }
    for(const row of reproductions){
      if(!checks.has(row.check)||!commandText(row.command)||commands.has(row.command)||!Number.isInteger(row.exitCode)||row.exitCode<1||row.exitCode>255||
        typeof row.outputIncludes!=='string'||!row.outputIncludes.trim()||row.outputIncludes.length>1024)throw Error();
      commands.add(row.command);
    }
    return {version,kind,source,command,receiptRoot,regressions:regressions.map(({command,check})=>({command,check})),
      reproductions:reproductions.map(({command,check,exitCode,outputIncludes})=>({command,check,exitCode,outputIncludes}))};
  }catch(error){throw Error(error.message==='candidate_review_project_mismatch'?error.message:'invalid_candidate_review_profile');}
}
