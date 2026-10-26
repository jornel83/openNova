import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadSettings} from '../settings.mjs';
import {ROOT} from '../../runtime/sources.mjs';

test('machine config supplies paths; environment wins; empty fields keep defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opennova-config-'));
  try {
    const file = join(dir, 'voice.local.json');
    writeFileSync(file, JSON.stringify({agent:{harness_root:'/tmp/harness', siwc_root:''}}));
    assert.equal(loadSettings({}, file).harnessRoot, join(ROOT,'engine/harness'));
    assert.equal(loadSettings({}, file).siwcRoot, join(ROOT,'engine/siwc'));
    assert.equal(loadSettings({OPENNOVA_HARNESS_ROOT:'/other'}, file).harnessRoot, join(ROOT,'engine/harness'));
    writeFileSync(file, 'private-invalid-json');
    assert.throws(() => loadSettings({}, file), /^Error: invalid_agent_configuration$/);
  } finally { rmSync(dir, {recursive:true}); }
});
