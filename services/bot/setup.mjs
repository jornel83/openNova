/** Validate included source and build without downloading or inspecting Git HEAD. */
import {botSettings} from './settings.mjs';
import {requireBuiltHarness} from '../runtime/sources.mjs';
export function setup() {requireBuiltHarness();return botSettings();}
if(process.argv[1]===import.meta.filename){
  try {const settings=setup();console.log(`OpenNova bundled Bot ready: ${settings.plugin}`);}
  catch(error){console.error(error.message);process.exitCode=1;}
}
