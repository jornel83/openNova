#!/usr/bin/env node
import {spawn,spawnSync} from 'node:child_process';
import {join,dirname} from 'node:path';
import {globSync} from 'node:fs';
import {ROOT,checkEngineSources,runtimeSources} from '../services/runtime/sources.mjs';
import {recordBuild,checkBuild,sourceDigest} from './build-record.mjs';
import {acquireBuild,buildGroupAlive} from './team-soak-lock.mjs';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const HELP=`OpenNova (Node 24, pnpm 11.28.5)
  pnpm run setup                 Install locked dependencies, no account required
  pnpm run setup -- --chatgpt     Also prepare the optional Keychain helper (macOS)
  pnpm run build                 Build included Harness, Bot, SIWC and OpenNova web
  pnpm test                      Offline product regression tests
  pnpm run test:bot               Included upstream Bot tests
  pnpm start                     Start the shared Bot and web interface
  pnpm run start:voice -- [args]  Start shared Bot voice on macOS
  pnpm run doctor                Inspect sources and build, no login or model request
Configure your own model authorization before starting the assistant.
`;

export function commandPlan(command,args=[],root=ROOT) {
  const sources=runtimeSources(root),harness=sources.harnessRoot,bot=sources.botRoot,siwc=sources.siwcRoot;
  const clean=args.filter(a=>a!=='--');
  if(!['setup','build','test:bot','start','start:voice'].includes(command))throw Error('unknown_command: '+command);
  if((command==='setup'&&clean.some(a=>a!=='--chatgpt'))||(['build','test:bot'].includes(command)&&clean.length))throw Error('unknown_option');
  const step=(command,args,cwd=root,env={})=>({command,args,cwd,env:{CI:'true',...env}});
  if(command==='setup')return [step('pnpm',['install','--frozen-lockfile']),step('pnpm',['install','--frozen-lockfile'],harness),
    step('npm',['ci','--no-audit','--no-fund'],bot),step('npm',['ci','--no-audit','--no-fund'],join(root,'services/bot/desktop')),step('npm',['ci','--ignore-scripts','--no-audit','--no-fund','--workspace','@siwc/local','--include-workspace-root'],siwc),
    ...(clean.includes('--chatgpt')?[step(process.env.OPENNOVA_PYTHON||'python3.11',[join(root,'tools/setup/bootstrap.py'),'--install','--web'])]:[])];
  if(command==='build')return [step('pnpm',['run','build'],harness),step('npm',['run','build'],bot),step('npm',['run','build','-w','@siwc/local'],siwc),step(process.execPath,[join(root,'services/bot/web/build.mjs')]),
    ...(process.platform==='darwin'?[step(process.env.OPENNOVA_PYTHON||'python3.11',[join(root,'tools/setup/bootstrap.py'),'--install'])]:[])];
  if(command==='test:bot')return [step(process.execPath,['--import',join(root,'services/bot/resolve.mjs'),'--test',...[...globSync('test/*.test.js',{cwd:bot})].sort()],bot,
    {DSH_HARNESS:harness,OPENNOVA_HARNESS_ROOT:harness,OPENNOVA_BOT_PLUGIN:bot})];
  if(command==='start')return [step(process.execPath,[join(root,'services/bot/launch.mjs'),...clean])];
  return [step(process.execPath,[join(root,'tools/voice/start.mjs'),...clean])];
}

export function requiresBuild(command,options) {
  if(options.some(option=>['--help','-h'].includes(option)))return false;
  if(command==='start')return !options.some(option=>['--check','--stop'].includes(option));
  return command==='start:voice'&&!options.includes('--list-devices');
}

export function doctor(root=ROOT) {
  const sources=checkEngineSources(root);
  return {sources:true,node:process.versions.node,requiredNodeMajor:24,
    engines:{harness:sources.harnessRoot,bot:sources.botRoot,siwc:sources.siwcRoot},build:checkBuild(root)};
}

function sourceIdentity(root) {
  const git=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']});
  return git.status===0?git.stdout.trim():sourceDigest(root).slice(0,40);
}

