/** Freeze project-local experiment files from a single regular-file descriptor. */
import {createHash} from 'node:crypto';
import {constants,closeSync,fstatSync,openSync,readSync,realpathSync,statSync} from 'node:fs';
import {open,realpath,stat as diskStat} from 'node:fs/promises';
import {basename,extname,isAbsolute,relative,resolve,sep} from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const textExtensions = new Set(['.txt','.md','.csv','.tsv','.json','.jsonl','.yaml','.yml','.toml','.log']);
const protectedName = name => name.startsWith('.') || /^(?:secrets?|credentials?)(?:\.|$)|\.local\.json$|\.(?:pem|p12|key)$/i.test(name);
const sameFile = (before, after) => after && ['dev','ino','size','mtimeMs','ctimeMs'].every(key => before[key] === after[key]);
const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function insideProject(root,base,name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 1000 || name.includes('\0'))
    throw Error('invalid_experiment_path');
  const path = resolve(base, name), local = relative(root, path);
  if (!local || isAbsolute(local) || local.split(sep).some(part => part === '..' || protectedName(part)))
    throw Error('invalid_experiment_path');
  return {path,local};
}

export function projectFile(workspace, base, name, maxBytes) {
  const {path,local}=insideProject(workspace,base,name);
  if (realpathSync(path) !== path) throw Error('invalid_experiment_path');
  const fd = openSync(path, flags);
  try {
    const stat = fstatSync(fd);
    if (stat.size > maxBytes) throw Error('experiment_snapshot_too_large_use_reference');
    if (!stat.isFile() || stat.nlink !== 1 || !stat.size)
      throw Error('invalid_experiment_file');
    const bytes = Buffer.alloc(stat.size);
    for (let offset = 0; offset < bytes.length;) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw Error('experiment_file_changed');
      offset += count;
    }
    if (realpathSync(path) !== path || !sameFile(stat, statSync(path))) throw Error('experiment_file_changed');
    return {bytes, localPath:local, path};
  } finally { closeSync(fd); }
}

/** Bound memory and yield to the event loop between reads even for multi-GB checkpoints. */
async function referenceEvidence(workspace,base,{role,path:name},signal,expectedSize) {
  const {path,local}=insideProject(workspace,base,name);
  if (await realpath(path)!==path) throw Error('invalid_experiment_path');
  signal?.throwIfAborted();
  const handle=await open(path,flags);
  try {
    const before=await handle.stat();
    if (!before.isFile() || before.nlink!==1 || !before.size) throw Error('invalid_experiment_file');
    if (expectedSize!==undefined && before.size!==expectedSize) throw Error('experiment_file_changed');
    const hash=createHash('sha256'), block=Buffer.allocUnsafe(Math.min(before.size,256*1024));
    for (let offset=0;offset<before.size;) {
      signal?.throwIfAborted();
      const {bytesRead}=await handle.read(block,0,Math.min(block.length,before.size-offset),offset);
      if (!bytesRead) throw Error('experiment_file_changed');
      hash.update(block.subarray(0,bytesRead));offset+=bytesRead;
    }
    if (await realpath(path)!==path || !sameFile(before,await diskStat(path))) throw Error('experiment_file_changed');
    const version=Object.fromEntries(['dev','ino','size','mtimeMs','ctimeMs'].map(key=>[key,before[key]]));
    return {descriptor:{role,path:local,name:basename(path),location:path,mode:'reference',sha256:hash.digest('hex'),size:before.size,version}};
  } finally {await handle.close();}
}

export async function sourceStatus(workspace,recordedRoot,file,signal) {
  try {
    const root=await realpath(workspace);
    if (recordedRoot && root!==recordedRoot) return {state:'workspace_changed'};
    const {path}=insideProject(root,root,file.path);
    if (file.location && path!==file.location || await realpath(path)!==path) return {state:'changed'};
    const info=await diskStat(path);
    if (!info.isFile() || info.nlink!==1 || info.size!==file.size) return {state:'changed',location:path};
    if (file.mode==='reference') return {state:sameFile(file.version,info)?'version_matches':'changed',location:path};
    // Older snapshots have no saved inode. Their content hash still identifies the exact bytes.
    const current=await referenceEvidence(root,root,file,signal,file.size);
    return {state:current.descriptor.sha256===file.sha256?'content_matches':'changed',location:path};
  } catch(error) {
    signal?.throwIfAborted();
    return {state:['ENOENT','ENOTDIR'].includes(error.code)?'missing':'unavailable'};
  }
}

