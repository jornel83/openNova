// The host pins the verifier outside the editable project. A task retains the
// executable it was assigned even if the host package changes before its run.
import {createHash} from 'node:crypto';
import {linkSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {loadSettings} from '../../services/agent/settings.mjs';
import {ROOT} from '../../services/runtime/sources.mjs';
import {inside} from '../../services/bot/tasks/workspace.mjs';
import {loadCandidateProfile,normalizeCandidateProfile,verifierCommand} from '../../services/bot/team/candidate-profile.mjs';

const defaults=[{check:'startupRegression',command:'node --test scripts/tests/project.test.mjs tools/voice/tests/launcher.test.mjs services/bot/tests/start-options.test.mjs'}];

function privateDirectory(path){
  mkdirSync(path,{recursive:true,mode:0o700});
  if(realpathSync(path)!==path||!lstatSync(path).isDirectory())throw Error('candidate_install_path_invalid');
}

function installBundle(parent,settings){
  const files=new Map();
  const names=['verify.mjs','workspace.mjs','process.mjs','text-start.mjs','stage-runner.mjs','no-audio.cjs'];
  for(const name of [...names.map(n=>'scripts/candidate/'+n),'services/bot/team/candidate-patch.mjs']){
    files.set(name,readFileSync(join(ROOT,name)));
  }
  files.set('settings.json',Buffer.from(JSON.stringify(settings)));
  // Use the host's actual Node, including when the employee's shell uses another version.
  files.set('verify',Buffer.from('#!/bin/sh\nexec '+verifierCommand(process.execPath)+' "${0%/*}/scripts/candidate/verify.mjs" "$@"\n'));
  const hash=createHash('sha256');
  for(const [name,bytes] of files)hash.update(name+'\0'+bytes.length+'\0').update(bytes);
  const target=join(parent,hash.digest('hex'));
  function verify(){
    if(realpathSync(target)!==target)throw Error('candidate_tool_changed');
    for(const [name,bytes] of files){
      const path=join(target,name);
      if(realpathSync(path)!==path||!lstatSync(path).isFile()||!readFileSync(path).equals(bytes))throw Error('candidate_tool_changed');
    }
    return join(target,'verify');
  }
  try{return verify();}catch(error){if(error.code!=='ENOENT')throw error;}
  const staging=mkdtempSync(join(parent,'.install-'));
  try{
    for(const [name,bytes] of files){
      const file=join(staging,name);mkdirSync(dirname(file),{recursive:true,mode:0o700});
      writeFileSync(file,bytes,{mode:name==='verify'?0o500:0o400,flag:'wx'});
    }
    try{renameSync(staging,target);}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;}
    return verify();
  }finally{rmSync(staging,{recursive:true,force:true});}
}

export function provisionCandidateVerifier({home,source,dependencyRoot=ROOT,regressions=defaults,reproductions=[],register=true}){
  if(process.versions.node.split('.')[0]!=='24')throw Error('candidate_verifier_requires_node_24');
  source=realpathSync(source);dependencyRoot=realpathSync(dependencyRoot);
  home=resolve(home);
  // Verify the intended directory before creating anything below an editable source.
  let parent=home;
  for(;;){try{realpathSync(parent);break;}catch(error){if(error.code!=='ENOENT')throw error;parent=dirname(parent);}}
  home=join(realpathSync(parent),home.slice(parent.length));
  if(inside(source,home)||inside(dependencyRoot,home))throw Error('candidate_home_must_be_outside_source');
  privateDirectory(home);
  const receiptRoot=join(home,'candidate-receipts'),tools=join(home,'candidate-tools');
  privateDirectory(receiptRoot);privateDirectory(tools);
  const accountStorage=loadSettings().storageDir;
  const command=installBundle(tools,{home,source,dependencyRoot,receiptRoot,accountStorage});
  const profile=normalizeCandidateProfile({version:1,kind:'text-only-start',source,command,receiptRoot,regressions,reproductions},home,source);
  if(register){
    // Publish a complete profile once. Concurrent installers and previous custom profiles keep their bindings.
    const dir=mkdtempSync(join(home,'.candidate-profile-')),staged=join(dir,'profile.json');
    try{
      writeFileSync(staged,JSON.stringify(profile,null,2)+'\n',{mode:0o600,flag:'wx'});
      try{linkSync(staged,join(home,'candidate-review.json'));}catch(error){if(error.code!=='EEXIST')throw error;}
      if(JSON.stringify(loadCandidateProfile(home,source))!==JSON.stringify(profile))throw Error('candidate_profile_already_configured');
    }finally{rmSync(dir,{recursive:true,force:true});}
  }
  return profile;
}

// A private host profile takes precedence. Only the running OpenNova project's
// own path is eligible for built-in provisioning without explicit registration.
export function taskCandidateProfile(home,source){
  try{return loadCandidateProfile(home,source);}
  catch(error){
    if(error.message!=='candidate_review_not_configured'||realpathSync(source)!==realpathSync(ROOT))throw error;
    return provisionCandidateVerifier({home,source,register:false});
  }
}

if(process.argv[1]===import.meta.filename){
  try{
    const {values}=parseArgs({options:{home:{type:'string'},source:{type:'string'},dependencies:{type:'string'}}});
    if(!values.home)throw Error('Usage: node scripts/candidate/install.mjs --home <test-bot-home> [--source <project>] [--dependencies <installed-opennova>]');
    const {command,receiptRoot}=provisionCandidateVerifier({home:values.home,source:values.source??ROOT,dependencyRoot:values.dependencies??ROOT});
    console.log(JSON.stringify({command,receiptRoot},null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
