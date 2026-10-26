#!/usr/bin/env node
/** Default regression lane: local fixtures only; never starts account authorization. */
import {globSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,dirname} from 'node:path';
import {ROOT,requireBuiltHarness} from '../services/runtime/sources.mjs';

try {
  if(process.argv.length>2)throw Error('Use pnpm test without arguments; run a test file directly for focused checks.');
  requireBuiltHarness();
  const env={...process.env,PATH:dirname(process.execPath)+':'+(process.env.PATH||'')};
  const python=process.env.OPENNOVA_PYTHON||'python3.11';
  const groups=['services/agent/tests','services/bot/tests','tools/voice/tests','scripts/tests'];
  const files=groups.flatMap(dir=>[...globSync('*.test.mjs',{cwd:join(ROOT,dir)})].sort().map(file=>join(ROOT,dir,file)));
  const runs=[[process.execPath,['--test',...files]],...['tools/asr/tests','tools/voice/tests','services/tts/tests','tools/setup/tests','tools/video/tests']
    .map(dir=>[python,['-m','unittest','discover','-s',dir,'-v']])];
  for(const [command,args] of runs) {
    const result=spawnSync(command,args,{cwd:ROOT,env,stdio:'inherit'});
    if(result.error)throw result.error;
    if(result.status!==0)throw Error(`${command} tests failed (${result.signal||result.status})`);
  }
}catch(error){console.error(error.message);process.exitCode=1;}
