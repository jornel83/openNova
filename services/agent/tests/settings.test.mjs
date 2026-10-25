import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadSettings} from '../settings.mjs';

test('machine config supplies paths; environment wins; empty fields keep defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opennova-config-'));
  try {
    const file = join(dir, 'voice.local.json');
    writeFileSync(file, JSON.stringify({agent:{harness_root:'/tmp/harness', siwc_root:''}}));
    assert.equal(loadSettings({}, file).harnessRoot, '/tmp/harness');
    assert.match(loadSettings({}, file).siwcRoot, /opennova\/siwc-devkit$/);
    assert.equal(loadSettings({OPENNOVA_HARNESS_ROOT:'/other'}, file).harnessRoot, '/other');
    writeFileSync(file, 'private-invalid-json');
    assert.throws(() => loadSettings({}, file), /^Error: invalid_agent_configuration$/);
  } finally { rmSync(dir, {recursive:true}); }
});

 test('default Harness is the pinned submodule, independent of the caller directory', () => {
  const expected=fileURLToPath(new URL('../../../third_party/deepseek-harness',import.meta.url));
  assert.equal(loadSettings({}, '/does-not-exist/opennova.json').harnessRoot,expected);
 });
