/** Version-pinned handoff inputs. Never overwrite an active task's copies. */
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,lstatSync,realpathSync,writeFileSync,existsSync} from 'node:fs';
import {join,dirname,resolve,relative,isAbsolute} from 'node:path';
import {readJson,saveJson} from './agent-files.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function stageTaskInputs({workspace,inputs=[]}){
  if(!inputs.length)return;
  const root=realpathSync(workspace.path),home=dirname(root),ledgerPath=join(home,'transfer-inputs.json');
  const ledger=readJson(ledgerPath,{});
  for(const item of inputs){
    const key=item.reportId+':'+item.artifactId;
    if(ledger[key])continue;
    const target=resolve(root,item.name),rel=relative(root,target);
    if(!rel||rel.startsWith('../')||rel==='..'||isAbsolute(rel)||rel.split('/').some(p=>p.startsWith('.')))throw Error('invalid_transfer_input');
    const stat=lstatSync(item.path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>20*1024*1024)throw Error('task_dependency_artifact_changed');
    const data=readFileSync(item.path);if(hash(data)!==item.sha256)throw Error('task_dependency_artifact_changed');
    // Ensure no path component was replaced by a link before staging.
    let parent=root;
    for(const segment of rel.split('/').slice(0,-1)){parent=join(parent,segment);if(existsSync(parent)){const st=lstatSync(parent);if(!st.isDirectory()||st.isSymbolicLink())throw Error('invalid_transfer_input');}else mkdirSync(parent,{mode:0o700});}
    if(existsSync(target)){if(lstatSync(target).isSymbolicLink()||hash(readFileSync(target))!==item.sha256)throw Error('task_dependency_input_conflict');}
    else writeFileSync(target,data,{mode:0o600,flag:'wx'});
    // Treat untouched transferred files as inputs rather than newly delivered outputs.
    workspace.inputFiles=[...new Set([...(workspace.inputFiles??[]),item.name])];
    workspace.inputBaseline={...workspace.inputBaseline,[item.name]:{size:data.length,sha256:item.sha256}};
    saveJson(join(home,'workspace.json'),workspace);
    ledger[key]={name:item.name,sha256:item.sha256,reportId:item.reportId};saveJson(ledgerPath,ledger);
  }
  saveJson(join(home,'workspace.json'),workspace);
}
