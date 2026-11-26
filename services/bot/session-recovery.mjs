import {lstat,readdir,stat} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';

// Compatibility with the JSONL directory layout shipped in macOS builds 1–2.
// This only locates evidence; session creation and durability belong to Harness.
function encodeSegment(value) {
  if(value==='.'||value==='..')return value.replaceAll('.','~002E');
  return value.split('').map(ch=>/^[A-Za-z0-9._-]$/.test(ch)?ch:'~'+ch.charCodeAt(0).toString(16).toUpperCase().padStart(4,'0')).join('');
}
function sessionDirectory(root,cwd,id) {
  const slug=encodeSegment(cwd.replace(/[/\\:]+/g,'-')).replace(/^-+/,'')||'root';
  return join(root,`--${slug.slice(0,251)}--`,encodeSegment(id));
}

/** Collect saved identities without changing the Bot or its project projections. */
function savedSessions(state,workspace) {
  const found=new Map();
  const add=(id,cwd)=>{
    if(typeof id!=='string'||!id||typeof cwd!=='string'||!isAbsolute(cwd))return;
    if(found.has(id)&&found.get(id)!==cwd)found.set(id,null);else if(!found.has(id))found.set(id,cwd);
  };
  const scope=value=>{
    if(!value)return;
    add(value.sessionId,value.cwd);
    for(const part of value.segments??[])add(part.sessionId,part.cwd??value.cwd);
  };
  for(const bot of Object.values(state.bots??{})) {
    const projects=state.opennovaProjectSessions?.[bot.id];
    scope(projects?.legacy);
    for(const value of Object.values(projects?.scopes??{}))scope(value);
    const cwd=bot.workDir??workspace;
    add(bot.sessionId??bot.id,cwd);
    for(const part of bot.segments??[])add(part.sessionId,part.cwd??cwd);
    // bot.id is the native first-part identity, not necessarily the active chat.
    // Recover it only from its saved legacy/segment cwd; never guess the new cwd.
  }
  return [...found].filter(([,cwd])=>cwd!==null).map(([sessionId,cwd])=>({sessionId,cwd}));
}

async function lockOnly(directory) {
  try {
    if(!(await lstat(directory)).isDirectory()||!(await lstat(resolve(directory,'..'))).isDirectory())return false;
    const entries=await readdir(directory);
    if(entries.length!==1||entries[0]!=='session.lock')return false;
    const lock=await lstat(join(directory,'session.lock'));
    return lock.isFile()&&lock.size===0&&lock.nlink===1;
  } catch(error) {
    // Archived/moved/inaccessible historical projects must not become new startup
    // prerequisites. Their ordinary resolution path retains the original error.
    if(['ENOENT','ENOTDIR','EACCES','EPERM'].includes(error.code))return false;
    throw error;
  }
}

async function existingFolder(cwd) {
  try{return (await stat(cwd)).isDirectory();}
  catch(error){if(['ENOENT','ENOTDIR','EACCES','EPERM'].includes(error.code))return false;throw error;}
}

/**
 * Repair only the empty-lock remnants of the macOS native-addon packaging bug.
 * No stored history is deleted, replaced, inferred or replayed. Other failures
 * are left to the ordinary startup path, or propagated once recovery is admitted.
 */
export async function recoverPackagedSessions({ctx,rt,home,workspace,env=process.env}) {
  if(env.OPENNOVA_PACKAGED!=='1'||rt.readOnly())return {recovered:0};
  const persistence=ctx.get?.('sessionPersistence');
  const root=join(home,'harness','sessions');
  if(persistence?.name!=='session-persistence-jsonl'||typeof persistence.config?.root!=='string'||resolve(persistence.config.root)!==resolve(root))return {recovered:0};
  // Do not follow a substituted store root into another profile's data.
  try{if(!(await lstat(root)).isDirectory())return {recovered:0};}
  catch(error){if(error.code==='ENOENT')return {recovered:0};throw error;}
  const candidates=[];
  for(const saved of savedSessions(rt.state,workspace)) {
    const directory=sessionDirectory(root,saved.cwd,saved.sessionId);
    if(!await lockOnly(directory)||!await existingFolder(saved.cwd))continue;
    const result=await ctx.sessionController.resolveAgent(saved.sessionId);
    if(!('error' in result))continue; // New live sessions are not damaged sessions.
    if(result.error?.code!=='session/not-found')throw result.error;
    candidates.push({...saved,directory});
  }
  for(const {sessionId,cwd,directory} of candidates) {
    // Recheck after all candidates are admitted; create itself also checks cold
    // storage and acquires Harness's writer lock, never overwriting a raced log.
    if(!await lockOnly(directory))throw Error('session_recovery_evidence_changed');
    const created=await ctx.sessionController.create({sessionId,cwd});
    if(created.sessionId!==sessionId)throw Error('session_recovery_identity_changed');
    const result=await ctx.sessionController.resolveAgent(sessionId);
    if('error' in result)throw result.error;
    if(result.agent.session.header.id!==sessionId||result.agent.session.header.cwd!==cwd)throw Error('session_recovery_identity_changed');
    if(!await ctx.sessions.flush(result.agent.session))throw Error('session_recovery_not_durable');
    const stored=await persistence.stat(sessionId);
    if(stored?.header?.id!==sessionId||stored.header.cwd!==cwd)throw Error('session_recovery_not_durable');
    const logs=(await readdir(directory)).filter(name=>/^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(name));
    if(!logs.length)throw Error('session_recovery_not_durable');
    for(const name of logs){const file=await lstat(join(directory,name));if(!file.isFile()||file.size===0)throw Error('session_recovery_not_durable');}
  }
  if(candidates.length)rt.warn('OpenNova: restored %s empty sessions from the old macOS build; no saved history was available.',candidates.length);
  return {recovered:candidates.length};
}
