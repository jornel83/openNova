// Installed only in candidate probes. Record actual attempts at known device or
// SSH entry points and simulate unavailable hardware before touching the machine.
const cp=require('node:child_process');
const {syncBuiltinESMExports}=require('node:module');
const {appendFileSync}=require('node:fs');
const {basename}=require('node:path');

function inspect(method,file,argv){
  const entry=basename(String(file));
  const blocked=new Set(['run-continuous.command','ssh','afplay','arecord','aplay','rec','play','sox','SwitchAudioSource']);
  let target=blocked.has(entry)?entry:undefined;
  if(!target&&Array.isArray(argv)){
    const indirect=argv.find(arg=>typeof arg==='string'&&/^(?:[^\s]*\/)?run-continuous\.command$/.test(arg));
    if(indirect)target='run-continuous.command';
  }
  if(!target)return;
  appendFileSync(process.env.OPENNOVA_PROBE_CALLS,JSON.stringify({method,entry:target,injectedExitCode:72})+'\n',{mode:0o600});
  process.exit(72);
}
const launch=cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn=function(options){
  inspect('spawn',options.file,options.args);
  if(process.env.OPENNOVA_PROBE_CONTAIN_CHILDREN==='1'){
    // Keep descendants inside their stage's owned process group. Launchers can
    // still unref a child and quit independently during the standby handoff.
    options.detached=false;
    if(Array.isArray(options.envPairs)){
      // macOS Security locates the login Keychain through the account's HOME.
      // Only the designated executable gets it; the candidate, its model
      // process, and unrelated commands retain their private scratch HOME.
      const accountHome=process.env.OPENNOVA_PROBE_ACCOUNT_HOME;
      if(accountHome&&options.file===process.env.OPENNOVA_PROBE_ACCOUNT_HELPER){
        options.envPairs=options.envPairs.filter(pair=>!pair.startsWith('HOME='));
        options.envPairs.push('HOME='+accountHome);
      }
      const key='NODE_OPTIONS=',index=options.envPairs.findIndex(pair=>pair.startsWith(key));
      const existing=index<0?'':options.envPairs[index].slice(key.length);
      if(!existing.includes(__filename)){
        const preload=key+(existing?existing+' ':'')+'--require='+JSON.stringify(__filename);
        if(index<0)options.envPairs.push(preload);else options.envPairs[index]=preload;
      }
    }
  }
  return launch.call(this,options);
};
for(const method of ['execFileSync','spawnSync']){
  const original=cp[method];
  cp[method]=function(file,argv,...rest){inspect(method,file,argv);return original.call(this,file,argv,...rest);};
}
syncBuiltinESMExports();