export async function executeSteps(steps,{root=ROOT,processGroups=false,beforeSpawn=()=>{},onChild=()=>{},onChildExit=()=>{}}={}) {
  for(const step of steps) {
    const env={...process.env,...step.env,OPENNOVA_NODE:process.execPath,PATH:dirname(process.execPath)+(process.platform==='win32'?';':':')+(process.env.PATH||'')};
    if(step.command==='pnpm'&&step.args.includes('build'))env.DSH_CLIENT_COMMIT_HASH=sourceIdentity(root);
    let command=step.command,args=step.args;
    if(command==='pnpm'&&process.env.npm_execpath?.includes('pnpm')){command=process.execPath;args=[process.env.npm_execpath,...args];}
    console.log(`OpenNova: ${step.command} ${step.args.join(' ')} (${step.cwd})`);
    beforeSpawn();
    await new Promise((resolve,reject)=>{
      const child=spawn(command,args,{cwd:step.cwd,env,stdio:'inherit',detached:processGroups&&process.platform!=='win32'});
      let stopped=false,escalation;
      const signal=value=>{stopped=true;try{processGroups&&process.platform!=='win32'&&child.pid?process.kill(-child.pid,value):child.kill(value);}catch(error){if(error.code!=='ESRCH')reject(error);}
        if(processGroups&&!escalation)escalation=setTimeout(()=>{try{child.pid&&process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')reject(error);}},3000);
      };
      const interrupt=()=>signal('SIGINT'),terminate=()=>signal('SIGTERM');
      process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
      const cleanup=()=>{clearTimeout(escalation);process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);};
      child.once('error',error=>{cleanup();reject(error);});
      child.once('exit',async(code,signal)=>{cleanup();try{await onChildExit(child);}catch(error){reject(error);return;}code===0&&!stopped?resolve():reject(Error(`${step.command} failed (${signal||stopped&&'interrupted'||code})`));});
      try{onChild(child);}catch(error){signal('SIGTERM');reject(error);}
    });
  }
}

export async function executeBuild(steps,{root=ROOT,record=()=>recordBuild(root)}={}){
  const owner={runId:randomUUID(),pid:process.pid,startedAt:Date.now()},unlock=acquireBuild(root,owner),children=[];
  let error,complete=false;
  async function cleanGroups(){
    for(const child of children)if(!child.cleanupConfirmed){
      // The direct child may exit just before its process group disappears.
      // Give normal teardown a brief grace period before attempting termination.
      for(let i=0;i<4&&buildGroupAlive(child.pid);i++)await delay(50);
      if(buildGroupAlive(child.pid)){
        try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGTERM');}catch(value){if(!['ESRCH','EPERM'].includes(value.code))throw value;}
        for(let i=0;i<30&&buildGroupAlive(child.pid);i++)await delay(100);
        if(buildGroupAlive(child.pid))throw Error('build_cleanup_unconfirmed: inspect output/team-soak.lock before recovery');
      }
      child.cleanupConfirmed=true;
    }
  }
  try{
    await executeSteps(steps,{root,processGroups:true,beforeSpawn:()=>unlock.update({spawning:true}),onChild:child=>{
      if(child.pid)children.push({pid:child.pid});unlock.update({children,spawning:false});
    },onChildExit:async child=>{
      const entry=children.find(item=>item.pid===child.pid);if(entry&&!buildGroupAlive(child.pid))entry.cleanupConfirmed=true;unlock.update({children});
      await cleanGroups();unlock.update({children});
    }});
    await cleanGroups();
    await record();complete=true;
  }catch(value){error=value;}
  finally{
    try{
      await cleanGroups();
      unlock.update({children,spawning:false,finishedAt:Date.now(),cleanupConfirmed:true,status:complete?'completed':'failed'});unlock();
    }catch(value){error??=value;try{unlock.update({finishedAt:Date.now(),cleanupConfirmed:false,status:'cleanup_unconfirmed'});}catch{}}
  }
  if(error)throw error;
}

export async function main(args=process.argv.slice(2)) {
  const [command,...options]=args;
  if(!command||['help','--help','-h'].includes(command)){console.log(HELP);return;}
  if(Number(process.versions.node.split('.')[0])!==24)throw Error('OpenNova requires Node 24');
  if(command==='doctor'){
    if(options.length)throw Error('unknown_option');
    const info=doctor();console.log(JSON.stringify(info,null,2));
    if(!info.build.ready){console.log('Run pnpm run setup, then pnpm run build.');process.exitCode=1;}
    return;
  }
  const steps=commandPlan(command,options);checkEngineSources();
  if(requiresBuild(command,options)&&!checkBuild().ready)throw Error('build_missing_or_stale: run pnpm run build');
  if(command==='build'){await executeBuild(steps);console.log('OpenNova build ready.');}
  else await executeSteps(steps);
}
if(process.argv[1]===import.meta.filename)main().catch(error=>{console.error(error.message);process.exitCode=1;});
