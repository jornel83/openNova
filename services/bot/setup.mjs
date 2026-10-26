import {execFileSync} from 'node:child_process';
import {mkdirSync,existsSync,writeFileSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {BOT_REV,HARNESS_REV,botSettings} from './settings.mjs';
import {loadSettings} from '../agent/settings.mjs';

export function setup(source) {
  const settings=botSettings(),{harnessRoot}=loadSettings();
  if(execFileSync('git',['-C',harnessRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==HARNESS_REV)throw Error('harness_revision_mismatch');
  if(!existsSync(join(harnessRoot,'apps/cli/lib/bin.js')))throw Error('harness_build_missing');
  const dest=dirname(settings.plugin),receipt=join(dest,'revision');
  if(existsSync(receipt)&&readFileSync(receipt,'utf8').trim()===BOT_REV)return settings;
  mkdirSync(dest,{recursive:true});
  const checkout=source||join(dirname(dest),'source');
  if(!source&&!existsSync(join(checkout,'.git')))execFileSync('git',['clone','--no-checkout','https://github.com/Fei2411/DeepSeek-Bot.git',checkout],{stdio:'inherit'});
  const archive=execFileSync('git',['-C',checkout,'archive',BOT_REV,'ds-bot'],{maxBuffer:15*1024*1024});
  execFileSync('tar',['-x','-C',dest],{input:archive});
  writeFileSync(receipt,BOT_REV+'\n');
  return settings;
}
if(process.argv[1]===import.meta.filename){const i=process.argv.indexOf('--source');const s=setup(i>=0?process.argv[i+1]:undefined);console.log(`Bot 依赖已准备：${BOT_REV.slice(0,7)}；${s.plugin}`);}
