import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStartArgs} from '../start-options.mjs';
test('Bot startup defaults to UI, while inspection and explicit headless do not open it',()=>{
 assert.equal(parseStartArgs([]).ui,true);
 for(const args of [['--no-ui'],['--check'],['--stop'],['--help'],['--ui','--no-ui']])assert.equal(parseStartArgs(args).ui,false);
 assert.equal(parseStartArgs(['--no-ui','--ui']).ui,true);
 assert.equal(parseStartArgs(['--desktop']).desktop,true);
 assert.throws(()=>parseStartArgs(['--unknown']),/unknown_option/);
});