// Read lengths from RIFF chunks. Ancillary metadata and padding can precede data.
function waveInfo(bytes) {
  if (bytes.length < 44 || bytes.toString('ascii',0,4) !== 'RIFF' ||
      bytes.toString('ascii',8,12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length)
    throw Error('invalid_experiment_wave');
  let sampleRate, channels, alignment, dataSize;
  for (let pos = 12; pos < bytes.length;) {
    if (pos + 8 > bytes.length) throw Error('invalid_experiment_wave');
    const name = bytes.toString('ascii',pos,pos+4), size = bytes.readUInt32LE(pos+4), start = pos+8;
    if (start + size > bytes.length) throw Error('invalid_experiment_wave');
    if (name === 'fmt ') {
      if (size < 16 || sampleRate || bytes.readUInt16LE(start) !== 1) throw Error('invalid_experiment_wave');
      channels = bytes.readUInt16LE(start+2);
      sampleRate = bytes.readUInt32LE(start+4);
      alignment = bytes.readUInt16LE(start+12);
      const bits = bytes.readUInt16LE(start+14);
      if (!channels || !sampleRate || ![8,16,24,32].includes(bits) ||
          alignment !== channels * bits / 8 || bytes.readUInt32LE(start+8) !== alignment * sampleRate)
        throw Error('invalid_experiment_wave');
    }
    if (name === 'data') {
      if (dataSize !== undefined) throw Error('invalid_experiment_wave');
      dataSize = size;
    }
    pos = start + size + size % 2;
  }
  if (!alignment || !dataSize || dataSize % alignment) throw Error('invalid_experiment_wave');
  return {durationSeconds:Number((dataSize / alignment / sampleRate).toFixed(3)), sampleRate, channels};
}

export function captureEvidence(workspace, base, entry,signal) {
  const {role,path} = entry ?? {};
  if (!['data','config','log','sample','model','artifact'].includes(role)) throw Error('invalid_experiment_file_role');
  if (entry.mode==='reference') return referenceEvidence(workspace,base,entry,signal);
  if (entry.mode!==undefined && entry.mode!=='snapshot') throw Error('invalid_experiment_storage_mode');
  const file = projectFile(workspace, base, path, role === 'sample' || role === 'artifact' || role === 'model' ? 8*1024*1024 : 256*1024);
  const extension = extname(file.localPath).toLowerCase(), sha = sha256(file.bytes);
  const descriptor = {role,path:file.localPath,name:basename(file.path),sha256:sha,size:file.bytes.length,
    contentType:'application/octet-stream'};
  if (extension === '.wav') {
    descriptor.contentType = 'audio/wav';
    descriptor.audio = waveInfo(file.bytes);
  } else if (role === 'sample') {
    const types = {'.mp3':'audio/mpeg','.m4a':'audio/mp4','.ogg':'audio/ogg','.flac':'audio/flac'};
    if (!types[extension]) throw Error('unsupported_experiment_sample');
    descriptor.contentType = types[extension];
  } else if (textExtensions.has(extension)) {
    descriptor.contentType = 'text/plain; charset=utf-8';
    descriptor.preview = file.bytes.toString('utf8',0,1200);
    if (extension === '.json' && role === 'config') {
      try {
        const config = JSON.parse(file.bytes);
        if (config && typeof config === 'object' && !Array.isArray(config))
          descriptor.settings = Object.fromEntries(Object.entries(config).filter(([,value]) =>
            value === null || typeof value === 'boolean' || typeof value === 'number' ||
            (typeof value === 'string' && value.length <= 200)).slice(0,50));
      } catch { /* Free-form configurations remain available as evidence. */ }
    }
  }
  return {descriptor, bytes:file.bytes};
}
