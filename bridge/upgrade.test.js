import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { older, outdatedPlugin } from './upgrade.js';

test('versions compare numerically', () => {
  assert.ok(older('0.4.2', '0.5.0') && older('0.5', '0.5.1') && !older('0.10.0', '0.5.0') && !older('0.5.0', '0.5.0'));
});

test('a plugin older than the first keyed one is reported, a current or missing one is not', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-upgrade-'));
  try {
    assert.equal(outdatedPlugin(home), null);
    const file = path.join(home, '.claude/plugins/installed_plugins.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const write = version => fs.writeFileSync(file, JSON.stringify({ plugins: { 'agent-office@agent-office': [{ version }] } }));
    write('0.4.2'); assert.equal(outdatedPlugin(home), '0.4.2');
    write('0.5.0'); assert.equal(outdatedPlugin(home), null);
    fs.writeFileSync(file, '{ not json'); assert.equal(outdatedPlugin(home), null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
